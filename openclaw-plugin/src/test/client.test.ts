import assert from 'node:assert/strict'
import test from 'node:test'

import { AuthManagerTelemetryClient } from '../client.js'

test('telemetry client sends Authorization bearer header from internalApiToken', async () => {
  let authHeader = ''
  const client = new AuthManagerTelemetryClient({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'secret-token',
    allowInsecureLocalhost: true,
    fetchImpl: async (_input, init) => {
      authHeader = String((init?.headers as Record<string, string>).Authorization)
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    },
  })

  await client.postLeaseTelemetry(
    { leaseId: 'lease-1', machineId: 'machine-a', agentId: 'openclaw' },
    {
      machine_id: 'machine-a',
      agent_id: 'openclaw',
      captured_at: '2026-03-23T00:00:00.000Z',
      status: 'healthy',
    },
  )

  assert.equal(authHeader, 'Bearer secret-token')
})

test('telemetry client surfaces missing token responses cleanly', async () => {
  const client = new AuthManagerTelemetryClient({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: '',
    allowInsecureLocalhost: true,
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'Missing bearer token' }), { status: 401 }),
  })

  await assert.rejects(
    client.postLeaseTelemetry(
      { leaseId: 'lease-1', machineId: 'machine-a', agentId: 'openclaw' },
      {
        machine_id: 'machine-a',
        agent_id: 'openclaw',
        captured_at: '2026-03-23T00:00:00.000Z',
        status: 'healthy',
      },
    ),
    /Missing bearer token/,
  )
})

test('reset read and consume calls remain scoped to the active lease identity', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const client = new AuthManagerTelemetryClient({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'secret-token',
    allowInsecureLocalhost: true,
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown> })
      return new Response(JSON.stringify({
        status: 'ok', lease_id: 'lease-1', credential_id: 'cred-1', available_count: 1,
        credits: [], rate_limits: {}, fetched_at: '2026-07-16T00:00:00Z', outcome: 'reset',
        idempotency_key: 'redeem-1',
      }), { status: 200 })
    },
  })
  const context = { leaseId: 'lease-1', machineId: 'machine-a', agentId: 'openclaw' }

  await client.getRateLimitResets(context)
  await client.consumeRateLimitReset(context, { idempotencyKey: 'redeem-1', creditId: 'credit-1' })

  assert.equal(requests[0].url, 'http://127.0.0.1:8080/api/leases/lease-1/rate-limit-resets/read')
  assert.deepEqual(requests[0].body, { machine_id: 'machine-a', agent_id: 'openclaw' })
  assert.equal(requests[1].url, 'http://127.0.0.1:8080/api/leases/lease-1/rate-limit-resets/consume')
  assert.deepEqual(requests[1].body, {
    machine_id: 'machine-a', agent_id: 'openclaw', idempotency_key: 'redeem-1', credit_id: 'credit-1',
  })
})
