import * as crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

import type {
  AutomaticLeaseManagementUpdate,
  LeaseAcquireResponse,
  LeaseControlErrorCode,
  LeaseControlResult,
  LeaseControlStatus,
  LeaseStatusResponse,
  LeaseTelemetryContext,
  OpenClawLeaseTelemetryServiceOptions,
  UsageShape,
} from './types.js'
import { OpenClawAuthManagerPlugin } from './plugin.js'
import { AuthManagerClientError, AuthManagerTelemetryClient } from './client.js'
import { applyLeaseAuthToOpenClaw, expandHomePath } from './authFile.js'

const execFileAsync = promisify(execFile)

function countObservedRequests(raw: UsageShape): number {
  const direct = raw.requests_count ?? raw.request_count
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return Math.trunc(direct)
  if (typeof direct === 'string') {
    const parsed = Number(direct.trim())
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed)
  }
  const usage = raw.usage
  if (usage && typeof usage === 'object') {
    const u = usage as Record<string, unknown>
    if (
      typeof u.prompt_tokens === 'number' ||
      typeof u.input_tokens === 'number' ||
      typeof u.completion_tokens === 'number' ||
      typeof u.output_tokens === 'number' ||
      typeof u.total_tokens === 'number'
    ) {
      return 1
    }
  }
  return 0
}

export class OpenClawLeaseTelemetryService {
  private readonly plugin: OpenClawAuthManagerPlugin
  private readonly client: AuthManagerTelemetryClient
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>
  private readonly flushIntervalMs: number
  private readonly flushEveryRequests: number
  private readonly refreshIntervalMs: number
  private readonly requestedTtlSeconds: number
  private autoRenew: boolean
  private autoRotate: boolean
  private readonly rotationPolicy: 'replacement_required_only' | 'recommended_or_required'
  private readonly releaseLeaseOnShutdown: boolean
  private readonly usageExportJsonPath: string | null
  private readonly usageExportDays: number
  private readonly machineId: string
  private readonly agentId: string
  private readonly authFilePath: string
  private readonly leaseProfileId: string
  private readonly enforceLeaseAsActiveAuth: boolean
  private readonly disallowNonLeaseAuth: boolean
  private readonly purgeNonLeaseProfilesOnStart: boolean
  private flushTimer: NodeJS.Timeout | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private observedSinceFlush = 0
  private context: LeaseTelemetryContext | null = null
  private lastKnownLeaseState: string | null = null
  private lastKnownExpiresAt: string | null = null
  private currentCredentialId: string | null = null
  private currentCredentialAuthUpdatedAt: string | null = null
  private lastLeaseStatus: LeaseStatusResponse | null = null
  private authMaterialized = false
  private lastError: string | null = null
  private lastRefreshAt: string | null = null
  private lastImportedUsageHash: string | null = null
  private usageImportRunning = false
  private activeMutation: string | null = null

  constructor(options: OpenClawLeaseTelemetryServiceOptions) {
    this.client = new AuthManagerTelemetryClient({
      baseUrl: options.baseUrl,
      internalApiToken: options.internalApiToken,
      allowInsecureLocalhost: options.allowInsecureLocalhost,
      fetchImpl: options.fetchImpl,
    })
    this.plugin = new OpenClawAuthManagerPlugin(options)
    this.logger = options.logger ?? console
    this.flushIntervalMs = options.flushIntervalMs ?? 60_000
    this.flushEveryRequests = options.flushEveryRequests ?? 10
    this.refreshIntervalMs = options.refreshIntervalMs ?? 60_000
    this.requestedTtlSeconds = options.requestedTtlSeconds ?? 1800
    this.autoRenew = options.autoRenew ?? true
    this.autoRotate = options.autoRotate ?? true
    this.rotationPolicy = options.rotationPolicy ?? 'replacement_required_only'
    this.releaseLeaseOnShutdown = options.releaseLeaseOnShutdown ?? true
    this.usageExportJsonPath = options.usageExportJsonPath ? expandHomePath(options.usageExportJsonPath) : null
    this.usageExportDays = Math.max(1, Math.trunc(options.usageExportDays ?? 30))
    this.machineId = options.context?.machineId ?? 'openclaw'
    this.agentId = options.context?.agentId ?? 'openclaw'
    this.authFilePath = options.authFilePath ?? '~/.codex/auth.json'
    this.leaseProfileId = options.leaseProfileId ?? 'openai-codex:lease'
    this.enforceLeaseAsActiveAuth = options.enforceLeaseAsActiveAuth ?? true
    this.disallowNonLeaseAuth = options.disallowNonLeaseAuth ?? false
    this.purgeNonLeaseProfilesOnStart = options.purgeNonLeaseProfilesOnStart ?? false
    this.context = options.context ?? null
    this.lastKnownLeaseState = null
    this.lastKnownExpiresAt = null
  }

