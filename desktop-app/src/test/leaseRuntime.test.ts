import test from 'node:test'
import assert from 'node:assert/strict'
import { selectStartupAction } from '../../../packages/lease-runtime/src/leaseLifecycle.ts'
import { buildLeaseTelemetryPayload } from '../../../packages/lease-runtime/src/telemetry.ts'

test('startup with no lease acquires', () => {
  assert.equal(selectStartupAction({
    leaseId: null,
    leaseStatus: null,
    autoRotate: true,
    autoRenew: true,
  }), 'acquire')
})

test('revoked lease reacquires', () => {
  assert.equal(selectStartupAction({
    leaseId: 'lease-1',
    leaseStatus: {
      lease_id: 'lease-1',
      credential_id: 'cred-1',
      state: 'revoked',
      issued_at: '2026-03-22T00:00:00.000Z',
      expires_at: '2026-03-22T01:00:00.000Z',
      renewed_at: null,
      machine_id: 'machine-a',
      agent_id: 'desktop-app',
      latest_telemetry_at: null,
      latest_utilization_pct: null,
      latest_quota_remaining: null,
      last_success_at: null,
      last_error_at: null,
      rotation_recommended: false,
      replacement_required: false,
      reason: null,
      credential_state: 'revoked',
    },
    autoRotate: true,
    autoRenew: true,
  }), 'reacquire')
})

test('replacement required rotates', () => {
  assert.equal(selectStartupAction({
    leaseId: 'lease-1',
    leaseStatus: {
      lease_id: 'lease-1',
      credential_id: 'cred-1',
      state: 'active',
      issued_at: '2026-03-22T00:00:00.000Z',
      expires_at: '2026-03-22T02:00:00.000Z',
      renewed_at: null,
      machine_id: 'machine-a',
      agent_id: 'desktop-app',
      latest_telemetry_at: null,
      latest_utilization_pct: 92,
      latest_quota_remaining: 1000,
      last_success_at: null,
      last_error_at: null,
      rotation_recommended: false,
      replacement_required: true,
      reason: null,
      credential_state: 'leased',
    },
    autoRotate: true,
    autoRenew: true,
  }), 'rotate')
})

test('minimal telemetry payload stays truthful', () => {
  const payload = buildLeaseTelemetryPayload({
    machineId: 'machine-a',
    agentId: 'desktop-app',
    leaseId: 'lease-1',
    credentialId: 'cred-1',
    issuedAt: '2026-03-22T00:00:00.000Z',
    expiresAt: '2026-03-22T01:00:00.000Z',
    leaseState: 'active',
    latestTelemetryAt: null,
    latestUtilizationPct: 12,
    latestQuotaRemaining: 900,
    lastAuthWriteAt: null,
    lastBackendRefreshAt: '2026-03-22T00:10:00.000Z',
    replacementRequired: false,
    rotationRecommended: false,
    lastErrorAt: null,
    authFilePath: '~/.codex/auth.json',
  }, '2026-03-22T00:15:00.000Z')
  assert.deepEqual(payload, {
    machine_id: 'machine-a',
    agent_id: 'desktop-app',
    captured_at: '2026-03-22T00:15:00.000Z',
    status: 'ok',
    last_success_at: '2026-03-22T00:10:00.000Z',
    last_error_at: null,
    utilization_pct: 12,
    quota_remaining: 900,
    requests_count: null,
    tokens_in: null,
    tokens_out: null,
    rate_limit_remaining: null,
    error_rate_1h: null,
  })
})
