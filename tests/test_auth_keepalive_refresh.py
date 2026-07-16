from __future__ import annotations

import asyncio
import base64
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from app.account_usage_store import (
    get_active_auth_json,
    get_saved_profile,
    initialize_usage_store,
    set_active_auth_json,
    update_saved_profile_reauth_status,
    upsert_saved_profile,
)
from app.accounts import AccountProfile
from app.config import settings
from app.main import (
    _LAST_REFRESH_STATUS_BY_KEY,
    _auth_access_token_expiring_soon,
    _refresh_saved_auth_via_refresh_token,
    _refresh_saved_auths_if_needed,
)


def _jwt_with_claims(claims: dict) -> str:
    header = {"alg": "none", "typ": "JWT"}

    def _enc(obj: dict) -> str:
        raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    return f"{_enc(header)}.{_enc(claims)}."


class _FakeResponse:
    def __init__(self, payload: dict[str, str]) -> None:
        self.status_code = 200
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self) -> dict[str, str]:
        return self._payload


class _FakeAsyncClient:
    response_payload = {
        "access_token": _jwt_with_claims(
            {
                "sub": "auth0|james-user",
                "exp": 4102444800,
                "https://api.openai.com/auth": {
                    "chatgpt_account_id": "acct-123",
                },
            }
        ),
        "refresh_token": "refresh-token-new",
        "id_token": _jwt_with_claims(
            {
                "sub": "auth0|james-user",
                "email": "james@example.com",
                "exp": 4102444800,
                "https://api.openai.com/auth": {
                    "chatgpt_account_id": "acct-123",
                },
            }
        ),
    }

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    async def post(self, url: str, data: dict[str, str], headers: dict[str, str]) -> _FakeResponse:
        self.last_request = {
            "url": url,
            "data": dict(data),
            "headers": dict(headers),
        }
        return _FakeResponse(dict(self.response_payload))


