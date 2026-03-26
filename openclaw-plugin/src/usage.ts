import type { NormalizedUsageEvent, UsageShape } from './types.js'

function toInt(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null
  }
  return null
}

function toFloat(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function firstPresent(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] != null) {
      return source[key]
    }
  }
  return null
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function cloneJsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}

export function normalizeUsageEvent(raw: UsageShape): NormalizedUsageEvent {
  const usage = safeObject(raw.usage)
  const metrics = safeObject(raw.metrics)

  let tokensIn =
    toInt(firstPresent(raw, ['tokens_in', 'prompt_tokens', 'input_tokens', 'input'])) ??
    toInt(firstPresent(usage, ['prompt_tokens', 'input_tokens', 'input'])) ??
    toInt(firstPresent(metrics, ['prompt_tokens', 'input_tokens', 'input']))

  let tokensOut =
    toInt(firstPresent(raw, ['tokens_out', 'completion_tokens', 'output_tokens', 'output'])) ??
    toInt(firstPresent(usage, ['completion_tokens', 'output_tokens', 'output'])) ??
    toInt(firstPresent(metrics, ['completion_tokens', 'output_tokens', 'output']))

  const totalTokens =
    toInt(firstPresent(raw, ['total_tokens', 'total'])) ??
    toInt(firstPresent(usage, ['total_tokens', 'total'])) ??
    toInt(firstPresent(metrics, ['total_tokens', 'total']))

  if (tokensIn == null && totalTokens != null && tokensOut != null) {
    tokensIn = Math.max(totalTokens - tokensOut, 0)
  }
  if (tokensOut == null && totalTokens != null && tokensIn != null) {
    tokensOut = Math.max(totalTokens - tokensIn, 0)
  }

  let requestsCount =
    toInt(firstPresent(raw, ['requests_count', 'request_count'])) ??
    toInt(firstPresent(metrics, ['requests_count', 'request_count']))
  if (requestsCount == null && (tokensIn != null || tokensOut != null || totalTokens != null)) {
    requestsCount = 1
  }

  const metadata: Record<string, unknown> = {}
  const model = firstPresent(raw, ['model'])
  if (typeof model === 'string' && model.trim()) metadata.model = model.trim()
  const source = firstPresent(raw, ['source'])
  if (typeof source === 'string' && source.trim()) metadata.source = source.trim()
  if (totalTokens != null) metadata.total_tokens = totalTokens
  if (Object.keys(usage).length) metadata.usage_keys = Object.keys(usage).sort()
  const clonedRaw = cloneJsonSafe(raw)
  if (clonedRaw && typeof clonedRaw === 'object') metadata.openclaw_usage_raw = clonedRaw as Record<string, unknown>

  return {
    requestsCount,
    tokensIn,
    tokensOut,
    status: String(firstPresent(raw, ['status']) ?? 'healthy'),
    lastSuccessAt: (firstPresent(raw, ['last_success_at']) as string | null | undefined) ?? null,
    lastErrorAt: (firstPresent(raw, ['last_error_at']) as string | null | undefined) ?? null,
    utilizationPct: toFloat(firstPresent(raw, ['utilization_pct'])),
    quotaRemaining: toInt(firstPresent(raw, ['quota_remaining'])),
    rateLimitRemaining: toInt(firstPresent(raw, ['rate_limit_remaining'])),
    errorRate1h: toFloat(firstPresent(raw, ['error_rate_1h'])),
    metadata: Object.keys(metadata).length ? metadata : undefined,
  }
}
