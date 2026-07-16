from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from app.accounts import AccountProfile
from app.login_sessions import cancel_login_session, create_login_session, get_login_session
from app.main import (
    api_account_history,
    api_accounts,
    api_accounts_stream,
    api_lease_reconcile_auth,
    auth_export,
    auth_relay_callback,
    api_lease_materialize,
    api_lease_telemetry,
    api_usage_history,
    _normalize_session_limit_payload,
    _rate_limit_reset_credits_payload,
)


def _json_body(response) -> dict:
    return json.loads(response.body.decode('utf-8'))


class CachedAccountsApiTests(unittest.TestCase):
    def test_normalizes_paid_account_to_one_weekly_limit(self) -> None:
        payload = _normalize_session_limit_payload({
            'rateLimits': {
                'planType': 'team',
                'primary': {
                    'usedPercent': 19,
                    'windowDurationMins': 10080,
                    'resetsAt': 1784809654,
                },
                'secondary': None,
            },
        })

        self.assertEqual(set(payload), {'limit', 'period', 'planType'})
        self.assertEqual(payload['period'], 'week')
        self.assertEqual(payload['limit']['label'], '1 week')
        self.assertEqual(payload['limit']['usedPercent'], 19)

    def test_normalizes_free_account_to_one_monthly_limit(self) -> None:
        payload = _normalize_session_limit_payload({
            'rateLimits': {
                'planType': 'free',
                'primary': {
                    'usedPercent': 7,
                    'windowDurationMins': 43200,
                    'resetsAt': 1786809654,
                },
                'secondary': None,
            },
        })

        self.assertEqual(payload['period'], 'month')
        self.assertEqual(payload['limit']['label'], '1 month')
        self.assertEqual(payload['limit']['windowDurationMins'], 43200)

    def test_preserves_and_normalizes_banked_rate_limit_resets(self) -> None:
        raw = {
            'rateLimits': {
                'planType': 'pro',
                'primary': {'usedPercent': 91, 'windowDurationMins': 10080},
            },
            'rateLimitResetCredits': {
                'availableCount': 3,
                'credits': [{
                    'id': 'credit-1',
                    'resetType': 'codexRateLimits',
                    'status': 'available',
                    'expiresAt': 1784246400,
                    'title': 'Full reset',
                }],
            },
        }

        normalized_limits = _normalize_session_limit_payload(raw)
        normalized_credits = _rate_limit_reset_credits_payload(raw)

        self.assertEqual(normalized_limits['rateLimitResetCredits']['availableCount'], 3)
        self.assertEqual(normalized_credits['available_count'], 3)
        self.assertEqual(normalized_credits['credits'][0]['id'], 'credit-1')
        self.assertEqual(normalized_credits['credits'][0]['reset_type'], 'codexRateLimits')

    def test_manual_auth_export_keeps_refresh_token(self) -> None:
        profile = AccountProfile(
            label='max',
            path=Path('db://active-auth'),
            auth={
                'auth_mode': 'chatgpt',
                'OPENAI_API_KEY': None,
                'tokens': {
                    'id_token': 'id-token',
                    'access_token': 'access-token',
                    'refresh_token': 'refresh-token',
                    'account_id': 'acct-max',
                },
            },
            account_key='acct:max',
            email='max@example.com',
        )
        with (
            patch('app.main._require_internal_auth', return_value=None),
            patch('app.main._profile_for_label', return_value=profile),
        ):
            response = asyncio.run(auth_export(request=None, label='max'))

        payload = _json_body(response)
        self.assertEqual(payload['auth_json']['tokens']['refresh_token'], 'refresh-token')

    def test_api_accounts_returns_cached_without_live_probe(self) -> None:
        profile = AccountProfile(
            label='acct',
            path=Path('/tmp/acct.json'),
            auth={},
            account_key='sub:auth0|acct',
            email='acct@example.com',
        )
        with (
            patch('app.main._require_internal_auth', return_value=None),
            patch('app.main._dedupe_profiles', return_value=[profile]),
            patch('app.main.list_profiles', return_value=[profile]),
            patch('app.main.read_current_auth', return_value={}),
            patch('app.main._resolve_current_label', return_value='acct'),
            patch('app.main._usage_tracking_payload', return_value={
                'usage_limit': 100,
                'usage_in_window': 20,
                'lifetime_used': 120,
                'rate_limit_refresh_at': '2026-03-22T00:00:00+00:00',
            }),
            patch('app.main.list_usage_rollovers', return_value=[]),
        ):
            response = asyncio.run(api_accounts(request=None))

        payload = _json_body(response)
        self.assertIn('accounts', payload)
        self.assertEqual(payload['accounts'][0]['label'], 'acct')
        self.assertEqual(set(payload['accounts'][0]['rate_limits']), {'limit', 'period'})
        self.assertNotIn('primary_used_percent', payload['accounts'][0]['usage_tracking'])
        self.assertNotIn('secondary_used_percent', payload['accounts'][0]['usage_tracking'])

    def test_stream_emits_snapshot_then_complete_for_empty_profiles(self) -> None:
        with (
            patch('app.main._require_internal_auth_or_query', return_value=None),
            patch('app.main.list_profiles', return_value=[]),
            patch('app.main.read_current_auth', return_value={}),
        ):
            response = asyncio.run(api_accounts_stream(request=None))

        async def collect() -> str:
            chunks = []
            async for part in response.body_iterator:
                chunks.append(part.decode('utf-8') if isinstance(part, (bytes, bytearray)) else str(part))
            return ''.join(chunks)

        body = asyncio.run(collect())
        self.assertIn('event: snapshot', body)
        self.assertIn('event: complete', body)

    def test_usage_history_returns_cumulative_and_daily_series(self) -> None:
        profile = AccountProfile(
            label='max',
            path=Path('/tmp/max.json'),
            auth={},
            account_key='acct:max',
            email='max@example.com',
        )
        snapshots = [
            {'account_id': 'acct:max', 'captured_at': '2026-03-20T10:00:00+00:00', 'lifetime_used': 100},
            {'account_id': 'acct:max', 'captured_at': '2026-03-21T10:00:00+00:00', 'lifetime_used': 130},
            {'account_id': 'acct:max', 'captured_at': '2026-03-22T10:00:00+00:00', 'lifetime_used': 170},
        ]
        with (
            patch('app.main._require_internal_auth', return_value=None),
            patch('app.main._dedupe_profiles', return_value=[profile]),
            patch('app.main.list_profiles', return_value=[profile]),
            patch('app.main._touch_profiles_usage', return_value=None),
            patch('app.main._build_cached_accounts_snapshot', return_value={
                'accounts': [{'account_key': 'acct:max', 'label': 'max', 'display_label': 'max', 'email': 'max@example.com', 'refresh_status': {}}],
                'current_label': 'max',
                'aggregate': {
                    'total_current_window_used': 10,
                    'total_current_window_limit': 100,
                    'total_remaining': 90,
                    'stale_accounts': 0,
                    'failed_accounts': 0,
                    'last_refresh_time': '2026-03-22T10:00:00+00:00',
                },
            }),
            patch('app.main.list_absolute_usage_snapshots', return_value=snapshots),
            patch('app.main.list_usage_rollovers', return_value=[]),
        ):
            response = asyncio.run(api_usage_history(request=None, range='30d'))
        payload = _json_body(response)
        self.assertEqual(payload['range'], '30d')
        self.assertTrue(len(payload['series']['daily_usage']) >= 1)
        self.assertTrue(len(payload['series']['cumulative_usage']) >= 1)

    def test_account_history_returns_current_state_and_completed_windows(self) -> None:
        profile = AccountProfile(
            label='james',
            path=Path('/tmp/james.json'),
            auth={},
            account_key='acct:james',
            email='james@example.com',
        )
        with (
            patch('app.main._require_internal_auth', return_value=None),
            patch('app.main._profile_for_label', return_value=profile),
            patch('app.main._touch_account_usage', return_value=None),
            patch('app.main._usage_tracking_payload', return_value={
                'usage_in_window': 20,
                'usage_limit': 100,
                'lifetime_used': 220,
                'rate_limit_refresh_at': '2026-03-23T00:00:00+00:00',
                'last_usage_sync_at': '2026-03-22T10:00:00+00:00',
            }),
            patch('app.main.list_usage_rollovers', return_value=[
                {
                    'window_started_at': '2026-03-21T00:00:00+00:00',
                    'window_ended_at': '2026-03-22T00:00:00+00:00',
                    'usage_used': 80,
                    'usage_limit': 100,
                    'usage_wasted': 20,
                    'rolled_over_at': '2026-03-22T00:00:05+00:00',
                }
            ]),
            patch('app.main.list_absolute_usage_snapshots', return_value=[
                {'account_id': 'acct:james', 'captured_at': '2026-03-21T10:00:00+00:00', 'lifetime_used': 200},
                {'account_id': 'acct:james', 'captured_at': '2026-03-22T10:00:00+00:00', 'lifetime_used': 220},
            ]),
        ):
            response = asyncio.run(api_account_history(request=None, label='james', range='30d'))
        payload = _json_body(response)
        self.assertEqual(payload['label'], 'james')
        self.assertIn('current_state', payload)
        self.assertIn('consumption_trend', payload)
        self.assertIn('completed_windows', payload)
        self.assertEqual(payload['current_state']['usage_in_window'], 20)
        self.assertEqual(len(payload['completed_windows']), 1)

    def test_lease_materialize_returns_credential_material_auth_json(self) -> None:
        with (
            patch('app.main._require_internal_auth', return_value=None),
            patch('app.main.materialize_broker_lease', return_value={
                'status': 'ok',
                'reason': None,
                'lease': {
                    'id': 'lease-1',
                    'credential_id': 'acct:max',
                    'metadata': {'label': 'max'},
                },
            }),
            patch('app.main._leased_profile_payload_for_credential', return_value={
                'label': 'max',
                'account_key': 'acct:max',
                'email': 'max@example.com',
                'name': 'Max',
                'provider_account_id': 'provider-max',
                'auth_json': {
                    'auth_mode': 'chatgpt',
                    'OPENAI_API_KEY': None,
                    'tokens': {
                        'id_token': 'id-token',
                        'access_token': 'access-token',
                        'refresh_token': 'refresh-token',
                        'account_id': 'acct-max',
                    },
                },
            }),
            patch('app.main._audit_broker_event', return_value=None),
        ):
            response = asyncio.run(api_lease_materialize(
                request=None,
                lease_id='lease-1',
                payload={'machine_id': 'machine-a', 'agent_id': 'agent-a'},
            ))

        payload = _json_body(response)
        self.assertEqual(payload['status'], 'ok')
        self.assertEqual(payload['credential_material']['label'], 'max')
        self.assertEqual(payload['credential_material']['auth_json']['tokens']['account_id'], 'acct-max')
        self.assertEqual(payload['credential_material']['auth_json']['tokens']['refresh_token'], '')
        self.assertEqual(payload['credential_material']['openclaw']['profile_id'], 'openai-codex:lease')
        self.assertEqual(
            payload['credential_material']['openclaw']['openclaw_auth_json']['openai_cid_tokens']['openai-codex:lease']['refresh_token'],
            '',
        )
        self.assertEqual(
            payload['credential_material']['openclaw']['openclaw_auth_json']['openai_cid_tokens']['openai-codex:lease']['accountId'],
            'acct-max',
        )
        self.assertEqual(
            payload['credential_material']['openclaw']['openclaw_auth_json']['auth.profiles.openai-codex:lease']['mode'],
            'oauth',
        )

    def test_lease_telemetry_returns_updated_latest_summary(self) -> None:
        with (
            patch('app.main._require_internal_auth', return_value=None),
            patch('app.main.record_broker_lease_telemetry', return_value={
                'status': 'ok',
                'reason': None,
                'lease': {
                    'id': 'lease-1',
                    'credential_id': 'acct:max',
                    'state': 'active',
                    'latest_utilization_pct': 84.0,
                    'latest_quota_remaining': 16000,
                    'reason': None,
                },
                'credential': {
                    'id': 'acct:max',
                    'state': 'leased',
                },
            }),
            patch('app.main._audit_broker_event', return_value=None),
        ):
            response = asyncio.run(api_lease_telemetry(
                request=None,
                lease_id='lease-1',
                payload={
                    'machine_id': 'machine-a',
                    'agent_id': 'agent-a',
                    'captured_at': '2026-03-23T10:00:00+00:00',
                    'requests_count': 2,
                    'tokens_in': 100,
                    'tokens_out': 50,
                    'status': 'ok',
                    'utilization_pct': 84.0,
                    'quota_remaining': 16000,
                },
            ))

        payload = _json_body(response)
        self.assertEqual(payload['status'], 'ok')
        self.assertEqual(payload['lease']['latest_utilization_pct'], 84.0)
        self.assertEqual(payload['lease']['latest_quota_remaining'], 16000)

    def test_lease_reconcile_rejects_auth_from_different_account(self) -> None:
        with (
            patch('app.main._require_internal_auth', return_value=None),
            patch('app.main._sync_broker_credentials_from_profiles', return_value=[]),
            patch('app.main.get_broker_lease_status', return_value={
                'lease_id': 'lease-1',
                'credential_id': 'sub:auth0|james-user',
                'machine_id': 'machine-a',
                'agent_id': 'agent-a',
                'credential_auth_updated_at': '2026-03-23T00:00:00+00:00',
            }),
            patch('app.main._leased_profile_payload_for_credential', return_value={
                'label': 'james',
                'account_key': 'sub:auth0|james-user',
                'auth_json': {
                    'auth_mode': 'chatgpt',
                    'OPENAI_API_KEY': None,
                    'tokens': {
                        'id_token': 'header.eyJzdWIiOiJhdXRoMHxqYW1lcy11c2VyIiwiZW1haWwiOiJqYW1lc0BleGFtcGxlLmNvbSJ9.sig',
                        'access_token': 'header.eyJzdWIiOiJhdXRoMHxqYW1lcy11c2VyIn0.sig',
                        'refresh_token': 'refresh-james',
                        'account_id': 'acct-james',
                    },
                    'last_refresh': '2026-03-23T00:00:00+00:00',
                },
            }),
            patch('app.main._persist_current_auth_to_profile') as persist_mock,
        ):
            response = asyncio.run(api_lease_reconcile_auth(
                request=None,
                lease_id='lease-1',
                payload={
                    'machine_id': 'machine-a',
                    'agent_id': 'agent-a',
                    'auth_json': {
                        'auth_mode': 'chatgpt',
                        'OPENAI_API_KEY': None,
                        'tokens': {
                            'id_token': 'header.eyJzdWIiOiJhdXRoMHxtYXgtdXNlciIsImVtYWlsIjoibWF4QGV4YW1wbGUuY29tIn0.sig',
                            'access_token': 'header.eyJzdWIiOiJhdXRoMHxtYXgtdXNlciJ9.sig',
                            'refresh_token': 'refresh-max',
                            'account_id': 'acct-max',
                        },
                        'last_refresh': '2026-03-23T00:10:00+00:00',
                    },
                },
            ))

        payload = _json_body(response)
        self.assertEqual(payload['decision'], 'identity_mismatch')
        self.assertEqual(payload['reason'], 'local_auth_identity_mismatch')
        self.assertEqual(payload['expected_account_key'], 'sub:auth0|james-user')
        self.assertEqual(payload['incoming_account_key'], 'sub:auth0|max-user')
        persist_mock.assert_not_called()

    def test_lease_reconcile_rejects_unverifiable_local_auth(self) -> None:
        with (
            patch('app.main._require_internal_auth', return_value=None),
            patch('app.main._sync_broker_credentials_from_profiles', return_value=[]),
            patch('app.main.get_broker_lease_status', return_value={
                'lease_id': 'lease-1',
                'credential_id': 'sub:auth0|james-user',
                'machine_id': 'machine-a',
                'agent_id': 'agent-a',
                'credential_auth_updated_at': '2026-03-23T00:00:00+00:00',
            }),
            patch('app.main._leased_profile_payload_for_credential', return_value={
                'label': 'james',
                'account_key': 'sub:auth0|james-user',
                'auth_json': {
                    'auth_mode': 'chatgpt',
                    'OPENAI_API_KEY': None,
                    'tokens': {
                        'id_token': 'header.eyJzdWIiOiJhdXRoMHxqYW1lcy11c2VyIiwiZW1haWwiOiJqYW1lc0BleGFtcGxlLmNvbSJ9.sig',
                        'access_token': 'header.eyJzdWIiOiJhdXRoMHxqYW1lcy11c2VyIn0.sig',
                        'refresh_token': 'refresh-james',
                        'account_id': 'acct-james',
                    },
                    'last_refresh': '2026-03-23T00:00:00+00:00',
                },
            }),
            patch('app.main._persist_current_auth_to_profile') as persist_mock,
        ):
            response = asyncio.run(api_lease_reconcile_auth(
                request=None,
                lease_id='lease-1',
                payload={
                    'machine_id': 'machine-a',
                    'agent_id': 'agent-a',
                    'auth_json': {
                        'auth_mode': 'chatgpt',
                        'OPENAI_API_KEY': None,
                        'tokens': {
                            'id_token': 'not-a-jwt',
                            'access_token': 'local-token-without-claims',
                            'refresh_token': 'refresh-unknown',
                            'account_id': '',
                        },
                        'last_refresh': '2026-03-23T00:10:00+00:00',
                    },
                },
            ))

        payload = _json_body(response)
        self.assertEqual(payload['decision'], 'identity_mismatch')
        self.assertEqual(payload['reason'], 'local_auth_identity_unverifiable')
        self.assertEqual(payload['expected_account_key'], 'sub:auth0|james-user')
        persist_mock.assert_not_called()

    def test_relay_callback_accepts_manual_callback_with_mismatched_state(self) -> None:
        session = create_login_session(
            'https://example.com/auth?state=expected-state',
            ttl_seconds=300,
        )
        try:
            with (
                patch('app.main._store_callback', return_value=None),
                patch('app.main.relay_callback_to_login', return_value={
                    'attempted': True,
                    'supported': True,
                    'completed': True,
                    'message': 'ok',
                }),
            ):
                response = asyncio.run(auth_relay_callback({
                    'session_id': session.session_id,
                    'relay_token': session.relay_token,
                    'full_url': 'http://localhost:1455/auth/callback?code=abc123&state=other-machine-state',
                }))
        finally:
            cancel_login_session(session.session_id)

        payload = _json_body(response)
        self.assertEqual(payload['status'], 'callback_received')
        self.assertTrue(payload['session']['callback_received'])
        stored = get_login_session(session.session_id)
        self.assertIsNotNone(stored)
        self.assertFalse(stored.callback_payload['state_matches_session'])
        self.assertEqual(stored.callback_payload['expected_state'], 'expected-state')


if __name__ == '__main__':
    unittest.main()
