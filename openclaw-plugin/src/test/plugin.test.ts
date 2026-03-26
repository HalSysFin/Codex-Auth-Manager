import assert from 'node:assert/strict'
import test from 'node:test'

import { createOpenClawAuthManagerPlugin } from '../plugin.js'
import { normalizeUsageEvent } from '../usage.js'

test('normalizeUsageEvent maps OpenAI-style usage fields', () => {
  const event = normalizeUsageEvent({
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
    },
    model: 'gpt-5.4',
    status: 'healthy',
  })

  assert.equal(event.requestsCount, 1)
  assert.equal(event.tokensIn, 120)
  assert.equal(event.tokensOut, 30)
  assert.equal(event.metadata?.model, 'gpt-5.4')
  assert.deepEqual(event.metadata?.openclaw_usage_raw, {
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
    },
    model: 'gpt-5.4',
    status: 'healthy',
  })
})

test('normalizeUsageEvent maps direct counter payloads', () => {
  const event = normalizeUsageEvent({
    requests_count: 2,
    tokens_in: 50,
    tokens_out: 10,
    source: 'openclaw',
  })

  assert.equal(event.requestsCount, 2)
  assert.equal(event.tokensIn, 50)
  assert.equal(event.tokensOut, 10)
  assert.equal(event.metadata?.source, 'openclaw')
})

test('normalizeUsageEvent ignores raw clone failures without breaking counters', () => {
  const raw = { requests_count: 1, tokens_in: 10, tokens_out: 5 } as Record<string, unknown>
  raw.self = raw

  const event = normalizeUsageEvent(raw)

  assert.equal(event.requestsCount, 1)
  assert.equal(event.tokensIn, 10)
  assert.equal(event.tokensOut, 5)
  assert.equal(event.metadata?.openclaw_usage_raw, undefined)
})

test('plugin aggregates usage and posts telemetry', async () => {
  let postedBody: Record<string, unknown> | null = null
  const plugin = createOpenClawAuthManagerPlugin({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'test-token',
    allowInsecureLocalhost: true,
    context: {
      leaseId: 'lease_123',
      machineId: 'machine-a',
      agentId: 'openclaw',
    },
    fetchImpl: async (_input, init) => {
      postedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  plugin.observeUsage({
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    model: 'gpt-5.4',
  })
  plugin.observeUsage({
    requests_count: 2,
    tokens_in: 50,
    tokens_out: 10,
    source: 'openclaw',
  })

  await plugin.flushTelemetry()

  assert.ok(postedBody)
  const body = postedBody as Record<string, unknown>
  assert.equal(body.machine_id, 'machine-a')
  assert.equal(body.agent_id, 'openclaw')
  assert.equal(body.requests_count, 3)
  assert.equal(body.tokens_in, 150)
  assert.equal(body.tokens_out, 50)
  assert.deepEqual(body.metadata, {
    model: 'gpt-5.4',
    source: 'openclaw',
    total_tokens: 140,
    usage_keys: ['completion_tokens', 'prompt_tokens', 'total_tokens'],
    openclaw_usage_events: [
      {
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
        model: 'gpt-5.4',
      },
      {
        requests_count: 2,
        tokens_in: 50,
        tokens_out: 10,
        source: 'openclaw',
      },
    ],
  })
})

test('plugin caps raw event buffer and keeps newest events', () => {
  const plugin = createOpenClawAuthManagerPlugin({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'test-token',
    allowInsecureLocalhost: true,
    context: {
      leaseId: 'lease_123',
      machineId: 'machine-a',
      agentId: 'openclaw',
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  for (let index = 0; index < 55; index += 1) {
    plugin.observeUsage({
      requests_count: 1,
      tokens_in: index,
      tokens_out: index + 1,
      source: 'openclaw',
      event_index: index,
    })
  }

  const pending = plugin.getPendingTotals()
  assert.equal(pending.rawEvents.length, 50)
  assert.equal(pending.rawEvents[0]?.event_index, 5)
  assert.equal(pending.rawEvents[49]?.event_index, 54)
})

test('successful flush resets buffered raw events', async () => {
  const plugin = createOpenClawAuthManagerPlugin({
    baseUrl: 'http://127.0.0.1:8080',
    internalApiToken: 'test-token',
    allowInsecureLocalhost: true,
    context: {
      leaseId: 'lease_123',
      machineId: 'machine-a',
      agentId: 'openclaw',
    },
    fetchImpl: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    logger: { info() {}, warn() {}, error() {} },
  })

  plugin.observeUsage({
    requests_count: 1,
    tokens_in: 10,
    tokens_out: 2,
    source: 'openclaw',
    event_index: 1,
  })

  assert.equal(plugin.getPendingTotals().rawEvents.length, 1)
  await plugin.flushTelemetry()
  assert.equal(plugin.getPendingTotals().rawEvents.length, 0)
  assert.equal(plugin.getPendingTotals().requestsCount, 0)
})
