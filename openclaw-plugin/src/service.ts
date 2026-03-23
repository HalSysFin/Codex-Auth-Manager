import type {
  LeaseTelemetryContext,
  OpenClawLeaseTelemetryServiceOptions,
  UsageShape,
} from './types.js'
import { OpenClawAuthManagerPlugin } from './plugin.js'

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
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>
  private readonly flushIntervalMs: number
  private readonly flushEveryRequests: number
  private flushTimer: NodeJS.Timeout | null = null
  private observedSinceFlush = 0

  constructor(options: OpenClawLeaseTelemetryServiceOptions) {
    this.plugin = new OpenClawAuthManagerPlugin(options)
    this.logger = options.logger ?? console
    this.flushIntervalMs = options.flushIntervalMs ?? 60_000
    this.flushEveryRequests = options.flushEveryRequests ?? 10
  }

  start(): void {
    this.stop()
    this.flushTimer = setInterval(() => {
      void this.flushIfNeeded()
    }, this.flushIntervalMs)
    this.flushTimer.unref?.()
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  setLeaseContext(context: LeaseTelemetryContext): void {
    this.plugin.setLeaseContext(context)
  }

  clearLeaseContext(): void {
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
    if (!force && !hasAnything) return
    try {
      await this.plugin.flushTelemetry()
      this.observedSinceFlush = 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn?.(`[openclaw-plugin] telemetry flush failed: ${message}`)
    }
  }

  async flushNow(): Promise<void> {
    await this.flushIfNeeded(true)
  }
}

export function createOpenClawLeaseTelemetryService(
  options: OpenClawLeaseTelemetryServiceOptions,
): OpenClawLeaseTelemetryService {
  return new OpenClawLeaseTelemetryService(options)
}
