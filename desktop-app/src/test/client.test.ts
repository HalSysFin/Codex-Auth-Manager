import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBackendErrorPayload } from '../../../packages/lease-runtime/src/authManagerClient.ts'

test('normalizeBackendErrorPayload prefers detail', () => {
  assert.deepEqual(normalizeBackendErrorPayload({ detail: 'Bad token' }), { message: 'Bad token' })
})

test('normalizeBackendErrorPayload falls back to reason', () => {
  assert.deepEqual(normalizeBackendErrorPayload({ reason: 'no_eligible_credentials_available' }), {
    message: 'no_eligible_credentials_available',
    code: 'no_eligible_credentials_available',
  })
})
