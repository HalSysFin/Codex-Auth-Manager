import { URL } from 'node:url'

export interface Lease {
  id: string
  credential_id: string
  machine_id: string
  agent_id: string
  state: string
  issued_at: string
  expires_at: string
  renewed_at: string | null
  revoked_at: string | null
  released_at: string | null
  rotation_reason: string | null
  replacement_lease_id: string | null
  last_telemetry_at: string | null
  latest_utilization_pct: number | null
  latest_quota_remaining: number | null
  last_success_at: string | null
  last_error_at: string | null
  reason: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface LeaseAcquireResponse {
  status: 'ok' | 'denied'
  reason: string | null
  lease: Lease | null
}

export interface LeaseRotateResponse extends LeaseAcquireResponse {}

export interface LeaseStatusResponse {
  lease_id: string
  credential_id: string
  state: string
  issued_at: string
  expires_at: string
  renewed_at: string | null
  machine_id: string
  agent_id: string
  latest_telemetry_at: string | null
  latest_utilization_pct: number | null
  latest_quota_remaining: number | null
  last_success_at: string | null
  last_error_at: string | null
  rotation_recommended: boolean
  replacement_required: boolean
  reason: string | null
  credential_state: string
}

export interface LeaseTelemetryRequest {
  machine_id: string
  agent_id: string
  captured_at: string
  requests_count?: number | null
  tokens_in?: number | null
  tokens_out?: number | null
  utilization_pct?: number | null
  quota_remaining?: number | null
  rate_limit_remaining?: number | null
  status: string
  last_success_at?: string | null
  last_error_at?: string | null
  error_rate_1h?: number | null
}

export interface AuthPayload {
  auth_mode: string
  OPENAI_API_KEY: null
  tokens: {
    id_token: string
    access_token: string
    refresh_token: string
    account_id: string
  }
  last_refresh?: string
}

export interface MaterializeLeaseResponse extends LeaseAcquireResponse {
  credential_material?: {
    label?: string | null
    account_key?: string | null
    email?: string | null
    name?: string | null
    provider_account_id?: string | null
    auth_json?: AuthPayload | null
  } | null
}

export interface AuthManagerClientOptions {
  baseUrl: string
  internalApiToken?: string
  allowInsecureLocalhost?: boolean
  fetchImpl?: typeof fetch
}

export class AuthManagerClientError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'AuthManagerClientError'
    this.status = status
    this.code = code
  }
}

export function normalizeBackendErrorPayload(payload: unknown): { message: string; code?: string } {
  if (!payload || typeof payload !== 'object') {
    return { message: 'Unknown backend error' }
  }
  const record = payload as Record<string, unknown>
  const detail = record.detail
  if (typeof detail === 'string' && detail.trim()) {
    return { message: detail }
  }
  const reason = record.reason
  if (typeof reason === 'string' && reason.trim()) {
    return { message: reason, code: reason }
  }
  const message = record.message
  if (typeof message === 'string' && message.trim()) {
    return { message }
  }
  return { message: 'Unknown backend error' }
}

function sanitizeBaseUrl(raw: string, allowInsecureLocalhost: boolean): string {
  const parsed = new URL(raw)
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1'])
  const isLocalhost = localHosts.has(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(allowInsecureLocalhost && isLocalhost)) {
    throw new Error(`Refusing insecure Auth Manager URL: ${parsed.toString()}`)
  }
  return parsed.toString().replace(/\/+$/, '')
}

export class AuthManagerClient {
  private readonly baseUrl: string
  private readonly internalApiToken?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: AuthManagerClientOptions) {
    this.baseUrl = sanitizeBaseUrl(options.baseUrl, Boolean(options.allowInsecureLocalhost))
    this.internalApiToken = options.internalApiToken?.trim() || undefined
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async acquireLease(input: {
    machineId: string
    agentId: string
    requestedTtlSeconds?: number
    reason?: string
  }): Promise<LeaseAcquireResponse> {
    return this.request<LeaseAcquireResponse>('/api/leases/acquire', {
      method: 'POST',
      body: {
        machine_id: input.machineId,
        agent_id: input.agentId,
        requested_ttl_seconds: input.requestedTtlSeconds,
        reason: input.reason,
      },
    })
  }

  async getLease(leaseId: string): Promise<LeaseStatusResponse> {
    return this.request<LeaseStatusResponse>(`/api/leases/${encodeURIComponent(leaseId)}`, {
      method: 'GET',
    })
  }

  async renewLease(leaseId: string, input: { machineId: string; agentId: string }): Promise<LeaseAcquireResponse> {
    return this.request<LeaseAcquireResponse>(`/api/leases/${encodeURIComponent(leaseId)}/renew`, {
      method: 'POST',
      body: {
        machine_id: input.machineId,
        agent_id: input.agentId,
      },
    })
  }

  async releaseLease(leaseId: string, input: { machineId: string; agentId: string; reason?: string }): Promise<LeaseAcquireResponse> {
    return this.request<LeaseAcquireResponse>(`/api/leases/${encodeURIComponent(leaseId)}/release`, {
      method: 'POST',
      body: {
        machine_id: input.machineId,
        agent_id: input.agentId,
        reason: input.reason,
      },
    })
  }

  async rotateLease(input: {
    leaseId: string
    machineId: string
    agentId: string
    reason: string
  }): Promise<LeaseRotateResponse> {
    return this.request<LeaseRotateResponse>('/api/leases/rotate', {
      method: 'POST',
      body: {
        lease_id: input.leaseId,
        machine_id: input.machineId,
        agent_id: input.agentId,
        reason: input.reason,
      },
    })
  }

  async postTelemetry(leaseId: string, payload: LeaseTelemetryRequest): Promise<LeaseAcquireResponse> {
    return this.request<LeaseAcquireResponse>(`/api/leases/${encodeURIComponent(leaseId)}/telemetry`, {
      method: 'POST',
      body: payload,
    })
  }

  async fetchAuthPayloadForLease(leaseId: string, input: {
    machineId: string
    agentId: string
  }): Promise<MaterializeLeaseResponse> {
    return this.request<MaterializeLeaseResponse>(`/api/leases/${encodeURIComponent(leaseId)}/materialize`, {
      method: 'POST',
      body: {
        machine_id: input.machineId,
        agent_id: input.agentId,
      },
    })
  }

  private async request<T>(path: string, options: { method: string; body?: unknown }): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    }
    if (this.internalApiToken) {
      headers.Authorization = `Bearer ${this.internalApiToken}`
    }
    let body: string | undefined
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(options.body)
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method,
      headers,
      body,
    })
    const raw = await response.text()
    let parsed: unknown = null
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = raw
      }
    }
    if (!response.ok) {
      const normalized = normalizeBackendErrorPayload(parsed)
      throw new AuthManagerClientError(normalized.message, response.status, normalized.code)
    }
    return parsed as T
  }
}
