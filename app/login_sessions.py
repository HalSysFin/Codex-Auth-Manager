from __future__ import annotations

import json
import secrets
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Any

from .account_usage_store import get_meta_value, set_meta_value


@dataclass
class LoginSession:
    session_id: str
    relay_token: str
    auth_url: str | None
    created_at: datetime
    expires_at: datetime
    callback_payload: dict[str, Any] | None = None
    callback_received_at: datetime | None = None
    provider_error: str | None = None
    provider_error_description: str | None = None
    relay_used: bool = False
    oauth_state: str | None = None
    code_verifier: str | None = None
    redirect_uri: str | None = None
    auth_updated_at: str | None = None
    notes: list[str] = field(default_factory=list)


_LOCK = Lock()
_SESSIONS: dict[str, LoginSession] = {}
_LATEST_SESSION_ID: str | None = None
_LOGIN_SESSIONS_META_KEY = "login_sessions_json"
_LOGIN_LATEST_SESSION_META_KEY = "login_latest_session_id"


def create_login_session(
    auth_url: str | None,
    ttl_seconds: int,
    *,
    oauth_state: str | None = None,
    code_verifier: str | None = None,
    redirect_uri: str | None = None,
    auth_updated_at: str | None = None,
) -> LoginSession:
    global _LATEST_SESSION_ID

    now = datetime.now(timezone.utc)
    session = LoginSession(
        session_id=secrets.token_urlsafe(18),
        relay_token=secrets.token_urlsafe(24),
        auth_url=auth_url,
        created_at=now,
        expires_at=now + timedelta(seconds=ttl_seconds),
        oauth_state=oauth_state,
        code_verifier=code_verifier,
        redirect_uri=redirect_uri,
        auth_updated_at=auth_updated_at,
    )

    with _LOCK:
        _load_sessions_locked()
        _cleanup_expired_locked(now)
        _SESSIONS[session.session_id] = session
        _LATEST_SESSION_ID = session.session_id
        _persist_sessions_locked()

    return session


def get_login_session(session_id: str) -> LoginSession | None:
    with _LOCK:
        _load_sessions_locked()
        session = _SESSIONS.get(session_id)
        if not session:
            return None
        if _is_expired(session, datetime.now(timezone.utc)):
            _SESSIONS.pop(session_id, None)
            _persist_sessions_locked()
            return None
        return session


def inspect_login_session(session_id: str) -> tuple[str, LoginSession | None]:
    clean = (session_id or "").strip()
    if not clean:
        return "missing", None
    with _LOCK:
        _load_sessions_locked()
        session = _SESSIONS.get(clean)
        if not session:
            return "missing", None
        if _is_expired(session, datetime.now(timezone.utc)):
            _SESSIONS.pop(clean, None)
            _persist_sessions_locked()
            return "expired", None
        return "ok", session


def get_latest_session() -> LoginSession | None:
    with _LOCK:
        _load_sessions_locked()
        if _LATEST_SESSION_ID is None:
            return None
        session = _SESSIONS.get(_LATEST_SESSION_ID)
        if not session:
            return None
        if _is_expired(session, datetime.now(timezone.utc)):
            _SESSIONS.pop(session.session_id, None)
            _persist_sessions_locked()
            return None
        return session


def cancel_login_session(session_id: str | None = None) -> bool:
    global _LATEST_SESSION_ID
    with _LOCK:
        _load_sessions_locked()
        if session_id:
            removed = _SESSIONS.pop(session_id, None)
            if _LATEST_SESSION_ID == session_id:
                _LATEST_SESSION_ID = None
            _persist_sessions_locked()
            return removed is not None

        if _LATEST_SESSION_ID is None:
            return False
        removed = _SESSIONS.pop(_LATEST_SESSION_ID, None)
        _LATEST_SESSION_ID = None
        _persist_sessions_locked()
        return removed is not None


def validate_relay_token(session: LoginSession, token: str) -> bool:
    return secrets.compare_digest(session.relay_token, token)


def mark_relay_callback(
    session_id: str,
    callback_payload: dict[str, Any],
    *,
    provider_error: str | None,
    provider_error_description: str | None,
) -> tuple[str, LoginSession | None]:
    now = datetime.now(timezone.utc)
    with _LOCK:
        _load_sessions_locked()
        session = _SESSIONS.get(session_id)
        if not session:
            return "missing", None
        if _is_expired(session, now):
            _SESSIONS.pop(session_id, None)
            _persist_sessions_locked()
            return "expired", None

        if session.relay_used and session.callback_payload == callback_payload:
            return "duplicate", session
        if session.relay_used and session.callback_payload != callback_payload:
            return "consumed", None

        session.callback_payload = callback_payload
        session.callback_received_at = now
        session.provider_error = provider_error
        session.provider_error_description = provider_error_description
        session.relay_used = True
        _persist_sessions_locked()
        return "accepted", session


def session_state(
    session: LoginSession | None,
    *,
    auth_updated: bool,
    cli_failed: bool,
    cli_error: str | None,
    cli_status: str | None,
) -> tuple[str, str | None]:
    if session is None and cli_status == "idle":
        return "idle", None
    if session is not None and session.provider_error:
        return "failed", session.provider_error_description or session.provider_error
    if cli_failed:
        return "failed", cli_error
    if auth_updated:
        return "complete", None
    if session is not None and session.callback_received_at is not None:
        return "callback_received", None
    return "pending", None