class AuthKeepaliveRefreshTests(unittest.TestCase):
    def setUp(self) -> None:
        _LAST_REFRESH_STATUS_BY_KEY.clear()
        role_patch = patch.object(settings, "auth_manager_process_role", "refresh")
        role_patch.start()
        self.addCleanup(role_patch.stop)

    def test_non_refresh_process_cannot_exchange_refresh_token(self) -> None:
        profile = AccountProfile(
            label="james",
            path=Path("db://active-auth"),
            auth={"tokens": {"refresh_token": "refresh-token"}},
            account_key="sub:auth0|james-user",
        )
        with patch.object(settings, "auth_manager_process_role", "api"):
            with self.assertRaisesRegex(RuntimeError, "dedicated refresh worker"):
                asyncio.run(_refresh_saved_auth_via_refresh_token(profile))

    def test_refresh_window_opens_one_day_before_expiry(self) -> None:
        now_ts = int(datetime.now(timezone.utc).timestamp())
        auth_due_in_23_hours = {
            "tokens": {
                "access_token": _jwt_with_claims(
                    {
                        "sub": "auth0|james-user",
                        "exp": now_ts + (23 * 60 * 60),
                    }
                )
            }
        }
        auth_due_in_25_hours = {
            "tokens": {
                "access_token": _jwt_with_claims(
                    {
                        "sub": "auth0|james-user",
                        "exp": now_ts + (25 * 60 * 60),
                    }
                )
            }
        }

        self.assertTrue(_auth_access_token_expiring_soon(auth_due_in_23_hours))
        self.assertFalse(_auth_access_token_expiring_soon(auth_due_in_25_hours))

    def test_refresh_updates_active_auth_when_active_copy_matches_profile(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "usage.sqlite3"
            initialize_usage_store(db_path)

            old_auth = {
                "auth_mode": "chatgpt",
                "tokens": {
                    "access_token": _jwt_with_claims(
                        {
                            "sub": "auth0|james-user",
                            "exp": 1700000000,
                            "https://api.openai.com/auth": {
                                "chatgpt_account_id": "acct-123",
                            },
                        }
                    ),
                    "refresh_token": "refresh-token-old",
                    "id_token": _jwt_with_claims(
                        {
                            "sub": "auth0|james-user",
                            "email": "james@example.com",
                            "exp": 1700000000,
                            "https://api.openai.com/auth": {
                                "chatgpt_account_id": "acct-123",
                            },
                        }
                    ),
                    "account_id": "acct-123",
                },
                "last_refresh": "2026-01-01T00:00:00+00:00",
            }

            upsert_saved_profile(
                label="james",
                account_key="sub:auth0|james-user",
                auth_json=old_auth,
                email="james@example.com",
                db_path=db_path,
            )
            set_active_auth_json(old_auth, db_path=db_path)

            profile = AccountProfile(
                label="james",
                path=Path("db://active-auth"),
                auth=old_auth,
                account_key="sub:auth0|james-user",
                email="james@example.com",
                access_token=old_auth["tokens"]["access_token"],
            )

            with (
                patch.object(settings, "usage_db_path", str(db_path)),
                patch.object(settings, "openai_token_url", "https://example.com/oauth/token"),
                patch.object(settings, "openai_client_id", "client-123"),
                patch("app.main.httpx.AsyncClient", _FakeAsyncClient),
            ):
                refreshed = asyncio.run(_refresh_saved_auth_via_refresh_token(profile))

            self.assertTrue(refreshed)

            saved = get_saved_profile("james", db_path=db_path)
            self.assertIsNotNone(saved)
            assert saved is not None
            active = get_active_auth_json(db_path=db_path)
            self.assertIsNotNone(active)
            assert active is not None

            self.assertEqual(saved["auth_json"]["tokens"]["refresh_token"], "refresh-token-new")
            self.assertEqual(active["tokens"]["refresh_token"], "refresh-token-new")
            self.assertEqual(
                active["tokens"]["access_token"],
                saved["auth_json"]["tokens"]["access_token"],
            )

    def test_refresh_rejects_identity_mismatch_from_upstream(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "usage.sqlite3"
            initialize_usage_store(db_path)

            old_auth = {
                "auth_mode": "chatgpt",
                "tokens": {
                    "access_token": _jwt_with_claims(
                        {
                            "sub": "auth0|james-user",
                            "exp": 1700000000,
                            "https://api.openai.com/auth": {
                                "chatgpt_account_id": "acct-123",
                            },
                        }
                    ),
                    "refresh_token": "refresh-token-old",
                    "id_token": _jwt_with_claims(
                        {
                            "sub": "auth0|james-user",
                            "email": "james@example.com",
                            "exp": 1700000000,
                            "https://api.openai.com/auth": {
                                "chatgpt_account_id": "acct-123",
                            },
                        }
                    ),
                    "account_id": "acct-123",
                },
                "last_refresh": "2026-01-01T00:00:00+00:00",
            }

            upsert_saved_profile(
                label="james",
                account_key="sub:auth0|james-user",
                auth_json=old_auth,
                email="james@example.com",
                db_path=db_path,
            )
            set_active_auth_json(old_auth, db_path=db_path)

            profile = AccountProfile(
                label="james",
                path=Path("db://active-auth"),
                auth=old_auth,
                account_key="sub:auth0|james-user",
                email="james@example.com",
                access_token=old_auth["tokens"]["access_token"],
            )

            class _MismatchClient(_FakeAsyncClient):
                response_payload = {
                    "access_token": _jwt_with_claims(
                        {
                            "sub": "auth0|max-user",
                            "exp": 4102444800,
                            "https://api.openai.com/auth": {
                                "chatgpt_account_id": "acct-999",
                            },
                        }
                    ),
                    "refresh_token": "refresh-token-max",
                    "id_token": _jwt_with_claims(
                        {
                            "sub": "auth0|max-user",
                            "email": "max@example.com",
                            "exp": 4102444800,
                            "https://api.openai.com/auth": {
                                "chatgpt_account_id": "acct-999",
                            },
                        }
                    ),
                }

            with (
                patch.object(settings, "usage_db_path", str(db_path)),
                patch.object(settings, "openai_token_url", "https://example.com/oauth/token"),
                patch.object(settings, "openai_client_id", "client-123"),
                patch("app.main.httpx.AsyncClient", _MismatchClient),
            ):
                with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                    asyncio.run(_refresh_saved_auth_via_refresh_token(profile))

            saved = get_saved_profile("james", db_path=db_path)
            self.assertIsNotNone(saved)
            assert saved is not None
            active = get_active_auth_json(db_path=db_path)
            self.assertIsNotNone(active)
            assert active is not None
            self.assertEqual(saved["auth_json"]["tokens"]["refresh_token"], "refresh-token-old")
            self.assertEqual(active["tokens"]["refresh_token"], "refresh-token-old")

    def test_keepalive_retries_even_when_live_refresh_status_requires_reauth(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "usage.sqlite3"
            initialize_usage_store(db_path)

            old_auth = {
                "auth_mode": "chatgpt",
                "tokens": {
                    "access_token": _jwt_with_claims(
                        {
                            "sub": "auth0|james-user",
                            "exp": 1700000000,
                            "https://api.openai.com/auth": {
                                "chatgpt_account_id": "acct-123",
                            },
                        }
                    ),
                    "refresh_token": "refresh-token-old",
                    "id_token": _jwt_with_claims(
                        {
                            "sub": "auth0|james-user",
                            "email": "james@example.com",
                            "exp": 1700000000,
                            "https://api.openai.com/auth": {
                                "chatgpt_account_id": "acct-123",
                            },
                        }
                    ),
                    "account_id": "acct-123",
                },
                "last_refresh": "2026-01-01T00:00:00+00:00",
            }

            upsert_saved_profile(
                label="james",
                account_key="sub:auth0|james-user",
                auth_json=old_auth,
                email="james@example.com",
                db_path=db_path,
            )
            _LAST_REFRESH_STATUS_BY_KEY["sub:auth0|james-user"] = {
                "state": "failed",
                "reauth_required": True,
                "last_error": "provided authentication token is expired",
            }

            with (
                patch.object(settings, "usage_db_path", str(db_path)),
                patch.object(settings, "openai_token_url", "https://example.com/oauth/token"),
                patch.object(settings, "openai_client_id", "client-123"),
                patch("app.main.httpx.AsyncClient", _FakeAsyncClient),
            ):
                refreshed = asyncio.run(_refresh_saved_auths_if_needed())

            self.assertEqual(refreshed, 1)
            saved = get_saved_profile("james", db_path=db_path)
            self.assertIsNotNone(saved)
            assert saved is not None
            self.assertEqual(saved["auth_json"]["tokens"]["refresh_token"], "refresh-token-new")

    def test_keepalive_retries_even_when_profile_is_marked_reauth_required(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "usage.sqlite3"
            initialize_usage_store(db_path)

            old_auth = {
                "auth_mode": "chatgpt",
                "tokens": {
                    "access_token": _jwt_with_claims(
                        {
                            "sub": "auth0|james-user",
                            "exp": 1700000000,
                            "https://api.openai.com/auth": {
                                "chatgpt_account_id": "acct-123",
                            },
                        }
                    ),
                    "refresh_token": "refresh-token-old",
                    "id_token": _jwt_with_claims(
                        {
                            "sub": "auth0|james-user",
                            "email": "james@example.com",
                            "exp": 1700000000,
                            "https://api.openai.com/auth": {
                                "chatgpt_account_id": "acct-123",
                            },
                        }
                    ),
                    "account_id": "acct-123",
                },
                "last_refresh": "2026-01-01T00:00:00+00:00",
            }

            upsert_saved_profile(
                label="james",
                account_key="sub:auth0|james-user",
                auth_json=old_auth,
                email="james@example.com",
                db_path=db_path,
            )
            update_saved_profile_reauth_status(
                "james",
                reauth_required=True,
                reauth_reason="provided authentication token is expired",
                db_path=db_path,
            )

            with (
                patch.object(settings, "usage_db_path", str(db_path)),
                patch.object(settings, "openai_token_url", "https://example.com/oauth/token"),
                patch.object(settings, "openai_client_id", "client-123"),
                patch("app.main.httpx.AsyncClient", _FakeAsyncClient),
            ):
                refreshed = asyncio.run(_refresh_saved_auths_if_needed())

            self.assertEqual(refreshed, 1)
            saved = get_saved_profile("james", db_path=db_path)
            self.assertIsNotNone(saved)
            assert saved is not None
            self.assertEqual(saved["auth_json"]["tokens"]["refresh_token"], "refresh-token-new")


if __name__ == "__main__":
    unittest.main()
