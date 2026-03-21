from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from app.main import auth_rename


class ProfileRenameTests(unittest.TestCase):
    def test_rename_profile_file_and_usage_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            profiles_dir = Path(tmp)
            (profiles_dir / "old.json").write_text('{"tokens": {"access_token": "x"}}')

            with (
                patch("app.main._require_internal_auth", return_value=None),
                patch("app.main.settings.codex_profiles_dir", str(profiles_dir)),
                patch("app.main.rename_account_data") as rename_usage_mock,
                patch("app.main.current_label", return_value=None),
            ):
                response = asyncio.run(
                    auth_rename(
                        request=None,  # ignored by patched auth guard
                        payload={"old_label": "old", "new_label": "new"},
                    )
                )

            self.assertFalse((profiles_dir / "old.json").exists())
            self.assertTrue((profiles_dir / "new.json").exists())
            rename_usage_mock.assert_called_once_with("old", "new")
            self.assertEqual(response.status_code, 200)

    def test_rename_rejects_invalid_label(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            profiles_dir = Path(tmp)
            (profiles_dir / "old.json").write_text("{}")

            with (
                patch("app.main._require_internal_auth", return_value=None),
                patch("app.main.settings.codex_profiles_dir", str(profiles_dir)),
            ):
                with self.assertRaises(HTTPException) as exc:
                    asyncio.run(
                        auth_rename(
                            request=None,
                            payload={"old_label": "old", "new_label": "../bad"},
                        )
                    )
            self.assertEqual(exc.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
