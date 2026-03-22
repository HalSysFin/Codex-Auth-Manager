import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveLeaseHealthState, needsReacquire, shouldRenewLease, shouldRotateLease } from '../leaseLifecycle'

test('startup with no lease needs reacquire', () => {
  assert.equal(needsReacquire(null), true)
})

test('startup with active lease stays active', () => {
  const state = deriveLeaseHealthState({
    state: 'active',
    replacement_required: false,
    rotation_recommended: false,
    expires_at: '2099-01-01T00:00:00.000Z',
  }, new Date('2026-03-22T00:00:00.000Z'))
  assert.equal(state, 'active')
})

test('startup with revoked lease needs reacquire', () => {
  assert.equal(needsReacquire({ state: 'revoked' }), true)
})

test('replacement required handling prefers rotate', () => {
  assert.equal(shouldRotateLease({
    state: 'active',
    replacement_required: true,
    rotation_recommended: false,
  }, true), true)
})

test('renew handling triggers near expiry', () => {
  assert.equal(shouldRenewLease({
    state: 'active',
    replacement_required: false,
    expires_at: '2026-03-22T00:04:00.000Z',
  }, true, new Date('2026-03-22T00:00:00.000Z')), true)
})
