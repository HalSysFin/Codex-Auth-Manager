from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .account_identity import extract_access_token, extract_account_identity
from .account_usage_store import get_accounts_by_ids
from .config import settings


@dataclass
class AccountProfile:
    label: str
    path: Path
    auth: dict[str, Any]
    account_key: str = "unknown"
    subject: str | None = None
    user_id: str | None = None
    provider_account_id: str | None = None
    name: str | None = None
    access_token: str | None = None
    email: str | None = None
    rate_limit_window_type: str | None = None
    usage_limit: int | None = None
    usage_in_window: int | None = None
    rate_limit_refresh_at: str | None = None
    rate_limit_last_refreshed_at: str | None = None
    last_usage_sync_at: str | None = None
    lifetime_used: int | None = None
    usage_created_at: str | None = None
    usage_updated_at: str | None = None


def _load_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def list_profiles() -> list[AccountProfile]:
    profiles_dir = settings.profiles_dir()
    if not profiles_dir.exists():
        return []

    profiles: list[AccountProfile] = []
    for path in sorted(profiles_dir.iterdir()):
        if not path.is_file():
            continue
        auth = _load_json(path)
        if not isinstance(auth, dict):
            continue

        label = path.stem
        identity = extract_account_identity(auth)
        access_token = extract_access_token(auth)
        profiles.append(
            AccountProfile(
                label=label,
                path=path,
                auth=auth,
                account_key=identity.account_key,
                subject=identity.subject,
                user_id=identity.user_id,
                provider_account_id=identity.account_id,
                name=identity.name,
                access_token=access_token,
                email=identity.email,
            )
        )

    account_keys = sorted({profile.account_key for profile in profiles if profile.account_key})
    usage_by_id: dict[str, Any] = {}
    if account_keys:
        try:
            usage_by_id = get_accounts_by_ids(account_keys)
        except Exception:
            usage_by_id = {}

    for profile in profiles:
        usage = usage_by_id.get(profile.account_key)
        if not usage:
            continue
        profile.rate_limit_window_type = usage.rate_limit_window_type
        profile.usage_limit = usage.usage_limit
        profile.usage_in_window = usage.usage_in_window
        profile.rate_limit_refresh_at = usage.rate_limit_refresh_at
        profile.rate_limit_last_refreshed_at = usage.rate_limit_last_refreshed_at
        profile.last_usage_sync_at = usage.last_usage_sync_at
        profile.lifetime_used = usage.lifetime_used
        profile.usage_created_at = usage.created_at
        profile.usage_updated_at = usage.updated_at

    return profiles
