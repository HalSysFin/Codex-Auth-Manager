import assert from 'node:assert/strict'
import test from 'node:test'

import { createOpenClawLeaseTelemetryService } from '../service.js'

test('service flushes after request threshold', async () => {
  let posts = 0
  let postedBody: Record<string, unknown> | null = null
  const service = createOpenClawLeaseTelemetryService({
    baseUrl: 'http://127.0.0.1:8080',
    apiKey: 'secret',
    context: {
      leaseId: 'lease_1',
      machineId: 'machine-a',
      agentId: 'openclaw',
    },
    flushEveryRequests: 2,
    fetchImpl: async (_input, init) => {
      posts += 1
      postedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  service.observeUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  service.observeUsage({ usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(posts, 1)
  assert.ok(postedBody)
  const body = postedBody as unknown as Record<string, unknown>
  assert.equal(body.requests_count, 2)
  assert.equal(body.tokens_in, 30)
  assert.equal(body.tokens_out, 11)
})
