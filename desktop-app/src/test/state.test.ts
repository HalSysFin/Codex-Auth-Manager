import test from 'node:test'
import assert from 'node:assert/strict'
import { createInitialPersistedState } from '../state'

test('createInitialPersistedState generates stable defaults when missing', () => {
  const state = createInitialPersistedState(null)
  assert.ok(state.settings.machineId.startsWith('desktop-'))
  assert.equal(state.settings.agentId, 'desktop-app')
  assert.equal(state.lease.authFilePath, '~/.codex/auth.json')
})

test('createInitialPersistedState preserves persisted lease metadata', () => {
  const state = createInitialPersistedState({
    settings: {
      baseUrl: 'http://127.0.0.1:8080',
      internalApiToken: 'token',
      machineId: 'machine-a',
      agentId: 'agent-a',
      authFilePath: '~/.codex/auth.json',
      refreshIntervalSeconds: 60,
      telemetryIntervalSeconds: 300,
      autoRenew: true,
      autoRotate: true,
      openDashboardPath: '',
      allowInsecureLocalhost: true,
    },
    lease: {
      machineId: 'machine-a',
      agentId: 'agent-a',
      leaseId: 'lease-1',
      credentialId: 'cred-1',
      issuedAt: '2026-03-22T00:00:00.000Z',
      expiresAt: '2026-03-22T01:00:00.000Z',
      leaseState: 'active',
      latestTelemetryAt: null,
      latestUtilizationPct: 10,
      latestQuotaRemaining: 900,
      lastAuthWriteAt: null,
      lastBackendRefreshAt: null,
      replacementRequired: false,
      rotationRecommended: false,
      lastErrorAt: null,
      authFilePath: '~/.codex/auth.json',
    },
  })
  assert.equal(state.lease.leaseId, 'lease-1')
  assert.equal(state.settings.machineId, 'machine-a')
})