def to_public_session(session: LoginSession, include_relay_token: bool = False) -> dict[str, Any]:
    payload = {
        "session_id": session.session_id,
        "auth_url": session.auth_url,
        "created_at": session.created_at.isoformat(),
        "expires_at": session.expires_at.isoformat(),
        "expires_in_seconds": max(
            int((session.expires_at - datetime.now(timezone.utc)).total_seconds()),
            0,
        ),
        "callback_received": session.callback_received_at is not None,
        "callback_received_at": session.callback_received_at.isoformat()
        if session.callback_received_at
        else None,
        "relay_used": session.relay_used,
        "provider_error": session.provider_error,
        "provider_error_description": session.provider_error_description,
    }
    if include_relay_token:
        payload["relay_token"] = session.relay_token
    return payload


def _is_expired(session: LoginSession, now: datetime) -> bool:
    return now >= session.expires_at


def _cleanup_expired_locked(now: datetime) -> None:
    expired = [sid for sid, session in _SESSIONS.items() if _is_expired(session, now)]
    for sid in expired:
        _SESSIONS.pop(sid, None)
        if _LATEST_SESSION_ID == sid:
            globals()["_LATEST_SESSION_ID"] = None


def _persist_sessions_locked() -> None:
    payload = {
        "sessions": {sid: _serialize_session(session) for sid, session in _SESSIONS.items()},
        "latest_session_id": _LATEST_SESSION_ID,
    }
    set_meta_value(_LOGIN_SESSIONS_META_KEY, json.dumps(payload, sort_keys=True))
    set_meta_value(_LOGIN_LATEST_SESSION_META_KEY, _LATEST_SESSION_ID)


def _load_sessions_locked() -> None:
    global _SESSIONS, _LATEST_SESSION_ID
    raw = get_meta_value(_LOGIN_SESSIONS_META_KEY)
    latest = get_meta_value(_LOGIN_LATEST_SESSION_META_KEY)
    sessions: dict[str, LoginSession] = {}
    if raw:
        with suppress(Exception):
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                raw_sessions = parsed.get("sessions")
                if isinstance(raw_sessions, dict):
                    for sid, payload in raw_sessions.items():
                        if not isinstance(sid, str) or not isinstance(payload, dict):
                            continue
                        session = _deserialize_session(payload)
                        if session is not None:
                            sessions[sid] = session
                if not latest:
                    latest_value = parsed.get("latest_session_id")
                    if isinstance(latest_value, str) and latest_value.strip():
                        latest = latest_value.strip()
    _SESSIONS = sessions
    _LATEST_SESSION_ID = latest.strip() if isinstance(latest, str) and latest.strip() else None
    now = datetime.now(timezone.utc)
    before = set(_SESSIONS.keys())
    _cleanup_expired_locked(now)
    if before != set(_SESSIONS.keys()):
        _persist_sessions_locked()


def _serialize_session(session: LoginSession) -> dict[str, Any]:
    return {
        "session_id": session.session_id,
        "relay_token": session.relay_token,
        "auth_url": session.auth_url,
        "created_at": session.created_at.isoformat(),
        "expires_at": session.expires_at.isoformat(),
        "callback_payload": session.callback_payload,
        "callback_received_at": (
            session.callback_received_at.isoformat() if session.callback_received_at else None
        ),
        "provider_error": session.provider_error,
        "provider_error_description": session.provider_error_description,
        "relay_used": session.relay_used,
        "oauth_state": session.oauth_state,
        "code_verifier": session.code_verifier,
        "redirect_uri": session.redirect_uri,
        "auth_updated_at": session.auth_updated_at,
        "notes": list(session.notes),
    }


def _deserialize_session(payload: dict[str, Any]) -> LoginSession | None:
    try:
        created_at = _parse_dt(payload.get("created_at"))
        expires_at = _parse_dt(payload.get("expires_at"))
    except ValueError:
        return None
    if created_at is None or expires_at is None:
        return None
    session_id = str(payload.get("session_id") or "").strip()
    relay_token = str(payload.get("relay_token") or "").strip()
    if not session_id or not relay_token:
        return None
    callback_received_at = None
    with suppress(ValueError):
        callback_received_at = _parse_dt(payload.get("callback_received_at"))
    notes = payload.get("notes")
    return LoginSession(
        session_id=session_id,
        relay_token=relay_token,
        auth_url=str(payload.get("auth_url") or "").strip() or None,
        created_at=created_at,
        expires_at=expires_at,
        callback_payload=payload.get("callback_payload") if isinstance(payload.get("callback_payload"), dict) else None,
        callback_received_at=callback_received_at,
        provider_error=str(payload.get("provider_error") or "").strip() or None,
        provider_error_description=str(payload.get("provider_error_description") or "").strip() or None,
        relay_used=bool(payload.get("relay_used")),
        oauth_state=str(payload.get("oauth_state") or "").strip() or None,
        code_verifier=str(payload.get("code_verifier") or "").strip() or None,
        redirect_uri=str(payload.get("redirect_uri") or "").strip() or None,
        auth_updated_at=str(payload.get("auth_updated_at") or "").strip() or None,
        notes=list(notes) if isinstance(notes, list) else [],
    )


def _parse_dt(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
