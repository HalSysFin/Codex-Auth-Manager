import assert from 'node:assert/strict'
import test from 'node:test'

import { resolvePluginConfig, validatePluginConfig } from '../config.js'

test('resolvePluginConfig prefers explicit config and applies defaults', () => {
  const config = resolvePluginConfig(
    {
      baseUrl: 'http://127.0.0.1:8080',
      apiKey: 'secret',
      machineId: 'machine-a',
      flushEveryRequests: 5,
    },
    {},
  )

  assert.equal(config.baseUrl, 'http://127.0.0.1:8080')
  assert.equal(config.apiKey, 'secret')
  assert.equal(config.machineId, 'machine-a')
  assert.equal(config.agentId, 'openclaw')
  assert.equal(config.flushEveryRequests, 5)
  assert.equal(config.enabled, true)
})

test('validatePluginConfig reports missing required fields', () => {
  const errors = validatePluginConfig({
    baseUrl: '',
    apiKey: '',
    machineId: '',
    agentId: '',
    flushIntervalMs: 500,
    flushEveryRequests: 0,
    enabled: true,
  })

  assert.ok(errors.includes('baseUrl is required'))
  assert.ok(errors.includes('apiKey is required'))
  assert.ok(errors.includes('machineId is required'))
  assert.ok(errors.includes('agentId is required'))
})
