import test from 'node:test'
import assert from 'node:assert/strict'
import { expandHomePath, prepareAuthPayloadForWrite, validateAuthPayload } from '../../../packages/lease-runtime/src/authPayload.ts'

test('validateAuthPayload accepts the expected auth shape', () => {
  assert.equal(validateAuthPayload({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: 'id',
      access_token: 'access',
      refresh_token: 'refresh',
      account_id: 'account',
    },
  }), true)
})

test('prepareAuthPayloadForWrite fills last_refresh when missing', () => {
  const result = prepareAuthPayloadForWrite({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: 'id',
      access_token: 'access',
      refresh_token: 'refresh',
      account_id: 'account',
    },
  }, '2026-03-22T00:00:00.000Z')
  assert.equal(result.last_refresh, '2026-03-22T00:00:00.000Z')
})

test('expandHomePath expands leading tilde with provided home dir', () => {
  assert.equal(expandHomePath('~/.codex/auth.json', '/home/tester'), '/home/tester/.codex/auth.json')
})
