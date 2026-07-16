import test from 'node:test'
import assert from 'node:assert/strict'
import { AuthManagerClient, normalizeBackendErrorPayload } from '../../../packages/lease-runtime/src/authManagerClient.ts'

test('normalizeBackendErrorPayload prefers detail', () => {
  assert.deepEqual(normalizeBackendErrorPayload({ detail: 'Bad token' }), { message: 'Bad token' })
})

test('normalizeBackendErrorPayload falls back to reason', () => {
  assert.deepEqual(normalizeBackendErrorPayload({ reason: 'no_eligible_credentials_available' }), {
    message: 'no_eligible_credentials_available',
    code: 'no_eligible_credentials_available',
  })
})

test('rate-limit reset requests are scoped to the active lease identity', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const client = new AuthManagerClient({
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

  await client.getRateLimitResets('lease-1', { machineId: 'machine-a', agentId: 'desktop-app' })
  await client.consumeRateLimitReset('lease-1', {
    machineId: 'machine-a', agentId: 'desktop-app', idempotencyKey: 'redeem-1', creditId: 'credit-1',
  })

  assert.equal(requests[0].url, 'http://127.0.0.1:8080/api/leases/lease-1/rate-limit-resets/read')
  assert.deepEqual(requests[0].body, { machine_id: 'machine-a', agent_id: 'desktop-app' })
  assert.equal(requests[1].url, 'http://127.0.0.1:8080/api/leases/lease-1/rate-limit-resets/consume')
  assert.deepEqual(requests[1].body, {
    machine_id: 'machine-a', agent_id: 'desktop-app', idempotency_key: 'redeem-1', credit_id: 'credit-1',
  })
})
