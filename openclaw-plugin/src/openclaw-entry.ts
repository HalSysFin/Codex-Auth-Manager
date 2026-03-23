import type { AuthManagerLeasePluginConfig, LeaseTelemetryContext, UsageShape } from './types.js'
import { createOpenClawLeaseTelemetryService } from './service.js'
import { resolvePluginConfig, validatePluginConfig } from './config.js'

type OpenClawPluginLikeDefinition = {
  id: string
  name: string
  description: string
  kind?: string
  register: (api: {
    logger?: Pick<Console, 'info' | 'warn' | 'error'>
    registerService: (service: {
      id: string
      start: (ctx: { config?: Record<string, unknown>; env?: NodeJS.ProcessEnv }) => void | Promise<void>
      stop?: () => void | Promise<void>
    }) => void
  }) => void
}

export function createAuthManagerOpenClawEntry(): OpenClawPluginLikeDefinition {
  return {
    id: 'auth-manager-lease-telemetry',
    name: 'Auth Manager Lease Telemetry',
    description: 'Capture truthful OpenClaw usage and post it to Auth Manager lease telemetry.',
    register(api) {
      let service = createOpenClawLeaseTelemetryService({
        baseUrl: 'http://127.0.0.1:8080',
        apiKey: 'unset',
        logger: api.logger,
      })

      api.registerService({
        id: 'auth-manager-lease-telemetry-service',
        async start(ctx) {
          const config = resolvePluginConfig((ctx.config ?? {}) as Record<string, unknown>, ctx.env ?? process.env)
          const errors = validatePluginConfig(config)
          if (errors.length) {
            api.logger?.warn?.(`[openclaw-plugin] disabled: ${errors.join('; ')}`)
            return
          }
          service = createOpenClawLeaseTelemetryService({
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            logger: api.logger,
            flushIntervalMs: config.flushIntervalMs,
            flushEveryRequests: config.flushEveryRequests,
            context: toLeaseContext(config),
          })
          service.start()
        },
        async stop() {
          await service.flushNow()
          service.stop()
        },
      })
    },
  }
}

function toLeaseContext(config: AuthManagerLeasePluginConfig): LeaseTelemetryContext | undefined {
  if (!config.leaseId) return undefined
  return {
    leaseId: config.leaseId,
    machineId: config.machineId,
    agentId: config.agentId,
  }
}

export function buildUsageObserver(service = createOpenClawLeaseTelemetryService): {
  attach: (params: {
    config: AuthManagerLeasePluginConfig
    logger?: Pick<Console, 'info' | 'warn' | 'error'>
  }) => {
    observeUsage: (raw: UsageShape) => void
    setLeaseContext: (context: LeaseTelemetryContext) => void
    flushNow: () => Promise<void>
    stop: () => Promise<void>
  }
} {
  return {
    attach(params) {
      const instance = service({
        baseUrl: params.config.baseUrl,
        apiKey: params.config.apiKey,
        logger: params.logger,
        flushIntervalMs: params.config.flushIntervalMs,
        flushEveryRequests: params.config.flushEveryRequests,
        context: toLeaseContext(params.config),
      })
      instance.start()
      return {
        observeUsage: (raw) => instance.observeUsage(raw),
        setLeaseContext: (context) => instance.setLeaseContext(context),
        flushNow: () => instance.flushNow(),
        stop: async () => {
          await instance.flushNow()
          instance.stop()
        },
      }
    },
  }
}
