import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBackendErrorPayload } from '../authManagerClient'
import { AuthManagerClient, AuthManagerClientError } from '../authManagerClient'

test('normalizeBackendErrorPayload prefers detail', () => {
  assert.deepEqual(normalizeBackendErrorPayload({ detail: 'Bad token' }), { message: 'Bad token' })
})

test('normalizeBackendErrorPayload falls back to reason', () => {
  assert.deepEqual(normalizeBackendErrorPayload({ reason: 'no_eligible_credentials_available' }), {
    message: 'no_eligible_credentials_available',
    code: 'no_eligible_credentials_available',
  })
})

test('materialize uses shared materialize endpoint path', async () => {
  let requestedUrl = ''
  let authHeader = ''
  const client = new AuthManagerClient({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'secret-token',
    allowInsecureLocalhost: true,
    fetchImpl: async (input, init) => {
      requestedUrl = String(input)
      authHeader = String((init?.headers as Record<string, string>).Authorization)
      return new Response(JSON.stringify({ status: 'ok', reason: null, lease: null, credential_material: null }), { status: 200 })
    },
  })

  await client.fetchAuthPayloadForLease('lease-123', {
    machineId: 'machine-a',
    agentId: 'vscode-extension',
  })

  assert.equal(requestedUrl, 'http://127.0.0.1:8080/api/leases/lease-123/materialize')
  assert.equal(authHeader, 'Bearer secret-token')
})

test('reconcileLeaseAuth uses the shared reconcile endpoint path', async () => {
  let requestedUrl = ''
  const client = new AuthManagerClient({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'secret-token',
    allowInsecureLocalhost: true,
    fetchImpl: async (input) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({ status: 'ok', decision: 'in_sync', reason: 'auth_in_sync' }), { status: 200 })
    },
  })

  await client.reconcileLeaseAuth('lease-123', {
    machineId: 'machine-a',
    agentId: 'vscode-extension',
    authJson: {
      auth_mode: 'oauth',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'id',
        access_token: 'access',
        refresh_token: 'refresh',
        account_id: 'acct',
      },
      last_refresh: '2026-03-23T00:00:00.000Z',
    },
  })

  assert.equal(requestedUrl, 'http://127.0.0.1:8080/api/leases/lease-123/reconcile-auth')
})

test('shared client surfaces invalid bearer token responses', async () => {
  const client = new AuthManagerClient({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'bad-token',
    allowInsecureLocalhost: true,
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'Invalid bearer token' }), { status: 403 }),
  })

  await assert.rejects(
    client.getLease('lease-123'),
    (error: unknown) => error instanceof AuthManagerClientError && error.status === 403 && error.message === 'Invalid bearer token',
  )
})

test('shared client handles missing bearer token responses', async () => {
  const client = new AuthManagerClient({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: '',
    allowInsecureLocalhost: true,
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'Missing bearer token' }), { status: 401 }),
  })

  await assert.rejects(
    client.acquireLease({
      machineId: 'machine-a',
      agentId: 'vscode-extension',
    }),
    (error: unknown) => error instanceof AuthManagerClientError && error.status === 401 && error.message === 'Missing bearer token',
  )
})

test('rate-limit reset methods remain scoped to the active lease owner', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const client = new AuthManagerClient({
    baseUrl: 'http://127.0.0.1:8080',
    allowInsecureLocalhost: true,
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
      })
      return new Response(JSON.stringify({
        status: 'ok',
        lease_id: 'lease-123',
        credential_id: 'account-1',
        available_count: 1,
        credits: [],
        rate_limits: {},
        fetched_at: '2026-07-16T00:00:00Z',
        outcome: 'reset',
        idempotency_key: 'redeem-123',
      }), { status: 200 })
    },
  })

  await client.getRateLimitResets('lease-123', { machineId: 'machine-a', agentId: 'vscode-extension' })
  await client.consumeRateLimitReset('lease-123', {
    machineId: 'machine-a',
    agentId: 'vscode-extension',
    idempotencyKey: 'redeem-123',
    creditId: 'credit-1',
  })

  assert.equal(requests[0].url, 'http://127.0.0.1:8080/api/leases/lease-123/rate-limit-resets/read')
  assert.deepEqual(requests[0].body, { machine_id: 'machine-a', agent_id: 'vscode-extension' })
  assert.equal(requests[1].url, 'http://127.0.0.1:8080/api/leases/lease-123/rate-limit-resets/consume')
  assert.deepEqual(requests[1].body, {
    machine_id: 'machine-a',
    agent_id: 'vscode-extension',
    idempotency_key: 'redeem-123',
    credit_id: 'credit-1',
  })
})
