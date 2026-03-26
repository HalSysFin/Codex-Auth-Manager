import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import type { AuthPayload, OpenClawMaterial } from './types.js'

export function expandHomePath(rawPath: string): string {
  if (!rawPath.startsWith('~')) {
    return path.resolve(rawPath)
  }
  const homeDir = os.homedir().replace(/[\\/]+$/, '')
  const trimmedPath = rawPath.slice(1).replace(/^[/\\]+/, '')
  return path.resolve(`${homeDir}/${trimmedPath}`.replace(/\\/g, '/'))
}

async function atomicWriteJson(fullPath: string, content: unknown): Promise<void> {
  const dir = path.dirname(fullPath)
  const tempPath = `${fullPath}.tmp-${process.pid}-${Date.now()}`
  await fs.mkdir(dir, { recursive: true })
  const fileHandle = await fs.open(tempPath, 'w')
  try {
    await fileHandle.writeFile(`${JSON.stringify(content, null, 2)}\n`, 'utf8')
    await fileHandle.sync()
  } finally {
    await fileHandle.close()
  }
  await fs.rename(tempPath, fullPath)
}

export async function applyLeaseAuthToOpenClaw(options: {
  material: OpenClawMaterial
  authPayload?: AuthPayload | null
  leaseProfileId: string
  agentId?: string
}): Promise<void> {
  const authJsonPath = expandHomePath('~/.openclaw/auth.json')
  const incomingProfileId = normalizeNonEmptyString(options.material.profile_id) ?? 'openai-codex:lease'
  const targetProfileId = normalizeNonEmptyString(options.leaseProfileId) ?? incomingProfileId
  const synthesizedMaterial =
    options.material.openclaw_auth_json ?? buildOpenClawAuthJsonFromAuthPayload(options.authPayload, incomingProfileId)
  const leaseAuthJson = remapOpenClawAuthJson(synthesizedMaterial, incomingProfileId, targetProfileId)
  const existing = await readJsonOrDefault<Record<string, unknown>>(authJsonPath, {})
  const merged = mergeOpenClawAuthJson(existing, leaseAuthJson, targetProfileId)
  await atomicWriteJson(authJsonPath, merged)
  await writeCompatibilityAuthStores({
    authPayload: options.authPayload,
    leaseAuthJson: merged,
    leaseProfileId: targetProfileId,
    agentId: normalizeNonEmptyString(options.agentId) ?? 'main',
  })
}

async function readJsonOrDefault<T>(fullPath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(fullPath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function remapOpenClawAuthJson(
  raw: Record<string, unknown> | null | undefined,
  fromId: string,
  toId: string,
): Record<string, unknown> {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
  const authOrder = record['auth.order.openai-codex']
  const rawTokens = record.openai_cid_tokens
  const tokens = rawTokens && typeof rawTokens === 'object' && !Array.isArray(rawTokens)
    ? { ...(rawTokens as Record<string, unknown>) }
    : {}
  const sourceToken = tokens[fromId] ?? Object.values(tokens)[0]
  if (!sourceToken || typeof sourceToken !== 'object' || Array.isArray(sourceToken)) {
    throw new Error('Lease materialization did not return a valid OpenClaw auth.json payload')
  }

  const profileKey = `auth.profiles.${toId}`
  const sourceProfileKey = `auth.profiles.${fromId}`
  const sourceProfile = record[sourceProfileKey] ?? {
    provider: 'openai-codex',
    mode: 'oauth',
  }

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === 'auth.order.openai-codex') continue
    if (key.startsWith('auth.profiles.openai-codex:')) continue
    if (key === 'openai_cid_tokens') continue
    out[key] = value
  }
  out['auth.order.openai-codex'] = Array.isArray(authOrder) && authOrder.length ? [toId] : [toId]
  out[profileKey] = sourceProfile
  out.openai_cid_tokens = {
    [toId]: sourceToken,
  }
  return out
}

