import type { AuthPayload } from './types.js'

async function digestSha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

export function validateAuthPayload(payload: unknown): payload is AuthPayload {
  if (!payload || typeof payload !== 'object') {
    return false
  }
  const record = payload as Record<string, unknown>
  if (typeof record.auth_mode !== 'string') {
    return false
  }
  if (record.OPENAI_API_KEY !== null) {
    return false
  }
  const tokens = record.tokens
  if (!tokens || typeof tokens !== 'object') {
    return false
  }
  const tokenRecord = tokens as Record<string, unknown>
  return ['id_token', 'access_token', 'refresh_token', 'account_id'].every((key) => typeof tokenRecord[key] === 'string')
}

export function expandHomePath(rawPath: string, homeDir: string): string {
  if (!rawPath.startsWith('~')) {
    return rawPath
  }
  const trimmedHome = homeDir.replace(/[\\/]+$/, '')
  const trimmedPath = rawPath.slice(1).replace(/^[/\\]+/, '')
  return `${trimmedHome}/${trimmedPath}`.replace(/\\/g, '/')
}

export function prepareAuthPayloadForWrite(payload: AuthPayload, nowIso = new Date().toISOString()): AuthPayload {
  if (!validateAuthPayload(payload)) {
    throw new Error('Invalid auth payload shape')
  }
  return {
    ...payload,
    last_refresh: payload.last_refresh || nowIso,
  }
}

function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (typeof token !== 'string' || !token.trim()) {
    return null
  }
  const parts = token.split('.')
  if (parts.length < 2) {
    return null
  }
  const payload = parts[1]
  if (!payload) {
    return null
  }
  const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=')
  try {
    const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
    const parsed = JSON.parse(decoded)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function claimString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function nestedAuthClaim(record: Record<string, unknown> | null, key: string): string | null {
  const auth = record?.['https://api.openai.com/auth']
  if (!auth || typeof auth !== 'object') {
    return null
  }
  return claimString(auth as Record<string, unknown>, key)
}

export function extractAuthPayloadIdentity(payload: AuthPayload): {
  accountKey: string | null
  subject: string | null
  userId: string | null
  accountId: string | null
  email: string | null
  name: string | null
} {
  const idClaims = decodeJwtPayload(payload.tokens.id_token)
  const accessClaims = decodeJwtPayload(payload.tokens.access_token)
  const subject = claimString(idClaims, 'sub') || claimString(accessClaims, 'sub')
  const userId =
    nestedAuthClaim(idClaims, 'user_id') ||
    nestedAuthClaim(idClaims, 'chatgpt_user_id') ||
    nestedAuthClaim(accessClaims, 'user_id') ||
    nestedAuthClaim(accessClaims, 'chatgpt_user_id')
  const accountId =
    nestedAuthClaim(idClaims, 'chatgpt_account_id') ||
    nestedAuthClaim(accessClaims, 'chatgpt_account_id') ||
    payload.tokens.account_id ||
    null
  const email = claimString(idClaims, 'email') || claimString(accessClaims, 'email') || null
  const name = claimString(idClaims, 'name') || claimString(accessClaims, 'name') || null

  let accountKey: string | null = null
  if (subject) {
    accountKey = `sub:${subject}`
  } else if (userId) {
    accountKey = `uid:${userId}`
  } else if (accountId && email) {
    accountKey = `acct:${accountId}:${email.toLowerCase()}`
  } else if (email) {
    accountKey = `email:${email.toLowerCase()}`
  } else if (accountId) {
    accountKey = `acct:${accountId}`
  }

  return {
    accountKey,
    subject,
    userId,
    accountId,
    email: email?.toLowerCase() || null,
    name,
  }
}

function jwtNumericClaim(token: string | null | undefined, claim: 'iat' | 'exp'): number {
  const payload = decodeJwtPayload(token)
  const value = payload?.[claim]
  return typeof value === 'number' ? value : 0
}

export function authPayloadFreshnessTuple(payload: AuthPayload | null | undefined): [number, number, number] {
  if (!payload) {
    return [0, 0, 0]
  }
  const lastRefresh = typeof payload.last_refresh === 'string' && payload.last_refresh.trim()
    ? Date.parse(payload.last_refresh)
    : 0
  const iat = jwtNumericClaim(payload.tokens.access_token, 'iat')
  const exp = jwtNumericClaim(payload.tokens.access_token, 'exp')
  return [Number.isFinite(lastRefresh) ? lastRefresh : 0, iat, exp]
}

export function compareAuthPayloadFreshness(current: AuthPayload | null | undefined, incoming: AuthPayload | null | undefined): number {
  if (!current && !incoming) {
    return 0
  }
  if (!current) {
    return 1
  }
  if (!incoming) {
    return -1
  }
  const currentTuple = authPayloadFreshnessTuple(current)
  const incomingTuple = authPayloadFreshnessTuple(incoming)
  if (incomingTuple[0] > currentTuple[0] || (incomingTuple[0] === currentTuple[0] && (incomingTuple[1] > currentTuple[1] || (incomingTuple[1] === currentTuple[1] && incomingTuple[2] > currentTuple[2])))) {
    return 1
  }
  if (incomingTuple[0] < currentTuple[0] || (incomingTuple[0] === currentTuple[0] && (incomingTuple[1] < currentTuple[1] || (incomingTuple[1] === currentTuple[1] && incomingTuple[2] < currentTuple[2])))) {
    return -1
  }
  const currentToken = current.tokens.access_token || ''
  const incomingToken = incoming.tokens.access_token || ''
  if (currentToken === incomingToken) {
    return 0
  }
  if (incomingToken.length > currentToken.length) {
    return 1
  }
  if (incomingToken.length < currentToken.length) {
    return -1
  }
  return 1
}

export async function authPayloadFingerprint(payload: AuthPayload): Promise<string> {
  const prepared = prepareAuthPayloadForWrite(payload, payload.last_refresh || new Date(0).toISOString())
  return digestSha256Hex(JSON.stringify(prepared))
}