  async start(): Promise<void> {
    this.stop()
    if (this.purgeNonLeaseProfilesOnStart && this.context?.leaseId) {
      this.logger.info?.('[openclaw-plugin] purgeNonLeaseProfilesOnStart enabled; will enforce lease profile on first materialization')
    }
    await this.ensureLeaseNow('startup')
    await this.importUsageExportIfChanged()
    this.flushTimer = setInterval(() => {
      void this.flushIfNeeded()
    }, this.flushIntervalMs)
    this.flushTimer.unref?.()
    this.refreshTimer = setInterval(() => {
      void this.refreshLease()
    }, this.refreshIntervalMs)
    this.refreshTimer.unref?.()
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  setLeaseContext(context: LeaseTelemetryContext): void {
    this.context = context
    this.plugin.setLeaseContext(context)
  }

  clearLeaseContext(): void {
    this.context = null
    this.currentCredentialId = null
    this.currentCredentialAuthUpdatedAt = null
    this.lastLeaseStatus = null
    this.lastKnownLeaseState = null
    this.lastKnownExpiresAt = null
    this.authMaterialized = false
    this.plugin.clearLeaseContext()
    this.observedSinceFlush = 0
  }

  observeUsage(raw: UsageShape): void {
    this.plugin.observeUsage(raw)
    this.observedSinceFlush += countObservedRequests(raw)
    if (this.observedSinceFlush >= this.flushEveryRequests) {
      void this.flushIfNeeded()
    }
  }

  getPendingTotals() {
    return this.plugin.getPendingTotals()
  }

  async flushIfNeeded(force = false): Promise<void> {
    const pending = this.plugin.getPendingTotals()
    const hasAnything =
      pending.requestsCount > 0 ||
      pending.tokensIn > 0 ||
      pending.tokensOut > 0 ||
      pending.lastSuccessAt != null ||
      pending.lastErrorAt != null ||
      pending.utilizationPct != null ||
      pending.quotaRemaining != null
    if (!force && !hasAnything) {
      await this.importUsageExportIfChanged()
      return
    }
    try {
      await this.plugin.flushTelemetry()
      this.observedSinceFlush = 0
      if (this.context?.leaseId) {
        const status = await this.client.getLease(this.context.leaseId)
        this.captureLeaseStatus(status)
        if (this.needsAuthRematerialize(status)) {
          await this.materializeAndWriteAuth(status.lease_id)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn?.(`[openclaw-plugin] telemetry flush failed: ${message}`)
    }
    await this.importUsageExportIfChanged()
  }

  async flushNow(): Promise<void> {
    await this.flushIfNeeded(true)
  }

  async getLeaseStatus(refresh = true): Promise<LeaseControlResult> {
    try {
      if (refresh && this.context?.leaseId && !this.activeMutation) {
        const status = await this.client.getLease(this.context.leaseId)
        this.captureLeaseStatus(status)
      }
      return this.successResult('status')
    } catch (error) {
      this.captureError(error)
      return this.failureResult('status', this.classifyClientError(error, 'broker_unreachable'))
    }
  }

  async ensureLeaseNow(reason = 'manual_ensure'): Promise<LeaseControlResult> {
    return this.runMutation('ensure', () => this.ensureLeaseInternal(reason))
  }

  async renewLeaseNow(reason = 'manual_renew'): Promise<LeaseControlResult> {
    return this.runMutation('renew', async () => {
      if (!this.context?.leaseId) {
        return this.failureResult('renew', {
          code: 'no_active_lease',
          message: 'No active lease is available to renew.',
        })
      }
      try {
        await this.renewLeaseInternal(reason)
        return this.successResult('renew')
      } catch (error) {
        this.captureError(error)
        return this.failureResult('renew', this.classifyClientError(error, 'renew_denied'))
      }
    })
  }

  async rotateLeaseNow(reason = 'manual_rotate'): Promise<LeaseControlResult> {
    return this.runMutation('rotate', async () => {
      if (!this.context?.leaseId) {
        return this.failureResult('rotate', {
          code: 'no_active_lease',
          message: 'No active lease is available to rotate.',
        })
      }
      try {
        await this.flushIfNeeded(true)
        await this.rotateAndMaterialize(reason)
        return this.successResult('rotate')
      } catch (error) {
        this.captureError(error)
        return this.failureResult('rotate', this.classifyClientError(error, 'rotation_denied'))
      }
    })
  }

  async releaseLeaseNow(reason = 'manual_release'): Promise<LeaseControlResult> {
    return this.runMutation('release', async () => {
      if (!this.context?.leaseId) {
        return this.failureResult('release', {
          code: 'no_active_lease',
          message: 'No active lease is available to release.',
        })
      }
      try {
        await this.flushIfNeeded(true)
        await this.releaseLeaseInternal(reason)
        return this.successResult('release')
      } catch (error) {
        this.captureError(error)
        return this.failureResult('release', this.classifyClientError(error, 'release_failed'))
      }
    })
  }

  async reacquireLeaseNow(reason = 'manual_reacquire'): Promise<LeaseControlResult> {
    return this.runMutation('reacquire', async () => {
      try {
        await this.flushIfNeeded(true)
        if (this.context?.leaseId) {
          await this.releaseLeaseInternal(`${reason}:release_current`)
        }
        await this.acquireAndMaterialize(reason)
        return this.successResult('reacquire')
      } catch (error) {
        this.captureError(error)
        return this.failureResult('reacquire', this.classifyClientError(error, 'broker_unreachable'))
      }
    })
  }

  async materializeCurrentLeaseNow(): Promise<LeaseControlResult> {
    return this.runMutation('materialize', async () => {
      if (!this.context?.leaseId) {
        return this.failureResult('materialize', {
          code: 'no_active_lease',
          message: 'No active lease is available to materialize.',
        })
      }
      try {
        await this.materializeAndWriteAuth(this.context.leaseId)
        return this.successResult('materialize')
      } catch (error) {
        this.captureError(error)
        return this.failureResult('materialize', this.classifyClientError(error, 'materialization_failed'))
      }
    })
  }

  async flushTelemetryNow(): Promise<LeaseControlResult> {
    if (!this.context?.leaseId) {
      return this.failureResult('flush_telemetry', {
        code: 'no_active_lease',
        message: 'No active lease is available for telemetry flush.',
      })
    }
    try {
      await this.flushIfNeeded(true)
      return this.successResult('flush_telemetry')
    } catch (error) {
      this.captureError(error)
      return this.failureResult('flush_telemetry', this.classifyClientError(error, 'broker_unreachable'))
    }
  }

  async setAutomaticLeaseManagement(update: AutomaticLeaseManagementUpdate): Promise<LeaseControlResult> {
    if (typeof update.autoRenew === 'boolean') {
      this.autoRenew = update.autoRenew
    }
    if (typeof update.autoRotate === 'boolean') {
      this.autoRotate = update.autoRotate
    }
    return this.successResult('set_auto_mode')
  }

  async shutdown(): Promise<void> {
    this.stop()
    await this.flushIfNeeded(true)
    if (!this.releaseLeaseOnShutdown || !this.context?.leaseId) {
      return
    }
    try {
      await this.releaseLeaseInternal('openclaw_shutdown')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn?.(`[openclaw-plugin] shutdown lease release failed: ${message}`)
    }
  }

  private async ensureLeaseInternal(reason: string): Promise<LeaseControlResult> {
    if (!this.context?.leaseId) {
      await this.acquireAndMaterialize(reason === 'startup' ? 'startup_acquire' : reason)
      return this.successResult('ensure')
    }
    try {
      const status = await this.client.getLease(this.context.leaseId)
      this.captureLeaseStatus(status)
      if (this.needsReacquire(status)) {
        await this.acquireAndMaterialize(reason === 'startup' ? 'startup_reacquire' : reason)
        return this.successResult('ensure')
      }
      if (this.shouldRotate(status)) {
        await this.rotateAndMaterialize('approaching_utilization_threshold')
        return this.successResult('ensure')
      }
      if (this.shouldRenew(status)) {
        await this.renewLeaseInternal(reason)
      }
      if (this.needsAuthRematerialize(status)) {
        await this.materializeAndWriteAuth(status.lease_id)
      }
      return this.successResult('ensure')
    } catch (error) {
      if (error instanceof AuthManagerClientError && error.status === 404) {
        await this.acquireAndMaterialize(reason === 'startup' ? 'startup_reacquire_missing' : `${reason}_missing`)
        return this.successResult('ensure')
      }
      this.captureError(error)
      return this.failureResult('ensure', this.classifyClientError(error, 'broker_unreachable'))
    }
  }

  private async refreshLease(): Promise<void> {
    if (this.activeMutation) return
    const result = await this.runMutation('refresh', async () => {
      if (!this.context?.leaseId) {
        await this.acquireAndMaterialize('scheduled_acquire')
        return this.successResult('refresh')
      }
      try {
        const status = await this.client.getLease(this.context.leaseId)
        this.captureLeaseStatus(status)
        if (this.needsReacquire(status)) {
          await this.acquireAndMaterialize('scheduled_reacquire')
          return this.successResult('refresh')
        }
        if (this.shouldRotate(status)) {
          await this.flushIfNeeded(true)
          await this.rotateAndMaterialize('approaching_utilization_threshold')
          return this.successResult('refresh')
        }
        if (this.shouldRenew(status)) {
          await this.renewLeaseInternal('scheduled_renew')
        }
        if (this.needsAuthRematerialize(status)) {
          await this.materializeAndWriteAuth(status.lease_id)
        }
        await this.importUsageExportIfChanged()
        return this.successResult('refresh')
      } catch (error) {
        this.captureError(error)
        return this.failureResult('refresh', this.classifyClientError(error, 'broker_unreachable'))
      }
    }, { skipIfBusy: true })
    if (!result.ok) {
      this.logger.warn?.(`[openclaw-plugin] lease refresh failed: ${result.error?.message ?? 'unknown error'}`)
    }
  }

  private async acquireAndMaterialize(reason: string): Promise<void> {
    const response = await this.client.acquireLease({
      machineId: this.machineId,
      agentId: this.agentId,
      requestedTtlSeconds: this.requestedTtlSeconds,
      reason,
    })
    const lease = this.consumeLeaseResponse(response, 'lease acquire denied')
    await this.materializeAndWriteAuth(lease.id)
  }

  private async rotateAndMaterialize(reason: string): Promise<void> {
    if (!this.context?.leaseId) {
      await this.acquireAndMaterialize(`rotate_without_lease:${reason}`)
      return
    }
    const response = await this.client.rotateLease({
      leaseId: this.context.leaseId,
      machineId: this.machineId,
      agentId: this.agentId,
      reason,
    })
    const lease = this.consumeLeaseResponse(response, 'lease rotation denied')
    await this.materializeAndWriteAuth(lease.id)
  }

  private async renewLeaseInternal(reason: string): Promise<void> {
    if (!this.context?.leaseId) {
      return
    }
    const response = await this.client.renewLease(this.context.leaseId, {
      machineId: this.machineId,
      agentId: this.agentId,
    })
    const lease = this.consumeLeaseResponse(response, 'lease renew denied')
    this.context = {
      leaseId: lease.id,
      machineId: this.machineId,
      agentId: this.agentId,
      utilizationPct: lease.latest_utilization_pct,
      quotaRemaining: lease.latest_quota_remaining,
    }
    this.plugin.setLeaseContext(this.context)
    this.currentCredentialAuthUpdatedAt =
      typeof lease.metadata?.credential_auth_updated_at === 'string'
        ? lease.metadata.credential_auth_updated_at
        : this.currentCredentialAuthUpdatedAt
    this.lastRefreshAt = new Date().toISOString()
    this.lastError = null
    void reason
  }

  private async materializeAndWriteAuth(leaseId: string): Promise<void> {
    const response = await this.client.materializeLease(leaseId, {
      machineId: this.machineId,
      agentId: this.agentId,
    })
    const lease = this.consumeLeaseResponse(response, 'lease materialize denied')
    const openClawMaterial = response.credential_material?.openclaw ?? {}
    if (!openClawMaterial.openclaw_auth_json && !response.credential_material?.auth_json) {
      throw new Error('Lease materialization did not return OpenClaw auth payloads')
    }
    await applyLeaseAuthToOpenClaw({
      material: openClawMaterial,
      authPayload: response.credential_material?.auth_json ?? null,
      leaseProfileId: this.leaseProfileId,
      agentId: this.agentId,
    })
    this.context = {
      leaseId: lease.id,
      machineId: this.machineId,
      agentId: this.agentId,
      utilizationPct: lease.latest_utilization_pct,
      quotaRemaining: lease.latest_quota_remaining,
    }
    this.plugin.setLeaseContext(this.context)
    this.authMaterialized = true
    this.currentCredentialAuthUpdatedAt =
      typeof lease.metadata?.credential_auth_updated_at === 'string'
        ? lease.metadata.credential_auth_updated_at
        : this.currentCredentialAuthUpdatedAt
    this.lastRefreshAt = new Date().toISOString()
    this.lastError = null
    this.logger.info?.(`[openclaw-plugin] lease auth materialized and activated as ${this.leaseProfileId}`)
  }

  private async releaseLeaseInternal(reason: string): Promise<void> {
    if (!this.context?.leaseId) return
    await this.client.releaseLease(this.context.leaseId, {
      machineId: this.machineId,
      agentId: this.agentId,
      reason,
    })
    this.clearLeaseContext()
    this.lastError = null
    this.lastRefreshAt = new Date().toISOString()
  }

  private consumeLeaseResponse(response: LeaseAcquireResponse, fallbackMessage: string) {
    if (response.status !== 'ok' || !response.lease) {
      throw new Error(response.reason || fallbackMessage)
    }
    this.lastKnownLeaseState = response.lease.state
    this.lastKnownExpiresAt = response.lease.expires_at
    this.currentCredentialId = response.lease.credential_id || null
    this.currentCredentialAuthUpdatedAt =
      typeof response.lease.metadata?.credential_auth_updated_at === 'string'
        ? response.lease.metadata.credential_auth_updated_at
        : this.currentCredentialAuthUpdatedAt
    this.lastRefreshAt = new Date().toISOString()
    this.lastError = null
    return response.lease
  }

  private captureLeaseStatus(status: LeaseStatusResponse): void {
    this.lastLeaseStatus = status
    this.lastKnownLeaseState = status.state
    this.lastKnownExpiresAt = status.expires_at
    this.currentCredentialId = status.credential_id || null
    this.currentCredentialAuthUpdatedAt = status.credential_auth_updated_at ?? this.currentCredentialAuthUpdatedAt
    this.lastRefreshAt = new Date().toISOString()
    this.lastError = null
    if (this.context) {
      this.context = {
        ...this.context,
        utilizationPct: status.latest_utilization_pct,
        quotaRemaining: status.latest_quota_remaining,
      }
      this.plugin.setLeaseContext(this.context)
    }
  }

  private needsReacquire(status: LeaseStatusResponse): boolean {
    const badLeaseState = new Set(['released', 'revoked', 'expired', 'missing', 'denied'])
    const badCredentialState = new Set(['revoked', 'expired', 'exhausted', 'unavailable_for_assignment'])
    return badLeaseState.has(status.state) || badCredentialState.has(status.credential_state)
  }

  private shouldRotate(status: LeaseStatusResponse): boolean {
    if (!this.autoRotate) {
      return false
    }
    if (status.replacement_required) {
      return true
    }
    return this.rotationPolicy === 'recommended_or_required' && status.rotation_recommended
  }

  private shouldRenew(status: LeaseStatusResponse): boolean {
    if (!this.autoRenew || !status.expires_at) {
      return false
    }
    const expiresAt = Date.parse(status.expires_at)
    if (!Number.isFinite(expiresAt)) {
      return false
    }
    return expiresAt - Date.now() <= 5 * 60 * 1000
  }

  private needsAuthRematerialize(status: LeaseStatusResponse): boolean {
    return Boolean(this.context?.leaseId && status.auth_refresh_required && status.credential_auth_updated_at)
  }

  private buildStatus(): LeaseControlStatus {
    const source = this.lastLeaseStatus
    return {
      leaseId: this.context?.leaseId ?? null,
      state: source?.state ?? this.lastKnownLeaseState ?? null,
      credentialId: this.currentCredentialId,
      expiresAt: source?.expires_at ?? this.lastKnownExpiresAt ?? null,
      utilizationPct: source?.latest_utilization_pct ?? this.context?.utilizationPct ?? null,
      quotaRemaining: source?.latest_quota_remaining ?? this.context?.quotaRemaining ?? null,
      rotationRecommended: Boolean(source?.rotation_recommended),
      replacementRequired: Boolean(source?.replacement_required),
      authMaterialized: this.authMaterialized,
      leaseProfileId: this.leaseProfileId,
      machineId: this.machineId,
      agentId: this.agentId,
      autoRenew: this.autoRenew,
      autoRotate: this.autoRotate,
      lastError: this.lastError,
      lastRefreshAt: this.lastRefreshAt,
    }
  }

  private successResult(operation: string): LeaseControlResult {
    return {
      ok: true,
      operation,
      status: this.buildStatus(),
      error: null,
    }
  }

  private failureResult(
    operation: string,
    error: { code: LeaseControlErrorCode; message: string },
  ): LeaseControlResult {
    return {
      ok: false,
      operation,
      status: this.buildStatus(),
      error,
    }
  }

  private captureError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error)
    this.lastRefreshAt = new Date().toISOString()
  }

  private classifyClientError(
    error: unknown,
    fallbackCode: Exclude<LeaseControlErrorCode, 'concurrent_operation' | 'invalid_state' | 'no_active_lease'>,
  ): { code: LeaseControlErrorCode; message: string } {
    if (error instanceof AuthManagerClientError) {
      return {
        code: error.code === 'reason' ? fallbackCode : fallbackCode,
        message: error.message,
      }
    }
    return {
      code: 'broker_unreachable',
      message: error instanceof Error ? error.message : String(error),
    }
  }

  private async runMutation(
    operation: string,
    fn: () => Promise<LeaseControlResult>,
    options?: { skipIfBusy?: boolean },
  ): Promise<LeaseControlResult> {
    if (this.activeMutation) {
      if (options?.skipIfBusy) {
        return this.successResult(operation)
      }
      return this.failureResult(operation, {
        code: 'concurrent_operation',
        message: `Lease operation already in progress: ${this.activeMutation}`,
      })
    }
    this.activeMutation = operation
    try {
      return await fn()
    } finally {
      this.activeMutation = null
    }
  }

  private async importUsageExportIfChanged(): Promise<void> {
    if (this.usageImportRunning) {
      return
    }
    try {
      this.usageImportRunning = true
      const source = await this.loadUsageExport()
      if (!source) {
        return
      }
      const raw = JSON.stringify(source.exportJson)
      const contentHash = crypto.createHash('sha256').update(raw).digest('hex')
      if (contentHash === this.lastImportedUsageHash) {
        return
      }
      const result = await this.client.importOpenClawUsage({
        machineId: this.machineId,
        agentId: this.agentId,
        leaseId: this.context?.leaseId ?? null,
        credentialId: this.currentCredentialId,
        sourceName: source.sourceName,
        exportJson: source.exportJson,
      })
      this.lastImportedUsageHash = contentHash
      this.logger.info?.(
        `[openclaw-plugin] usage JSON import ${result.imported === false ? 'unchanged' : 'uploaded'} from ${source.sourceName}`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn?.(`[openclaw-plugin] usage JSON import failed: ${message}`)
    } finally {
      this.usageImportRunning = false
    }
  }

  private async loadUsageExport(): Promise<{ sourceName: string; exportJson: Record<string, unknown> } | null> {
    if (this.usageExportJsonPath) {
      return this.readUsageExportFile(this.usageExportJsonPath)
    }
    return this.fetchUsageExportFromOpenClaw()
  }

  private async readUsageExportFile(
    resolvedPath: string,
  ): Promise<{ sourceName: string; exportJson: Record<string, unknown> } | null> {
    let raw: string
    try {
      raw = await fs.readFile(resolvedPath, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn?.(`[openclaw-plugin] usage JSON read failed: ${message}`)
      return null
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('usage JSON must be an object')
      }
      return { sourceName: path.basename(resolvedPath), exportJson: parsed as Record<string, unknown> }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn?.(`[openclaw-plugin] usage JSON parse failed: ${message}`)
      return null
    }
  }

  private async fetchUsageExportFromOpenClaw(): Promise<{ sourceName: string; exportJson: Record<string, unknown> } | null> {
    try {
      const { stdout } = await execFileAsync(
        'openclaw',
        ['gateway', 'usage-cost', '--json', '--days', String(this.usageExportDays)],
        {
          timeout: 20_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      )
      const trimmed = stdout.trim()
      if (!trimmed) {
        return null
      }
      const jsonStart = trimmed.indexOf('{')
      if (jsonStart < 0) {
        throw new Error('usage-cost produced no JSON object')
      }
      const parsed = JSON.parse(trimmed.slice(jsonStart)) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('usage-cost JSON must be an object')
      }
      return {
        sourceName: `openclaw-gateway-usage-cost-${this.usageExportDays}d.json`,
        exportJson: parsed as Record<string, unknown>,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn?.(`[openclaw-plugin] usage-cost export failed: ${message}`)
      return null
    }
  }
}

export function createOpenClawLeaseTelemetryService(
  options: OpenClawLeaseTelemetryServiceOptions,
): OpenClawLeaseTelemetryService {
  return new OpenClawLeaseTelemetryService(options)
}