function buildOpenClawAuthJsonFromAuthPayload(
  authPayload: AuthPayload | null | undefined,
  profileId: string,
): Record<string, unknown> {
  const tokenSource = extractAuthPayloadTokenSource(authPayload)
  const accessToken =
    normalizeTokenValue(tokenSource.access_token) ??
    normalizeTokenValue(tokenSource.accessToken)
  const refreshToken =
    normalizeTokenValue(tokenSource.refresh_token) ??
    normalizeTokenValue(tokenSource.refreshToken)
  const accountId =
    normalizeTokenValue(tokenSource.account_id) ??
    normalizeTokenValue(tokenSource.accountId)
  if (!accessToken || !refreshToken || !accountId) {
    const topLevelKeys = authPayload && typeof authPayload === 'object' ? Object.keys(authPayload).sort() : []
    const tokenKeys = authPayload?.tokens && typeof authPayload.tokens === 'object' ? Object.keys(authPayload.tokens).sort() : []
    throw new Error(
      `Lease materialization did not return a valid OpenClaw auth.json payload (auth_json keys: ${topLevelKeys.join(',') || 'none'}; token keys: ${tokenKeys.join(',') || 'none'})`,
    )
  }
  const idToken =
    normalizeTokenValue(tokenSource.id_token) ??
    normalizeTokenValue(tokenSource.idToken)
  const accessClaims = decodeJwtPayload(accessToken) ?? {}
  const expiresAtMs = deriveExpiryMs({}, authPayload)
  return {
    "auth.order.openai-codex": [profileId],
    [`auth.profiles.${profileId}`]: {
      provider: 'openai-codex',
      mode: 'oauth',
    },
    openai_cid_tokens: {
      [profileId]: {
        access_token: accessToken,
        refresh_token: refreshToken,
        id_token: idToken,
        expires_at_ms: expiresAtMs,
        accountId,
        provider: 'openai-codex',
        type: 'oauth',
        decoded_access_jwt: {
          header: decodeJwtHeader(accessToken),
          payload: accessClaims,
        },
        ...(jwtEmail(accessClaims) ? { email: jwtEmail(accessClaims) } : {}),
      },
    },
  }
}

function extractAuthPayloadTokenSource(authPayload: AuthPayload | null | undefined): Record<string, unknown> {
  if (!authPayload || typeof authPayload !== 'object') {
    return {}
  }
  const nested =
    authPayload.tokens && typeof authPayload.tokens === 'object' && !Array.isArray(authPayload.tokens)
      ? (authPayload.tokens as Record<string, unknown>)
      : {}
  const topLevel = authPayload as unknown as Record<string, unknown>
  return {
    ...topLevel,
    ...nested,
  }
}

function mergeOpenClawAuthJson(
  existing: Record<string, unknown>,
  leaseAuthJson: Record<string, unknown>,
  targetProfileId: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(existing)) {
    if (key === 'auth.order.openai-codex') continue
    if (key.startsWith('auth.profiles.openai-codex:')) continue
    if (key === 'openai_cid_tokens') continue
    out[key] = value
  }
  for (const [key, value] of Object.entries(leaseAuthJson)) {
    out[key] = value
  }
  out['auth.order.openai-codex'] = [targetProfileId]
  const profileKey = `auth.profiles.${targetProfileId}`
  if (!out[profileKey]) {
    out[profileKey] = { provider: 'openai-codex', mode: 'oauth' }
  }
  if (!out.openai_cid_tokens || typeof out.openai_cid_tokens !== 'object' || Array.isArray(out.openai_cid_tokens)) {
    out.openai_cid_tokens = {}
  }
  out.openai_cid_tokens = {
    [targetProfileId]: (out.openai_cid_tokens as Record<string, unknown>)[targetProfileId],
  }
  return out
}

