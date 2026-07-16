from __future__ import annotations

import asyncio
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

httpx_stub = types.ModuleType("httpx")
httpx_stub.Client = object
httpx_stub.AsyncClient = object
httpx_stub.HTTPError = Exception
sys.modules.setdefault("httpx", httpx_stub)

pydantic_settings_stub = types.ModuleType("pydantic_settings")


class _BaseSettings:
    def __init__(self, **kwargs):
        for name, value in self.__class__.__dict__.items():
            if name.startswith("_") or callable(value):
                continue
            setattr(self, name, kwargs.get(name, value))


def _settings_config_dict(**kwargs):
    return kwargs


pydantic_settings_stub.BaseSettings = _BaseSettings
pydantic_settings_stub.SettingsConfigDict = _settings_config_dict
sys.modules.setdefault("pydantic_settings", pydantic_settings_stub)

from app.codex_cli import (
    AppServerRateLimitsResult,
    CodexCLIError,
    _worker_payload,
    consume_rate_limit_reset_for_auth_async,
    read_rate_limits_for_auth,
    read_rate_limits_for_auth_async,
)


class CodexCliRateLimitRoutingTests(unittest.TestCase):
    def test_worker_payload_cannot_rotate_refresh_token(self) -> None:
        auth_json = {
            "tokens": {
                "access_token": "access-token",
                "refresh_token": "refresh-token",
            }
        }

        payload = _worker_payload(auth_json, timeout_seconds=3.0)

        self.assertEqual(payload["auth_json"]["tokens"]["access_token"], "access-token")
        self.assertEqual(payload["auth_json"]["tokens"]["refresh_token"], "")
        self.assertEqual(auth_json["tokens"]["refresh_token"], "refresh-token")

    def test_prefers_app_server_worker_before_backend(self) -> None:
        expected = AppServerRateLimitsResult(
            account={"type": "chatgpt"},
            rate_limits={"limitId": "codex"},
            notifications=[],
        )

        with (
            patch("app.codex_cli._read_rate_limits_via_worker", return_value=expected) as worker_mock,
            patch("app.codex_cli._read_rate_limits_via_chatgpt_backend") as backend_mock,
            patch("app.codex_cli._read_rate_limits_via_direct_api") as direct_mock,
        ):
            result = read_rate_limits_for_auth({"auth_mode": "chatgpt"}, timeout_seconds=3.0)

        self.assertIs(result, expected)
        worker_mock.assert_called_once()
        backend_mock.assert_not_called()
        direct_mock.assert_not_called()

    def test_falls_back_to_backend_when_worker_fails(self) -> None:
        expected = AppServerRateLimitsResult(
            account=None,
            rate_limits={"limitId": "codex"},
            notifications=[],
        )

        with (
            patch("app.codex_cli._read_rate_limits_via_worker", side_effect=CodexCLIError("worker failed")) as worker_mock,
            patch("app.codex_cli._read_rate_limits_via_chatgpt_backend", return_value=expected) as backend_mock,
            patch("app.codex_cli._read_rate_limits_via_direct_api") as direct_mock,
        ):
            result = read_rate_limits_for_auth({"auth_mode": "chatgpt"}, timeout_seconds=3.0)

        self.assertIs(result, expected)
        worker_mock.assert_called_once()
        backend_mock.assert_called_once()
        direct_mock.assert_not_called()

    def test_async_prefers_app_server_worker_before_backend(self) -> None:
        expected = AppServerRateLimitsResult(
            account={"type": "chatgpt"},
            rate_limits={"limitId": "codex"},
            notifications=[],
        )

        with (
            patch("app.codex_cli._read_rate_limits_via_worker_async", new=AsyncMock(return_value=expected)) as worker_mock,
            patch("app.codex_cli._read_rate_limits_via_chatgpt_backend_async", new=AsyncMock()) as backend_mock,
            patch("app.codex_cli._read_rate_limits_via_direct_api_async", new=AsyncMock()) as direct_mock,
        ):
            result = asyncio.run(read_rate_limits_for_auth_async({"auth_mode": "chatgpt"}, timeout_seconds=3.0))

        self.assertIs(result, expected)
        worker_mock.assert_awaited_once()
        backend_mock.assert_not_awaited()
        direct_mock.assert_not_awaited()

    def test_consumes_reset_with_manager_owned_access_token_only(self) -> None:
        auth_json = {
            "tokens": {
                "access_token": "access-token",
                "refresh_token": "refresh-token",
            }
        }
        worker_response = {
            "ok": True,
            "consume_result": {"outcome": "reset"},
            "rate_limits": {"rateLimitResetCredits": {"availableCount": 2}},
        }

        with patch(
            "app.codex_cli._run_worker_async",
            new=AsyncMock(return_value=worker_response),
        ) as worker_mock:
            result = asyncio.run(
                consume_rate_limit_reset_for_auth_async(
                    auth_json,
                    idempotency_key="redeem-123",
                    credit_id="credit-1",
                    timeout_seconds=3.0,
                )
            )

        self.assertEqual(result.outcome, "reset")
        payload = worker_mock.await_args.args[0]
        self.assertEqual(payload["operation"], "consume_rate_limit_reset")
        self.assertEqual(payload["idempotency_key"], "redeem-123")
        self.assertEqual(payload["credit_id"], "credit-1")
        self.assertEqual(payload["auth_json"]["tokens"]["refresh_token"], "")


if __name__ == "__main__":
    unittest.main()
