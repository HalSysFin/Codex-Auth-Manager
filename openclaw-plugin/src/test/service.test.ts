import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { createOpenClawLeaseTelemetryService } from '../service.js'

test('service flushes after request threshold', async () => {
  let telemetryPosts = 0
  let postedBody: Record<string, unknown> | null = null
  const service = createOpenClawLeaseTelemetryService({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'secret',
    allowInsecureLocalhost: true,
    context: {
      leaseId: 'lease_1',
      machineId: 'machine-a',
      agentId: 'openclaw',
    },
    flushEveryRequests: 2,
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url.endsWith('/telemetry')) {
        telemetryPosts += 1
        postedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      }
      if (url.endsWith('/lease_1')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            lease_id: 'lease_1',
            state: 'active',
            credential_id: 'cred_1',
            machine_id: 'machine-a',
            agent_id: 'openclaw',
            expires_at: '2026-03-26T11:00:00.000Z',
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  service.observeUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  service.observeUsage({ usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(telemetryPosts, 1)
  assert.ok(postedBody)
  const body = postedBody as unknown as Record<string, unknown>
  assert.equal(body.requests_count, 2)
  assert.equal(body.tokens_in, 30)
  assert.equal(body.tokens_out, 11)
})

test('changing lease context resets pending totals before the next flush', async () => {
  const leasePosts: Array<{ leaseId: string; body: Record<string, unknown> }> = []
  const service = createOpenClawLeaseTelemetryService({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'secret',
    allowInsecureLocalhost: true,
    context: {
      leaseId: 'lease_1',
      machineId: 'machine-a',
      agentId: 'openclaw',
    },
    flushEveryRequests: 99,
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url.endsWith('/telemetry')) {
        leasePosts.push({
          leaseId: url.split('/').at(-2) ?? 'unknown',
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        })
      }
      if (url.endsWith('/lease_2')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            lease_id: 'lease_2',
            state: 'active',
            credential_id: 'cred_2',
            machine_id: 'machine-a',
            agent_id: 'openclaw',
            expires_at: '2026-03-26T11:00:00.000Z',
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  service.observeUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  service.setLeaseContext({
    leaseId: 'lease_2',
    machineId: 'machine-a',
    agentId: 'openclaw',
  })
  service.observeUsage({ usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })
  await service.flushNow()

  assert.equal(leasePosts.length, 1)
  assert.equal(leasePosts[0].leaseId, 'lease_2')
  assert.equal(leasePosts[0].body.requests_count, 1)
  assert.equal(leasePosts[0].body.tokens_in, 7)
  assert.equal(leasePosts[0].body.tokens_out, 3)
})

test('stop flushes outstanding telemetry once before shutting down', async () => {
  const posts: Array<Record<string, unknown>> = []
  const service = createOpenClawLeaseTelemetryService({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'secret',
    allowInsecureLocalhost: true,
    context: {
      leaseId: 'lease_1',
      machineId: 'machine-a',
      agentId: 'openclaw',
    },
    flushEveryRequests: 99,
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url.endsWith('/telemetry')) {
        posts.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      }
      if (url.endsWith('/lease_1')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            lease_id: 'lease_1',
            state: 'active',
            credential_id: 'cred_1',
            machine_id: 'machine-a',
            agent_id: 'openclaw',
            expires_at: '2026-03-26T11:00:00.000Z',
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  service.observeUsage({ usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } })
  await service.flushNow()
  service.stop()

  assert.equal(posts.length, 1)
  assert.equal(posts[0].requests_count, 1)
  assert.equal(posts[0].tokens_in, 9)
  assert.equal(posts[0].tokens_out, 4)
})

test('service start acquires a lease and writes flattened OpenClaw auth.json', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-plugin-'))
  const originalHome = process.env.HOME
  process.env.HOME = tempDir
  const calls: string[] = []
  try {
    const service = createOpenClawLeaseTelemetryService({
      baseUrl: 'http://127.0.0.1:8080',
      internalApiToken: 'secret',
      allowInsecureLocalhost: true,
      authFilePath: path.join(tempDir, 'unused-auth.json'),
      releaseLeaseOnShutdown: false,
      context: {
        leaseId: 'lease_missing',
        machineId: 'machine-a',
        agentId: 'openclaw',
      },
      fetchImpl: async (input, init) => {
        const url = String(input)
        calls.push(`${init?.method ?? 'GET'} ${url}`)
        if (url.endsWith('/api/leases/lease_missing')) {
          return new Response(JSON.stringify({ detail: 'Lease not found' }), { status: 404 })
        }
        if (url.endsWith('/api/leases/acquire')) {
          return new Response(
            JSON.stringify({
              status: 'ok',
              reason: null,
              lease: {
                id: 'lease_new',
                credential_id: 'cred_1',
                machine_id: 'machine-a',
                agent_id: 'openclaw',
                state: 'active',
                issued_at: '2026-03-24T00:00:00.000Z',
                expires_at: '2026-03-24T00:30:00.000Z',
                renewed_at: null,
                revoked_at: null,
                released_at: null,
                rotation_reason: null,
                replacement_lease_id: null,
                last_seen_at: '2026-03-24T00:00:00.000Z',
                last_telemetry_at: null,
                latest_utilization_pct: 5,
                latest_quota_remaining: 95,
                last_success_at: null,
                last_error_at: null,
                reason: null,
                metadata: null,
                created_at: '2026-03-24T00:00:00.000Z',
                updated_at: '2026-03-24T00:00:00.000Z',
              },
            }),
            { status: 200 },
          )
        }
        if (url.endsWith('/api/leases/lease_new/materialize')) {
          return new Response(
            JSON.stringify({
              status: 'ok',
              reason: null,
              lease: {
                id: 'lease_new',
                credential_id: 'cred_1',
                machine_id: 'machine-a',
                agent_id: 'openclaw',
                state: 'active',
                issued_at: '2026-03-24T00:00:00.000Z',
                expires_at: '2026-03-24T00:30:00.000Z',
                renewed_at: null,
                revoked_at: null,
                released_at: null,
                rotation_reason: null,
                replacement_lease_id: null,
                last_seen_at: '2026-03-24T00:00:00.000Z',
                last_telemetry_at: null,
                latest_utilization_pct: 5,
                latest_quota_remaining: 95,
                last_success_at: null,
                last_error_at: null,
                reason: null,
                metadata: null,
                created_at: '2026-03-24T00:00:00.000Z',
                updated_at: '2026-03-24T00:00:00.000Z',
              },
              credential_material: {
                label: 'test',
                openclaw: {
                  profile_id: 'openai-codex:lease',
                  openclaw_auth_json: {
                    'agents.defaults.models.openai-codex/gpt-5.4': {},
                    'auth.order.openai-codex': ['openai-codex:lease'],
                    'auth.profiles.openai-codex:lease': {
                      provider: 'openai-codex',
                      mode: 'oauth',
                    },
                    openai_cid_tokens: {
                      'openai-codex:lease': {
                        access_token: 'access-token',
                        refresh_token: 'refresh-token',
                        id_token: null,
                        expires_at_ms: 1_900_000_000_000,
                        accountId: 'acct-1',
                        provider: 'openai-codex',
                        type: 'oauth',
                      },
                    },
                  },
                },
              },
            }),
            { status: 200 },
          )
        }
        throw new Error(`Unexpected request: ${url}`)
      },
      logger: { info() {}, warn() {}, error() {} },
    })

    await service.start()
    await service.shutdown()

    const authJson = JSON.parse(
      await fs.readFile(path.join(tempDir, '.openclaw/auth.json'), 'utf8'),
    ) as Record<string, unknown>
    assert.deepEqual(authJson['auth.order.openai-codex'], ['openai-codex:lease'])
    assert.equal(
      ((authJson.openai_cid_tokens as Record<string, unknown>)['openai-codex:lease'] as Record<string, unknown>).accountId,
      'acct-1',
    )
    assert.ok(calls.some((entry) => entry.includes('/api/leases/acquire')))
    assert.ok(calls.some((entry) => entry.includes('/materialize')))
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('service materializes auth from core auth_json when openclaw material is absent', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-plugin-'))
  const originalHome = process.env.HOME
  process.env.HOME = tempDir
  try {
    const service = createOpenClawLeaseTelemetryService({
      baseUrl: 'http://127.0.0.1:8080',
      internalApiToken: 'secret',
      allowInsecureLocalhost: true,
      releaseLeaseOnShutdown: false,
      context: {
        leaseId: 'lease_missing',
        machineId: 'machine-a',
        agentId: 'main',
      },
      fetchImpl: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/api/leases/lease_missing')) {
          return new Response(JSON.stringify({ detail: 'Lease not found' }), { status: 404 })
        }
        if (url.endsWith('/api/leases/acquire')) {
          return new Response(
            JSON.stringify({
              status: 'ok',
              reason: null,
              lease: {
                id: 'lease_new',
                credential_id: 'cred_1',
                machine_id: 'machine-a',
                agent_id: 'main',
                state: 'active',
                issued_at: '2026-03-24T00:00:00.000Z',
                expires_at: '2026-03-24T00:30:00.000Z',
                renewed_at: null,
                revoked_at: null,
                released_at: null,
                rotation_reason: null,
                replacement_lease_id: null,
                last_seen_at: '2026-03-24T00:00:00.000Z',
                last_telemetry_at: null,
                latest_utilization_pct: 5,
                latest_quota_remaining: 95,
                last_success_at: null,
                last_error_at: null,
                reason: null,
                metadata: null,
                created_at: '2026-03-24T00:00:00.000Z',
                updated_at: '2026-03-24T00:00:00.000Z',
              },
            }),
            { status: 200 },
          )
        }
        if (url.endsWith('/api/leases/lease_new/materialize')) {
          const payload = {
            auth_mode: 'oauth',
            OPENAI_API_KEY: null,
            tokens: {
              id_token: null,
              access_token:
                'eyJhbGciOiJub25lIn0.eyJleHAiOjE5MDAwMDAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vcHJvZmlsZSI6eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifX0.',
              refresh_token: 'refresh-token',
              account_id: 'acct-1',
            },
          }
          return new Response(
            JSON.stringify({
              status: 'ok',
              reason: null,
              lease: {
                id: 'lease_new',
                credential_id: 'cred_1',
                machine_id: 'machine-a',
                agent_id: 'main',
                state: 'active',
                issued_at: '2026-03-24T00:00:00.000Z',
                expires_at: '2026-03-24T00:30:00.000Z',
                renewed_at: null,
                revoked_at: null,
                released_at: null,
                rotation_reason: null,
                replacement_lease_id: null,
                last_seen_at: '2026-03-24T00:00:00.000Z',
                last_telemetry_at: null,
                latest_utilization_pct: 5,
                latest_quota_remaining: 95,
                last_success_at: null,
                last_error_at: null,
                reason: null,
                metadata: null,
                created_at: '2026-03-24T00:00:00.000Z',
                updated_at: '2026-03-24T00:00:00.000Z',
              },
              credential_material: {
                label: 'test',
                auth_json: payload,
                openclaw: {},
              },
            }),
            { status: 200 },
          )
        }
        throw new Error(`Unexpected request: ${url}`)
      },
      logger: { info() {}, warn() {}, error() {} },
    })

    await service.start()
    await service.shutdown()

    const authJson = JSON.parse(
      await fs.readFile(path.join(tempDir, '.openclaw/auth.json'), 'utf8'),
    ) as Record<string, unknown>
    assert.deepEqual(authJson['auth.order.openai-codex'], ['openai-codex:lease'])
    assert.equal(
      ((authJson.openai_cid_tokens as Record<string, unknown>)['openai-codex:lease'] as Record<string, unknown>).accountId,
      'acct-1',
    )
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('service materializes auth from top-level token fields when nested tokens are absent', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-plugin-'))
  const originalHome = process.env.HOME
  process.env.HOME = tempDir
  try {
    const service = createOpenClawLeaseTelemetryService({
      baseUrl: 'http://127.0.0.1:8080',
      internalApiToken: 'secret',
      allowInsecureLocalhost: true,
      releaseLeaseOnShutdown: false,
      context: {
        leaseId: 'lease_missing',
        machineId: 'machine-a',
        agentId: 'main',
      },
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/api/leases/lease_missing')) {
          return new Response(JSON.stringify({ detail: 'Lease not found' }), { status: 404 })
        }
        if (url.endsWith('/api/leases/acquire')) {
          return new Response(
            JSON.stringify({
              status: 'ok',
              reason: null,
              lease: {
                id: 'lease_new',
                credential_id: 'cred_1',
                machine_id: 'machine-a',
                agent_id: 'main',
                state: 'active',
                issued_at: '2026-03-24T00:00:00.000Z',
                expires_at: '2026-03-24T00:30:00.000Z',
                renewed_at: null,
                revoked_at: null,
                released_at: null,
                rotation_reason: null,
                replacement_lease_id: null,
                last_seen_at: '2026-03-24T00:00:00.000Z',
                last_telemetry_at: null,
                latest_utilization_pct: 5,
                latest_quota_remaining: 95,
                last_success_at: null,
                last_error_at: null,
                reason: null,
                metadata: null,
                created_at: '2026-03-24T00:00:00.000Z',
                updated_at: '2026-03-24T00:00:00.000Z',
              },
            }),
            { status: 200 },
          )
        }
        if (url.endsWith('/api/leases/lease_new/materialize')) {
          const payload = {
            auth_mode: 'oauth',
            OPENAI_API_KEY: null,
            access_token:
              'eyJhbGciOiJub25lIn0.eyJleHAiOjE5MDAwMDAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vcHJvZmlsZSI6eyJlbWFpbCI6InRvcGxldmVsQGV4YW1wbGUuY29tIn19.',
            refresh_token: 'refresh-token',
            accountId: 'acct-2',
            id_token: null,
          }
          return new Response(
            JSON.stringify({
              status: 'ok',
              reason: null,
              lease: {
                id: 'lease_new',
                credential_id: 'cred_1',
                machine_id: 'machine-a',
                agent_id: 'main',
                state: 'active',
                issued_at: '2026-03-24T00:00:00.000Z',
                expires_at: '2026-03-24T00:30:00.000Z',
                renewed_at: null,
                revoked_at: null,
                released_at: null,
                rotation_reason: null,
                replacement_lease_id: null,
                last_seen_at: '2026-03-24T00:00:00.000Z',
                last_telemetry_at: null,
                latest_utilization_pct: 5,
                latest_quota_remaining: 95,
                last_success_at: null,
                last_error_at: null,
                reason: null,
                metadata: null,
                created_at: '2026-03-24T00:00:00.000Z',
                updated_at: '2026-03-24T00:00:00.000Z',
              },
              credential_material: {
                label: 'test',
                auth_json: payload,
                openclaw: {},
              },
            }),
            { status: 200 },
          )
        }
        throw new Error(`Unexpected request: ${url}`)
      },
      logger: { info() {}, warn() {}, error() {} },
    })

    await service.start()
    await service.shutdown()

    const authJson = JSON.parse(
      await fs.readFile(path.join(tempDir, '.openclaw/auth.json'), 'utf8'),
    ) as Record<string, unknown>
    assert.deepEqual(authJson['auth.order.openai-codex'], ['openai-codex:lease'])
    assert.equal(
      ((authJson.openai_cid_tokens as Record<string, unknown>)['openai-codex:lease'] as Record<string, unknown>).accountId,
      'acct-2',
    )
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('service uploads usage JSON only when the file content changes', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-usage-json-'))
  const usagePath = path.join(tempDir, 'usage.json')
  await fs.writeFile(
    usagePath,
    JSON.stringify({
      totals: { totalTokens: 10 },
      daily: [{ date: '2026-03-25', totalTokens: 10 }],
      sessions: [{ key: 'sess-1', agentId: 'main', totalTokens: 10 }],
    }),
    'utf8',
  )

  const importBodies: Array<Record<string, unknown>> = []
  const service = createOpenClawLeaseTelemetryService({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'secret',
    allowInsecureLocalhost: true,
    context: {
      leaseId: 'lease_1',
      machineId: 'machine-a',
      agentId: 'openclaw:main',
    },
    autoRenew: false,
    autoRotate: false,
    usageExportJsonPath: usagePath,
    refreshIntervalMs: 20,
    flushIntervalMs: 60_000,
    flushEveryRequests: 99,
    releaseLeaseOnShutdown: false,
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/leases/lease_1')) {
        return new Response(
          JSON.stringify({
            lease_id: 'lease_1',
            credential_id: 'cred_1',
            machine_id: 'machine-a',
            agent_id: 'openclaw:main',
            state: 'active',
            issued_at: '2026-03-26T15:00:00.000Z',
            expires_at: '2026-03-26T16:00:00.000Z',
            renewed_at: null,
            revoked_at: null,
            released_at: null,
            replacement_lease_id: null,
            latest_utilization_pct: 22,
            latest_quota_remaining: null,
            last_seen_at: '2026-03-26T15:00:00.000Z',
            last_telemetry_at: null,
            last_success_at: null,
            last_error_at: null,
            reason: null,
            credential_state: 'leased',
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/api/openclaw/usage/import')) {
        importBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return new Response(JSON.stringify({ status: 'ok', imported: true }), { status: 200 })
      }
      throw new Error(`Unexpected request: ${url}`)
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  try {
    await service.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(importBodies.length, 1)
    assert.equal(importBodies[0].machine_id, 'machine-a')
    assert.equal(importBodies[0].agent_id, 'openclaw:main')
    assert.equal(importBodies[0].lease_id, 'lease_1')
    assert.equal(importBodies[0].credential_id, 'cred_1')
    assert.equal(importBodies[0].source_name, 'usage.json')

    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(importBodies.length, 1)

    await fs.writeFile(
      usagePath,
      JSON.stringify({
        totals: { totalTokens: 12 },
        daily: [{ date: '2026-03-25', totalTokens: 12 }],
        sessions: [{ key: 'sess-1', agentId: 'main', totalTokens: 12 }],
      }),
      'utf8',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(importBodies.length, 2)
  } finally {
    await service.shutdown()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('manual lease control exposes structured status and mutable auto settings', async () => {
  const service = createOpenClawLeaseTelemetryService({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'secret',
    allowInsecureLocalhost: true,
    releaseLeaseOnShutdown: false,
    autoRenew: true,
    autoRotate: false,
    context: {
      leaseId: 'lease_1',
      machineId: 'machine-a',
      agentId: 'openclaw',
    },
    fetchImpl: async (input) => {
      const url = String(input)
      if (url.endsWith('/api/leases/lease_1')) {
        return new Response(
          JSON.stringify({
            lease_id: 'lease_1',
            credential_id: 'cred_1',
            machine_id: 'machine-a',
            agent_id: 'openclaw',
            state: 'active',
            issued_at: '2026-03-26T10:00:00.000Z',
            expires_at: '2026-03-26T11:00:00.000Z',
            renewed_at: null,
            last_success_at: null,
            last_error_at: null,
            latest_telemetry_at: null,
            latest_utilization_pct: 12,
            latest_quota_remaining: 88,
            rotation_recommended: false,
            replacement_required: false,
            reason: null,
            credential_state: 'active',
          }),
          { status: 200 },
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  const before = await service.getLeaseStatus()
  assert.equal(before.ok, true)
  assert.equal(before.status.leaseId, 'lease_1')
  assert.equal(before.status.autoRenew, true)
  assert.equal(before.status.autoRotate, false)
  assert.equal(before.status.utilizationPct, 12)
  assert.equal(before.status.quotaRemaining, 88)

  const updated = await service.setAutomaticLeaseManagement({ autoRenew: false, autoRotate: true })
  assert.equal(updated.ok, true)
  assert.equal(updated.status.autoRenew, false)
  assert.equal(updated.status.autoRotate, true)
})

test('manual release flushes telemetry before releasing the lease', async () => {
  const calls: string[] = []
  const service = createOpenClawLeaseTelemetryService({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'secret',
    allowInsecureLocalhost: true,
    releaseLeaseOnShutdown: false,
    context: {
      leaseId: 'lease_1',
      machineId: 'machine-a',
      agentId: 'openclaw',
    },
    fetchImpl: async (input, init) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/telemetry')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
      }
      if (url.endsWith('/release')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            reason: null,
            lease: {
              id: 'lease_1',
              credential_id: 'cred_1',
              machine_id: 'machine-a',
              agent_id: 'openclaw',
              state: 'released',
              issued_at: '2026-03-26T10:00:00.000Z',
              expires_at: '2026-03-26T11:00:00.000Z',
              renewed_at: null,
              revoked_at: null,
              released_at: '2026-03-26T10:30:00.000Z',
              rotation_reason: null,
              replacement_lease_id: null,
              last_seen_at: null,
              last_telemetry_at: null,
              latest_utilization_pct: 10,
              latest_quota_remaining: 90,
              last_success_at: null,
              last_error_at: null,
              reason: null,
              metadata: null,
              created_at: '2026-03-26T10:00:00.000Z',
              updated_at: '2026-03-26T10:30:00.000Z',
            },
          }),
          { status: 200 },
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  service.observeUsage({ usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } })
  const result = await service.releaseLeaseNow('manual_release')

  assert.equal(result.ok, true)
  assert.equal(result.status.leaseId, null)
  const mutatingCalls = calls.filter((entry) => /\/telemetry$|\/release$/.test(entry))
  assert.equal(mutatingCalls.length, 2)
  assert.match(mutatingCalls[0], /\/telemetry$/)
  assert.match(mutatingCalls[1], /\/release$/)
})

test('concurrent manual lease mutations are rejected cleanly', async () => {
  let releaseRenew!: () => void
  const renewBarrier = new Promise<void>((resolve) => {
    releaseRenew = resolve
  })
  const service = createOpenClawLeaseTelemetryService({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'secret',
    allowInsecureLocalhost: true,
    releaseLeaseOnShutdown: false,
    context: {
      leaseId: 'lease_1',
      machineId: 'machine-a',
      agentId: 'openclaw',
    },
    fetchImpl: async (input) => {
      const url = String(input)
      if (url.endsWith('/renew')) {
        await renewBarrier
        return new Response(
          JSON.stringify({
            status: 'ok',
            reason: null,
            lease: {
              id: 'lease_1',
              credential_id: 'cred_1',
              machine_id: 'machine-a',
              agent_id: 'openclaw',
              state: 'active',
              issued_at: '2026-03-26T10:00:00.000Z',
              expires_at: '2026-03-26T11:30:00.000Z',
              renewed_at: '2026-03-26T10:30:00.000Z',
              revoked_at: null,
              released_at: null,
              rotation_reason: null,
              replacement_lease_id: null,
              last_seen_at: null,
              last_telemetry_at: null,
              latest_utilization_pct: 10,
              latest_quota_remaining: 90,
              last_success_at: null,
              last_error_at: null,
              reason: null,
              metadata: null,
              created_at: '2026-03-26T10:00:00.000Z',
              updated_at: '2026-03-26T10:30:00.000Z',
            },
          }),
          { status: 200 },
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  const renewPromise = service.renewLeaseNow('manual_renew')
  const concurrentResult = await service.rotateLeaseNow('manual_rotate')
  releaseRenew()
  const renewResult = await renewPromise

  assert.equal(renewResult.ok, true)
  assert.equal(concurrentResult.ok, false)
  assert.equal(concurrentResult.error?.code, 'concurrent_operation')
})

test('service skips usage import cleanly when no usage path is set and openclaw export command is unavailable', async () => {
  const importBodies: Array<Record<string, unknown>> = []
  const service = createOpenClawLeaseTelemetryService({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'secret',
    allowInsecureLocalhost: true,
    context: {
      leaseId: 'lease_1',
      machineId: 'machine-a',
      agentId: 'openclaw:main',
    },
    refreshIntervalMs: 20,
    flushIntervalMs: 60_000,
    flushEveryRequests: 99,
    releaseLeaseOnShutdown: false,
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/leases/lease_1')) {
        return new Response(
          JSON.stringify({
            lease_id: 'lease_1',
            credential_id: 'cred_1',
            machine_id: 'machine-a',
            agent_id: 'openclaw:main',
            state: 'active',
            issued_at: '2026-03-26T15:00:00.000Z',
            expires_at: '2026-03-26T16:00:00.000Z',
            renewed_at: null,
            revoked_at: null,
            released_at: null,
            replacement_lease_id: null,
            latest_utilization_pct: 22,
            latest_quota_remaining: null,
            last_seen_at: '2026-03-26T15:00:00.000Z',
            last_telemetry_at: null,
            last_success_at: null,
            last_error_at: null,
            reason: null,
            credential_state: 'leased',
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/api/openclaw/usage/import')) {
        importBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return new Response(JSON.stringify({ status: 'ok', imported: true }), { status: 200 })
      }
      throw new Error(`Unexpected request: ${url}`)
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  try {
    await service.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(importBodies.length, 0)
  } finally {
    await service.shutdown()
  }
})