async function writeCompatibilityAuthStores(options: {
  authPayload?: AuthPayload | null
  leaseAuthJson: Record<string, unknown>
  leaseProfileId: string
  agentId: string
}): Promise<void> {
  const authStorePath = expandHomePath(`~/.openclaw/agents/${options.agentId}/agent/auth-profiles.json`)
  const oauthImportPath = expandHomePath('~/.openclaw/credentials/oauth.json')
  const tokenRecord = extractLeaseTokenRecord(options.leaseAuthJson, options.leaseProfileId)
  const accessToken = normalizeTokenValue(tokenRecord.access_token)
  const refreshToken = normalizeTokenValue(tokenRecord.refresh_token)
  const accountId =
    normalizeTokenValue(tokenRecord.accountId) ||
    normalizeTokenValue(tokenRecord.account_id) ||
    normalizeTokenValue(options.authPayload?.tokens?.account_id)

  if (!accessToken || !refreshToken || !accountId) {
    throw new Error('Lease materialization did not include enough token data for OpenClaw compatibility stores')
  }

  const email = deriveEmail(tokenRecord, options.authPayload)
  const expiresAtMs = deriveExpiryMs(tokenRecord, options.authPayload)

  const existingAuthStore = await readJsonOrDefault<Record<string, unknown>>(authStorePath, {})
  const authProfiles = (
    existingAuthStore.profiles &&
    typeof existingAuthStore.profiles === 'object' &&
    !Array.isArray(existingAuthStore.profiles)
  ) ? { ...(existingAuthStore.profiles as Record<string, unknown>) } : {}
  authProfiles[options.leaseProfileId] = {
    type: 'oauth',
    provider: 'openai-codex',
    access: accessToken,
    refresh: refreshToken,
    expires: expiresAtMs,
    accountId,
    ...(email ? { email } : {}),
  }
  const authStore = {
    ...existingAuthStore,
    version: typeof existingAuthStore.version === 'number' ? existingAuthStore.version : 1,
    profiles: authProfiles,
    lastGood: {
      ...(
        existingAuthStore.lastGood &&
        typeof existingAuthStore.lastGood === 'object' &&
        !Array.isArray(existingAuthStore.lastGood)
          ? existingAuthStore.lastGood as Record<string, unknown>
          : {}
      ),
      'openai-codex': options.leaseProfileId,
    },
  }
  await atomicWriteJson(authStorePath, authStore)

  const existingOauthImport = await readJsonOrDefault<Record<string, unknown>>(oauthImportPath, {})
  const oauthImport = {
    ...existingOauthImport,
    'openai-codex': {
      access: accessToken,
      refresh: refreshToken,
      expires: expiresAtMs,
      accountId,
      ...(email ? { email } : {}),
    },
  }
  await atomicWriteJson(oauthImportPath, oauthImport)
}

function extractLeaseTokenRecord(
  authJson: Record<string, unknown>,
  leaseProfileId: string,
): Record<string, unknown> {
  const tokens =
    authJson.openai_cid_tokens &&
    typeof authJson.openai_cid_tokens === 'object' &&
    !Array.isArray(authJson.openai_cid_tokens)
      ? authJson.openai_cid_tokens as Record<string, unknown>
      : {}
  const selected = tokens[leaseProfileId]
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
    throw new Error('Lease materialization did not include the active OpenClaw profile token payload')
  }
  return selected as Record<string, unknown>
}

function normalizeTokenValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function deriveEmail(tokenRecord: Record<string, unknown>, authPayload?: AuthPayload | null): string | null {
  const direct = normalizeTokenValue(tokenRecord.email)
  if (direct) return direct
  const decodedAccess = decodeJwtPayload(normalizeTokenValue(tokenRecord.access_token))
  const accessEmail = jwtEmail(decodedAccess)
  if (accessEmail) return accessEmail
  const decodedId = decodeJwtPayload(normalizeTokenValue(tokenRecord.id_token) || authPayload?.tokens?.id_token || null)
  return jwtEmail(decodedId)
}

function deriveExpiryMs(tokenRecord: Record<string, unknown>, authPayload?: AuthPayload | null): number {
  const direct = tokenRecord.expires_at_ms
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return Math.trunc(direct)
  const decodedAccess = decodeJwtPayload(normalizeTokenValue(tokenRecord.access_token))
  if (typeof decodedAccess?.exp === 'number' && Number.isFinite(decodedAccess.exp) && decodedAccess.exp > 0) {
    return Math.trunc(decodedAccess.exp * 1000)
  }
  const decodedId = decodeJwtPayload(normalizeTokenValue(tokenRecord.id_token) || authPayload?.tokens?.id_token || null)
  if (typeof decodedId?.exp === 'number' && Number.isFinite(decodedId.exp) && decodedId.exp > 0) {
    return Math.trunc(decodedId.exp * 1000)
  }
  return 0
}

function decodeJwtPayload(token: string | null): Record<string, unknown> | null {
  return decodeJwtSegment(token, 1)
}

function decodeJwtHeader(token: string | null): Record<string, unknown> | null {
  return decodeJwtSegment(token, 0)
}

function decodeJwtSegment(token: string | null, index: number): Record<string, unknown> | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length <= index) return null
  try {
    const segment = parts[index]
    const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4)
    const decoded = Buffer.from(padded, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function jwtEmail(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null
  const direct = normalizeTokenValue(payload.email)
  if (direct) return direct
  const profile =
    payload['https://api.openai.com/profile'] &&
    typeof payload['https://api.openai.com/profile'] === 'object' &&
    !Array.isArray(payload['https://api.openai.com/profile'])
      ? payload['https://api.openai.com/profile'] as Record<string, unknown>
      : null
  return normalizeTokenValue(profile?.email)
}
