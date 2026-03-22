from __future__ import annotations

import asyncio
import json
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from app.accounts import AccountProfile
from app.main import (
    _compute_modeled_consumption_per_account,
    _parse_history_range,
    api_account_history,
    api_usage_history,
)


def _json_body(response) -> dict:
    return json.loads(response.body.decode("utf-8"))


class UsageHistoryApiTests(unittest.TestCase):
    def test_parse_history_range_uses_local_midnight_for_1d(self) -> None:
        class FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                base = cls(2026, 3, 22, 20, 30, tzinfo=timezone.utc)
                if tz is None:
                    return base.replace(tzinfo=None)
                return base.astimezone(tz)

        with (
            patch("app.main.datetime", FixedDateTime),
            patch("app.main.settings.analytics_timezone", "Europe/London"),
        ):
            selected_range, since_dt = _parse_history_range("1d")

        self.assertEqual(selected_range, "1d")
        self.assertEqual(since_dt.isoformat(), "2026-03-21T23:00:00+00:00")

    def test_usage_history_returns_cumulative_and_daily_series(self) -> None:
        profile = AccountProfile(
            label="max",
            path=Path("/tmp/max.json"),
            auth={},
            account_key="acct:max",
            email="max@example.com",
        )
        snapshots = [
            {"account_id": "acct:max", "captured_at": "2026-03-20T10:00:00+00:00", "lifetime_used": 100},
            {"account_id": "acct:max", "captured_at": "2026-03-21T10:00:00+00:00", "lifetime_used": 130},
            {"account_id": "acct:max", "captured_at": "2026-03-22T10:00:00+00:00", "lifetime_used": 170},
        ]
        with (
            patch("app.main._require_internal_auth", return_value=None),
            patch("app.main._dedupe_profiles", return_value=[profile]),
            patch("app.main.list_profiles", return_value=[profile]),
            patch("app.main._touch_profiles_usage", return_value=None),
            patch("app.main._build_cached_accounts_snapshot", return_value={
                "accounts": [{"account_key": "acct:max", "label": "max", "display_label": "max", "email": "max@example.com", "refresh_status": {}}],
                "current_label": "max",
                "aggregate": {
                    "total_current_window_used": 10,
                    "total_current_window_limit": 100,
                    "total_remaining": 90,
                    "stale_accounts": 0,
                    "failed_accounts": 0,
                    "last_refresh_time": "2026-03-22T10:00:00+00:00",
                },
            }),
            patch("app.main.list_absolute_usage_snapshots", return_value=snapshots),
            patch("app.main.list_usage_rollovers", return_value=[]),
        ):
            response = asyncio.run(api_usage_history(request=None, range="30d"))
        payload = _json_body(response)
        self.assertEqual(payload["range"], "30d")
        self.assertIn("summary", payload)
        self.assertIn("series", payload)
        self.assertTrue(len(payload["series"]["daily_usage"]) >= 1)
        self.assertTrue(len(payload["series"]["cumulative_usage"]) >= 1)

    def test_account_history_returns_current_state_and_completed_windows(self) -> None:
        profile = AccountProfile(
            label="james",
            path=Path("/tmp/james.json"),
            auth={},
            account_key="acct:james",
            email="james@example.com",
        )
        with (
            patch("app.main._require_internal_auth", return_value=None),
            patch("app.main._profile_for_label", return_value=profile),
            patch("app.main._touch_account_usage", return_value=None),
            patch("app.main._usage_tracking_payload", return_value={
                "usage_in_window": 20,
                "usage_limit": 100,
                "lifetime_used": 220,
                "rate_limit_refresh_at": "2026-03-23T00:00:00+00:00",
                "last_usage_sync_at": "2026-03-22T10:00:00+00:00",
            }),
            patch("app.main.list_usage_rollovers", return_value=[
                {
                    "window_started_at": "2026-03-21T00:00:00+00:00",
                    "window_ended_at": "2026-03-22T00:00:00+00:00",
                    "usage_used": 80,
                    "usage_limit": 100,
                    "usage_wasted": 20,
                    "rolled_over_at": "2026-03-22T00:00:05+00:00",
                }
            ]),
            patch("app.main.list_absolute_usage_snapshots", return_value=[
                {"account_id": "acct:james", "captured_at": "2026-03-21T10:00:00+00:00", "lifetime_used": 200},
                {"account_id": "acct:james", "captured_at": "2026-03-22T10:00:00+00:00", "lifetime_used": 220},
            ]),
        ):
            response = asyncio.run(api_account_history(request=None, label="james", range="30d"))
        payload = _json_body(response)
        self.assertEqual(payload["label"], "james")
        self.assertIn("current_state", payload)
        self.assertIn("consumption_trend", payload)
        self.assertIn("completed_windows", payload)
        self.assertEqual(payload["current_state"]["usage_in_window"], 20)
        self.assertEqual(len(payload["completed_windows"]), 1)
        self.assertIn("summary", payload)
        self.assertTrue(payload["summary"]["absolute_usage_available"])
        self.assertEqual(payload["summary"]["current_total_used"], 20)

    def test_account_history_fallback_uses_modeled_snapshot_values(self) -> None:
        profile = AccountProfile(
            label="louis",
            path=Path("/tmp/louis.json"),
            auth={},
            account_key="acct:louis",
            email="louis@example.com",
        )
        with (
            patch("app.main._require_internal_auth", return_value=None),
            patch("app.main._profile_for_label", return_value=profile),
            patch("app.main._touch_account_usage", return_value=None),
            patch("app.main._usage_tracking_payload", return_value={
                "usage_in_window": 0,
                "usage_limit": 0,
                "lifetime_used": 0,
                "secondary_used_percent": 44.2,
                "updated_at": "2026-03-22T20:40:00+00:00",
            }),
            patch("app.main._refresh_status_payload", return_value={"state": "ok", "last_success_at": "2026-03-22T20:40:00+00:00", "is_stale": False}),
            patch("app.main.list_usage_rollovers", return_value=[]),
            patch("app.main.list_absolute_usage_snapshots", return_value=[]),
            patch("app.main.list_usage_snapshots", return_value=[
                {"account_id": "acct:louis", "captured_at": "2026-03-22T18:00:00+00:00", "secondary_used_percent": 55.0},
                {"account_id": "acct:louis", "captured_at": "2026-03-22T20:00:00+00:00", "secondary_used_percent": 44.2},
            ]),
        ):
            response = asyncio.run(api_account_history(request=None, label="louis", range="1d"))

        payload = _json_body(response)
        self.assertEqual(payload["range"], "1d")
        self.assertEqual(payload["range_metadata"]["label"], "Today")
        self.assertTrue(payload["summary"]["fallback_mode"])
        self.assertFalse(payload["summary"]["absolute_usage_available"])
        self.assertEqual(
            payload["summary"]["modeled_usage_basis"],
            "normalized_100_units_from_utilization_snapshots",
        )
        self.assertEqual(payload["summary"]["total_consumed_in_range"], 0.0)
        self.assertEqual(payload["summary"]["current_total_used"], 44.2)
        self.assertEqual(payload["summary"]["current_total_limit"], 100.0)
        self.assertEqual(payload["summary"]["current_total_remaining"], 55.8)
        self.assertEqual(payload["current_state"]["usage_in_window"], 44.2)
        self.assertEqual(payload["current_state"]["usage_limit"], 100.0)
        self.assertEqual(payload["current_state"]["remaining"], 55.8)
        self.assertEqual(payload["summary"]["last_refresh_label"], "Last snapshot refresh")
        self.assertEqual(payload["consumption_trend"]["daily_usage"], [])
        self.assertTrue(len(payload["consumption_trend"]["hourly_weekly_utilization"]) >= 1)

    def test_account_history_1d_uses_local_midnight_boundary(self) -> None:
        profile = AccountProfile(
            label="max",
            path=Path("/tmp/max.json"),
            auth={},
            account_key="acct:max",
            email="max@example.com",
        )

        class FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                base = cls(2026, 3, 22, 20, 30, tzinfo=timezone.utc)
                if tz is None:
                    return base.replace(tzinfo=None)
                return base.astimezone(tz)

        with (
            patch("app.main.datetime", FixedDateTime),
            patch("app.main.settings.analytics_timezone", "Europe/London"),
            patch("app.main._require_internal_auth", return_value=None),
            patch("app.main._profile_for_label", return_value=profile),
            patch("app.main._touch_account_usage", return_value=None),
            patch("app.main._usage_tracking_payload", return_value={
                "usage_in_window": 10,
                "usage_limit": 100,
                "lifetime_used": 170,
                "last_usage_sync_at": "2026-03-22T20:00:00+00:00",
            }),
            patch("app.main._refresh_status_payload", return_value={"state": "ok", "is_stale": False}),
            patch("app.main.list_usage_rollovers", return_value=[]),
            patch("app.main.list_usage_snapshots", return_value=[]),
            patch("app.main.list_absolute_usage_snapshots", return_value=[
                {"account_id": "acct:max", "captured_at": "2026-03-21T22:30:00+00:00", "lifetime_used": 100},
                {"account_id": "acct:max", "captured_at": "2026-03-21T23:30:00+00:00", "lifetime_used": 110},
                {"account_id": "acct:max", "captured_at": "2026-03-22T10:00:00+00:00", "lifetime_used": 140},
                {"account_id": "acct:max", "captured_at": "2026-03-22T20:00:00+00:00", "lifetime_used": 170},
            ]),
        ):
            response = asyncio.run(api_account_history(request=None, label="max", range="1d"))

        payload = _json_body(response)
        self.assertEqual(payload["range_metadata"]["label"], "Today")
        self.assertEqual(payload["consumption_trend"]["daily_usage"], [{"day": "2026-03-22", "consumed": 60}])

    def test_usage_history_fallback_uses_modeled_snapshot_values(self) -> None:
        profile = AccountProfile(
            label="hayden",
            path=Path("/tmp/hayden.json"),
            auth={},
            account_key="acct:hayden",
            email="hayden@example.com",
        )
        with (
            patch("app.main._require_internal_auth", return_value=None),
            patch("app.main._dedupe_profiles", return_value=[profile]),
            patch("app.main.list_profiles", return_value=[profile]),
            patch("app.main._touch_profiles_usage", return_value=None),
            patch("app.main._build_cached_accounts_snapshot", return_value={
                "accounts": [{
                    "account_key": "acct:hayden",
                    "label": "hayden",
                    "display_label": "hayden",
                    "email": "hayden@example.com",
                    "refresh_status": {},
                    "usage_tracking": {"secondary_used_percent": 31.89},
                }],
                "current_label": "hayden",
                "aggregate": {
                    "total_current_window_used": 0,
                    "total_current_window_limit": 0,
                    "total_remaining": 0,
                    "stale_accounts": 0,
                    "failed_accounts": 0,
                    "last_refresh_time": "2026-03-22T20:50:25.528974+00:00",
                },
            }),
            patch("app.main.list_absolute_usage_snapshots", return_value=[
                {
                    "account_id": "acct:hayden",
                    "captured_at": "2026-03-22T10:00:00+00:00",
                    "usage_in_window": 0,
                    "usage_limit": 0,
                    "lifetime_used": 0,
                }
            ]),
            patch("app.main.list_usage_rollovers", return_value=[]),
            patch("app.main.list_usage_snapshots", return_value=[
                {"account_id": "acct:hayden", "captured_at": "2026-03-22T19:00:00+00:00", "secondary_used_percent": 34.6},
                {"account_id": "acct:hayden", "captured_at": "2026-03-22T20:00:00+00:00", "secondary_used_percent": 31.89},
            ]),
        ):
            response = asyncio.run(api_usage_history(request=None, range="1d"))

        payload = _json_body(response)
        self.assertTrue(payload["summary"]["fallback_mode"])
        self.assertFalse(payload["summary"]["absolute_usage_available"])
        self.assertEqual(
            payload["summary"]["modeled_usage_basis"],
            "normalized_100_units_from_utilization_snapshots",
        )
        self.assertEqual(payload["summary"]["total_consumed_in_range"], 0.0)
        self.assertEqual(payload["summary"]["current_total_used"], 31.89)
        self.assertEqual(payload["summary"]["current_total_limit"], 100.0)
        self.assertEqual(payload["summary"]["current_total_remaining"], 68.11)
        self.assertEqual(payload["summary"]["last_refresh_time"], "2026-03-22T20:50:25.528974+00:00")
        self.assertTrue(payload["sections"]["top_consuming_accounts_available"])
        self.assertEqual(payload["sections"]["top_consuming_accounts"][0]["account_key"], "acct:hayden")
        self.assertEqual(payload["sections"]["top_consuming_accounts"][0]["consumed"], 0.0)
        self.assertEqual(payload["series"]["daily_usage"], [])
        self.assertTrue(len(payload["series"]["hourly_weekly_utilization"]) >= 1)

    def test_modeled_consumption_ignores_resets_and_keeps_positive_deltas(self) -> None:
        snapshots = [
            {"account_id": "acct:max", "captured_at": "2026-03-22T00:10:00+00:00", "secondary_used_percent": 40.0},
            {"account_id": "acct:max", "captured_at": "2026-03-22T01:10:00+00:00", "secondary_used_percent": 52.0},
            {"account_id": "acct:max", "captured_at": "2026-03-22T02:10:00+00:00", "secondary_used_percent": 3.0},
            {"account_id": "acct:max", "captured_at": "2026-03-22T03:10:00+00:00", "secondary_used_percent": 11.0},
        ]

        modeled = _compute_modeled_consumption_per_account(
            snapshots=snapshots,
            since_dt=datetime(2026, 3, 22, 0, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(modeled["acct:max"], {"2026-03-22": 20.0})


if __name__ == "__main__":
    unittest.main()
