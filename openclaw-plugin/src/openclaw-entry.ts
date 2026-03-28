import type { AuthManagerLeasePluginConfig, LeaseControlAPI, LeaseTelemetryContext, UsageShape } from './types.js'
import { createLeaseManagerController } from './leaseControl.js'
import { createOpenClawLeaseTelemetryService } from './service.js'
import { resolvePluginConfig, validatePluginConfig } from './config.js'

type OpenClawPluginLikeDefinition = {
  id: string
  name: string
  description: string
  kind?: string
  register: (api: {
    logger?: Pick<Console, 'info' | 'warn' | 'error'>
    registerHook?: (
      events: string | string[],
      handler: (event: Record<string, unknown>) => void | Promise<void>,
      options?: {
        name?: string
        description?: string
      },
    ) => void
    registerService: (service: {
      id: string
      start: (ctx: { config?: Record<string, unknown>; env?: NodeJS.ProcessEnv }) => void | Promise<void>
      stop?: () => void | Promise<void>
      lease?: LeaseControlAPI
    }) => void
  }) => void
}

export function createAuthManagerOpenClawEntry(): OpenClawPluginLikeDefinition {
  return {
    id: 'openclaw-auth-manager-plugin',
    name: 'Codex Auth Manager Plugin',
    description: 'Acquire and manage CAM-backed auth leases, materialize auth, and post truthful OpenClaw telemetry.',
    register(api) {
      let service: ReturnType<typeof createOpenClawLeaseTelemetryService> | null = null
      let leaseApi: LeaseControlAPI | undefined

      api.registerService({
        id: 'openclaw-auth-manager-plugin-service',
        lease: {
          status: async (input) => {
            if (!leaseApi) throw new Error('Lease service is not started')
            return leaseApi.status(input)
          },
          ensure: async (input) => {
            if (!leaseApi) throw new Error('Lease service is not started')
            return leaseApi.ensure(input)
          },
          renew: async (input) => {
            if (!leaseApi) throw new Error('Lease service is not started')
            return leaseApi.renew(input)
          },
          rotate: async (input) => {
            if (!leaseApi) throw new Error('Lease service is not started')
            return leaseApi.rotate(input)
          },
          release: async (input) => {
            if (!leaseApi) throw new Error('Lease service is not started')
            return leaseApi.release(input)
          },
          reacquire: async (input) => {
            if (!leaseApi) throw new Error('Lease service is not started')
            return leaseApi.reacquire(input)
          },
          materialize: async () => {
            if (!leaseApi) throw new Error('Lease service is not started')
            return leaseApi.materialize()
          },
          flushTelemetry: async () => {
            if (!leaseApi) throw new Error('Lease service is not started')
            return leaseApi.flushTelemetry()
          },
          setAutoMode: async (input) => {
            if (!leaseApi) throw new Error('Lease service is not started')
            return leaseApi.setAutoMode(input)
          },
        },
        async start(ctx) {
          const config = resolvePluginConfig((ctx.config ?? {}) as Record<string, unknown>, ctx.env ?? process.env)
          const errors = validatePluginConfig(config)
          if (errors.length) {
            api.logger?.warn?.(`[openclaw-plugin] disabled: ${errors.join('; ')}`)
            api.logger?.warn?.('[openclaw-plugin] set the broker address with baseUrl or brokerAddress, set the API key with internalApiToken, and optionally set machineId to override the default host-derived machine name.')
            api.logger?.warn?.('[openclaw-plugin] example config: {"baseUrl":"https://your-auth-manager.example.com","internalApiToken":"<INTERNAL_API_TOKEN>","agentId":"main","machineId":"debian"}')
            return
          }
          service = createOpenClawLeaseTelemetryService({
            baseUrl: config.baseUrl,
            internalApiToken: config.internalApiToken,
            logger: api.logger,
            authFilePath: config.authFilePath,
            leaseProfileId: config.leaseProfileId,
            enforceLeaseAsActiveAuth: config.enforceLeaseAsActiveAuth,
            disallowNonLeaseAuth: config.disallowNonLeaseAuth,
            purgeNonLeaseProfilesOnStart: config.purgeNonLeaseProfilesOnStart,
            allowInsecureLocalhost: config.allowInsecureLocalhost,
            requestedTtlSeconds: config.requestedTtlSeconds,
            autoRenew: config.autoRenew,
            autoRotate: config.autoRotate,
            rotationPolicy: config.rotationPolicy,
            refreshIntervalMs: config.refreshIntervalMs,
            releaseLeaseOnShutdown: config.releaseLeaseOnShutdown,
            usageExportJsonPath: config.usageExportJsonPath,
            usageExportDays: config.usageExportDays,
            flushIntervalMs: config.flushIntervalMs,
            flushEveryRequests: config.flushEveryRequests,
            context: toLeaseContext(config),
          })
          leaseApi = createLeaseManagerController(service)
          await service.start()
        },
        async stop() {
          if (service) await service.shutdown()
          leaseApi = undefined
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
    lease: LeaseControlAPI
  }
} {
  return {
    attach(params) {
      const instance = service({
        baseUrl: params.config.baseUrl,
        internalApiToken: params.config.internalApiToken,
        logger: params.logger,
        authFilePath: params.config.authFilePath,
        leaseProfileId: params.config.leaseProfileId,
        enforceLeaseAsActiveAuth: params.config.enforceLeaseAsActiveAuth,
        disallowNonLeaseAuth: params.config.disallowNonLeaseAuth,
        purgeNonLeaseProfilesOnStart: params.config.purgeNonLeaseProfilesOnStart,
        allowInsecureLocalhost: params.config.allowInsecureLocalhost,
        requestedTtlSeconds: params.config.requestedTtlSeconds,
        autoRenew: params.config.autoRenew,
        autoRotate: params.config.autoRotate,
        rotationPolicy: params.config.rotationPolicy,
        refreshIntervalMs: params.config.refreshIntervalMs,
        releaseLeaseOnShutdown: params.config.releaseLeaseOnShutdown,
        usageExportJsonPath: params.config.usageExportJsonPath,
        usageExportDays: params.config.usageExportDays,
        flushIntervalMs: params.config.flushIntervalMs,
        flushEveryRequests: params.config.flushEveryRequests,
        context: toLeaseContext(params.config),
      })
      void instance.start()
      const lease = createLeaseManagerController(instance)
      return {
        observeUsage: (raw) => instance.observeUsage(raw),
        setLeaseContext: (context) => instance.setLeaseContext(context),
        flushNow: () => instance.flushNow(),
        stop: async () => instance.shutdown(),
        lease,
      }
    },
  }
}
