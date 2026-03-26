import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { applyLeaseAuthToOpenClaw } from '../authFile.js'

test('applyLeaseAuthToOpenClaw writes flattened OpenClaw auth.json and codex-switch compatible OpenClaw stores', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-home-'))
  const originalHome = process.env.HOME
  process.env.HOME = tempHome

  try {
    await fs.mkdir(path.join(tempHome, '.openclaw'), { recursive: true })
    await fs.writeFile(
      path.join(tempHome, '.openclaw/auth.json'),
      JSON.stringify({
        'agents.defaults.models.openai-codex/gpt-5.4': {},
        'custom.setting': true,
        'auth.order.openai-codex': ['openai-codex:old'],
        'auth.profiles.openai-codex:old': { provider: 'openai-codex', mode: 'oauth' },
        openai_cid_tokens: {
          'openai-codex:old': { access_token: 'old-access' },
        },
      }),
      'utf8',
    )
    await applyLeaseAuthToOpenClaw({
      material: {
        profile_id: 'openai-codex:lease-source',
        openclaw_auth_json: {
          'agents.defaults.models.openai-codex/gpt-5.4': {},
          'auth.order.openai-codex': ['openai-codex:lease-source'],
          'auth.profiles.openai-codex:lease-source': {
            provider: 'openai-codex',
            mode: 'oauth',
          },
          openai_cid_tokens: {
            'openai-codex:lease-source': {
              access_token: 'access-token',
              refresh_token: 'refresh-token',
              id_token: null,
              expires_at_ms: 1_900_000_000_000,
              accountId: 'acct-1',
              provider: 'openai-codex',
              type: 'oauth',
              decoded_access_jwt: {
                header: { alg: 'RS256' },
                payload: { exp: 1_900_000_000 },
              },
              email: 'id-user@example.com',
              displayName: 'Lease User',
            },
          },
        },
      },
      authPayload: {
        auth_mode: 'oauth',
        OPENAI_API_KEY: null,
        tokens: {
          id_token: '',
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          account_id: 'acct-1',
        },
      },
      leaseProfileId: 'openai-codex:lease',
      agentId: 'openclaw:main',
    })

    const authJson = JSON.parse(
      await fs.readFile(path.join(tempHome, '.openclaw/auth.json'), 'utf8'),
    ) as Record<string, unknown>
    const authProfiles = JSON.parse(
      await fs.readFile(path.join(tempHome, '.openclaw/agents/openclaw:main/agent/auth-profiles.json'), 'utf8'),
    ) as Record<string, unknown>
    const oauthImport = JSON.parse(
      await fs.readFile(path.join(tempHome, '.openclaw/credentials/oauth.json'), 'utf8'),
    ) as Record<string, unknown>

    assert.equal(authJson['custom.setting'], true)
    assert.deepEqual(authJson['auth.order.openai-codex'], ['openai-codex:lease'])
    assert.deepEqual(authJson['auth.profiles.openai-codex:lease'], { provider: 'openai-codex', mode: 'oauth' })
    const tokens = (authJson.openai_cid_tokens as Record<string, unknown>)['openai-codex:lease'] as Record<string, unknown>
    assert.equal(tokens.access_token, 'access-token')
    assert.equal(tokens.refresh_token, 'refresh-token')
    assert.equal(tokens.accountId, 'acct-1')
    assert.equal(tokens.expires_at_ms, 1_900_000_000_000)
    assert.equal(tokens.email, 'id-user@example.com')
    assert.equal(tokens.displayName, 'Lease User')
    assert.equal(authProfiles.version, 1)
    assert.deepEqual(authProfiles.lastGood, { 'openai-codex': 'openai-codex:lease' })
    assert.deepEqual(
      (authProfiles.profiles as Record<string, unknown>)['openai-codex:lease'],
      {
        type: 'oauth',
        provider: 'openai-codex',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: 1_900_000_000_000,
        accountId: 'acct-1',
        email: 'id-user@example.com',
      },
    )
    assert.deepEqual(
      oauthImport['openai-codex'],
      {
        access: 'access-token',
        refresh: 'refresh-token',
        expires: 1_900_000_000_000,
        accountId: 'acct-1',
        email: 'id-user@example.com',
      },
    )
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    await fs.rm(tempHome, { recursive: true, force: true })
  }
})
