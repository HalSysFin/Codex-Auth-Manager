import assert from 'node:assert/strict'
import test from 'node:test'

import { createAuthManagerOpenClawEntry } from '../openclaw-entry.js'

test('entry registers only the service and does not depend on llm_output hooks', async () => {
  let registeredService:
    | {
        start: (ctx: { config?: Record<string, unknown>; env?: NodeJS.ProcessEnv }) => void | Promise<void>
        stop?: () => void | Promise<void>
      }
    | undefined
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.endsWith('/api/leases/lease_1')) {
      return new Response(
        JSON.stringify({
          lease_id: 'lease_1',
          credential_id: 'cred_1',
          machine_id: 'openclaw',
          agent_id: 'openclaw',
          state: 'active',
          issued_at: '2026-03-25T15:00:00.000Z',
          expires_at: '2026-03-25T16:00:00.000Z',
          renewed_at: null,
          revoked_at: null,
          released_at: null,
          replacement_lease_id: null,
          latest_utilization_pct: 22,
          latest_quota_remaining: null,
          last_seen_at: '2026-03-25T15:00:00.000Z',
          last_telemetry_at: null,
          last_success_at: null,
          last_error_at: null,
          reason: null,
          metadata: null,
          created_at: '2026-03-25T15:00:00.000Z',
          updated_at: '2026-03-25T15:00:00.000Z',
        }),
        { status: 200 },
      )
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof fetch

  try {
    const entry = createAuthManagerOpenClawEntry()
    entry.register({
      logger: { info() {}, warn() {}, error() {} },
      registerService(service) {
        registeredService = service
      },
      registerHook(events, handler, options) {
        void events
        void handler
        void options
      },
    })

    assert.ok(registeredService)

    await registeredService.start({
      config: {
        baseUrl: 'http://127.0.0.1:8080',
        internalApiToken: 'secret',
        machineId: 'openclaw',
        agentId: 'openclaw',
        leaseId: 'lease_1',
        flushEveryRequests: 99,
        refreshIntervalMs: 60_000,
        flushIntervalMs: 60_000,
        requestedTtlSeconds: 1800,
        allowInsecureLocalhost: true,
        enabled: true,
        authFilePath: '/tmp/openclaw-auth.json',
        leaseProfileId: 'openai-codex:lease',
        enforceLeaseAsActiveAuth: false,
        disallowNonLeaseAuth: false,
        purgeNonLeaseProfilesOnStart: false,
        autoRenew: false,
        autoRotate: false,
        rotationPolicy: 'replacement_required_only',
        releaseLeaseOnShutdown: false,
        usageExportJsonPath: null,
      },
      env: {
        AUTH_MANAGER_BASE_URL: 'http://127.0.0.1:8080',
        AUTH_MANAGER_INTERNAL_API_TOKEN: 'secret',
      },
    })

    await registeredService.stop?.()
  } finally {
    globalThis.fetch = originalFetch
  }
})
