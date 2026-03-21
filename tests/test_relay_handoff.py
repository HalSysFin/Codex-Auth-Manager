from __future__ import annotations

import io
import unittest
from unittest.mock import patch

from app.codex_cli import relay_callback_to_login


class _FakeResponse:
    def __init__(self, status: int = 200, body: bytes = b"ok") -> None:
        self.status = status
        self._body = body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def read(self, _size: int = -1) -> bytes:
        return self._body


class RelayHandoffTests(unittest.TestCase):
    def test_relay_callback_delivers_to_local_listener(self) -> None:
        payload = {
            "full_url": "http://localhost:1455/auth/callback?code=abc&state=xyz",
            "code": "abc",
            "state": "xyz",
        }
        with patch("urllib.request.urlopen", return_value=_FakeResponse(status=200, body=b"ok")) as urlopen:
            result = relay_callback_to_login(payload)
        self.assertTrue(result["attempted"])
        self.assertTrue(result["supported"])
        self.assertTrue(result["completed"])
        self.assertEqual(result["http_status"], 200)
        self.assertIn("Callback delivered", result["message"])
        self.assertEqual(urlopen.call_count, 1)

    def test_relay_callback_rejects_non_localhost_url(self) -> None:
        payload = {"full_url": "https://evil.example/auth/callback?code=abc&state=xyz"}
        result = relay_callback_to_login(payload)
        self.assertFalse(result["attempted"])
        self.assertTrue(result["supported"])
        self.assertFalse(result["completed"])
        self.assertIn("localhost", result["message"].lower())

    def test_relay_callback_can_build_url_from_code_state(self) -> None:
        payload = {"code": "abc", "state": "xyz"}
        with (
            patch("app.codex_cli.settings.openai_redirect_uri", "http://localhost:1455/auth/callback"),
            patch("urllib.request.urlopen", return_value=_FakeResponse(status=200, body=b"ok")),
        ):
            result = relay_callback_to_login(payload)
        self.assertTrue(result["attempted"])
        self.assertTrue(result["completed"])
        self.assertIn("code=abc", result["url"])
        self.assertIn("state=xyz", result["url"])


if __name__ == "__main__":
    unittest.main()
