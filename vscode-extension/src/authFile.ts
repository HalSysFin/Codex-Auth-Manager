import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AuthPayload } from './authManagerClient'

export function expandHomePath(rawPath: string): string {
  if (!rawPath.startsWith('~')) {
    return path.resolve(rawPath)
  }
  return path.resolve(path.join(os.homedir(), rawPath.slice(1)))
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

export async function authFileExists(authFilePath: string): Promise<boolean> {
  try {
    await fs.access(expandHomePath(authFilePath))
    return true
  } catch {
    return false
  }
}

export async function readAuthFile(authFilePath: string): Promise<AuthPayload | null> {
  const fullPath = expandHomePath(authFilePath)
  try {
    const content = await fs.readFile(fullPath, 'utf8')
    const parsed = JSON.parse(content)
    return validateAuthPayload(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function writeAuthFile(authFilePath: string, payload: AuthPayload): Promise<{ path: string; writtenAt: string }> {
  if (!validateAuthPayload(payload)) {
    throw new Error('Invalid auth payload shape')
  }
  const fullPath = expandHomePath(authFilePath)
  const dir = path.dirname(fullPath)
  const writtenAt = new Date().toISOString()
  const finalPayload: AuthPayload = {
    ...payload,
    last_refresh: payload.last_refresh || writtenAt,
  }
  const tempPath = `${fullPath}.tmp-${process.pid}-${Date.now()}`
  await fs.mkdir(dir, { recursive: true })
  const fileHandle = await fs.open(tempPath, 'w')
  try {
    await fileHandle.writeFile(`${JSON.stringify(finalPayload, null, 2)}\n`, 'utf8')
    await fileHandle.sync()
  } finally {
    await fileHandle.close()
  }
  await fs.rename(tempPath, fullPath)
  return { path: fullPath, writtenAt }
}
