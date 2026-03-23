import type { AuthManagerLeasePluginConfig } from './types.js'

const DEFAULT_FLUSH_INTERVAL_MS = 60_000
const DEFAULT_FLUSH_EVERY_REQUESTS = 10

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false
  }
  return fallback
}

export function resolvePluginConfig(
  rawConfig: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AuthManagerLeasePluginConfig {
  const baseUrl = asString(rawConfig?.baseUrl) ?? asString(env.AUTH_MANAGER_BASE_URL) ?? ''
  const apiKey = asString(rawConfig?.apiKey) ?? asString(env.AUTH_MANAGER_API_KEY) ?? ''
  const machineId = asString(rawConfig?.machineId) ?? asString(env.AUTH_MANAGER_MACHINE_ID) ?? ''
  const agentId = asString(rawConfig?.agentId) ?? asString(env.AUTH_MANAGER_AGENT_ID) ?? 'openclaw'
  const leaseId = asString(rawConfig?.leaseId) ?? asString(env.AUTH_MANAGER_LEASE_ID)
  const flushIntervalMs = Math.max(
    1_000,
    asNumber(rawConfig?.flushIntervalMs ?? env.AUTH_MANAGER_TELEMETRY_INTERVAL_MS, DEFAULT_FLUSH_INTERVAL_MS),
  )
  const flushEveryRequests = Math.max(
    1,
    Math.trunc(
      asNumber(rawConfig?.flushEveryRequests ?? env.AUTH_MANAGER_TELEMETRY_FLUSH_EVERY, DEFAULT_FLUSH_EVERY_REQUESTS),
    ),
  )
  const enabled = asBoolean(rawConfig?.enabled ?? env.AUTH_MANAGER_TELEMETRY_ENABLED, true)

  return {
    baseUrl,
    apiKey,
    machineId,
    agentId,
    leaseId,
    flushIntervalMs,
    flushEveryRequests,
    enabled,
  }
}

export function validatePluginConfig(config: AuthManagerLeasePluginConfig): string[] {
  const errors: string[] = []
  if (!config.baseUrl) errors.push('baseUrl is required')
  if (!config.apiKey) errors.push('apiKey is required')
  if (!config.machineId) errors.push('machineId is required')
  if (!config.agentId) errors.push('agentId is required')
  if (config.flushIntervalMs < 1_000) errors.push('flushIntervalMs must be at least 1000')
  if (config.flushEveryRequests < 1) errors.push('flushEveryRequests must be at least 1')
  return errors
}
