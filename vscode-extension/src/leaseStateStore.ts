import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import type * as vscode from 'vscode'
import type { Lease, LeaseStatusResponse } from './authManagerClient'

const STATE_KEY = 'authManager.leaseState'
const MACHINE_ID_KEY = 'authManager.machineId'
const AGENT_ID_KEY = 'authManager.agentId'

export interface LeaseState {
  machineId: string
  agentId: string
  leaseId: string | null
  credentialId: string | null
  issuedAt: string | null
  expiresAt: string | null
  leaseState: string | null
  latestTelemetryAt: string | null
  latestUtilizationPct: number | null
  latestQuotaRemaining: number | null
  lastAuthWriteAt: string | null
  lastBackendRefreshAt: string | null
  replacementRequired: boolean
  rotationRecommended: boolean
  lastErrorAt: string | null
}

export interface MementoLike {
  get<T>(key: string, defaultValue?: T): T | undefined
  update(key: string, value: unknown): Thenable<void>
}

export function defaultLeaseState(machineId: string, agentId: string): LeaseState {
  return {
    machineId,
    agentId,
    leaseId: null,
    credentialId: null,
    issuedAt: null,
    expiresAt: null,
    leaseState: null,
    latestTelemetryAt: null,
    latestUtilizationPct: null,
    latestQuotaRemaining: null,
    lastAuthWriteAt: null,
    lastBackendRefreshAt: null,
    replacementRequired: false,
    rotationRecommended: false,
    lastErrorAt: null,
  }
}

export function derivePersistedMachineId(configured?: string): string {
  const trimmed = configured?.trim()
  if (trimmed) {
    return trimmed
  }
  return `vscode-${os.hostname().replace(/[^a-zA-Z0-9._-]/g, '-')}-${randomUUID().slice(0, 8)}`
}

export function derivePersistedAgentId(configured?: string): string {
  const trimmed = configured?.trim()
  if (trimmed) {
    return trimmed
  }
  return 'vscode-extension'
}

export class LeaseStateStore {
  constructor(private readonly memento: MementoLike) {}

  async getOrCreateMachineId(configured?: string): Promise<string> {
    const existing = this.memento.get<string>(MACHINE_ID_KEY)
    if (existing?.trim()) {
      return existing
    }
    const machineId = derivePersistedMachineId(configured)
    await this.memento.update(MACHINE_ID_KEY, machineId)
    return machineId
  }

  async getOrCreateAgentId(configured?: string): Promise<string> {
    const existing = this.memento.get<string>(AGENT_ID_KEY)
    if (existing?.trim()) {
      return existing
    }
    const agentId = derivePersistedAgentId(configured)
    await this.memento.update(AGENT_ID_KEY, agentId)
    return agentId
  }

  load(machineId: string, agentId: string): LeaseState {
    const stored = this.memento.get<LeaseState>(STATE_KEY)
    return {
      ...defaultLeaseState(machineId, agentId),
      ...stored,
      machineId,
      agentId,
    }
  }

  async save(state: LeaseState): Promise<void> {
    await this.memento.update(STATE_KEY, state)
  }

  async clear(machineId: string, agentId: string): Promise<LeaseState> {
    const next = defaultLeaseState(machineId, agentId)
    await this.save(next)
    return next
  }

  async updateFromLease(state: LeaseState, lease: Lease): Promise<LeaseState> {
    const next: LeaseState = {
      ...state,
      leaseId: lease.id,
      credentialId: lease.credential_id,
      issuedAt: lease.issued_at,
      expiresAt: lease.expires_at,
      leaseState: lease.state,
      latestTelemetryAt: lease.last_telemetry_at,
      latestUtilizationPct: lease.latest_utilization_pct,
      latestQuotaRemaining: lease.latest_quota_remaining,
      lastBackendRefreshAt: new Date().toISOString(),
    }
    await this.save(next)
    return next
  }

  async updateFromLeaseStatus(state: LeaseState, status: LeaseStatusResponse): Promise<LeaseState> {
    const next: LeaseState = {
      ...state,
      leaseId: status.lease_id,
      credentialId: status.credential_id,
      issuedAt: status.issued_at,
      expiresAt: status.expires_at,
      leaseState: status.state,
      latestTelemetryAt: status.latest_telemetry_at,
      latestUtilizationPct: status.latest_utilization_pct,
      latestQuotaRemaining: status.latest_quota_remaining,
      lastBackendRefreshAt: new Date().toISOString(),
      replacementRequired: status.replacement_required,
      rotationRecommended: status.rotation_recommended,
    }
    await this.save(next)
    return next
  }

  async recordAuthWrite(state: LeaseState, atIso: string): Promise<LeaseState> {
    const next = { ...state, lastAuthWriteAt: atIso }
    await this.save(next)
    return next
  }

  async recordError(state: LeaseState, atIso: string): Promise<LeaseState> {
    const next = { ...state, lastErrorAt: atIso }
    await this.save(next)
    return next
  }
}
