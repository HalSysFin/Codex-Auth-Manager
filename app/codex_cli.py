from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import settings

EMAIL_KEYS = [
    "email",
    "user_email",
    "userEmail",
    "account_email",
    "primary_email",
]

URL_RE = re.compile(r"https?://[^\s\"'>]+")
NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
DASH_RE = re.compile(r"-+")


class CodexCLIError(RuntimeError):
    pass


@dataclass
class LoginStartResult:
    started: bool
    pid: int | None
    started_at: str
    auth_path: str
    browser_url: str | None
    instructions: str
    output_excerpt: str | None = None


@dataclass
class LoginStatusResult:
    status: str
    auth_exists: bool
    auth_updated: bool
    auth_path: str
    started_at: str | None
    completed_at: str | None
    browser_url: str | None
    pid: int | None
    error: str | None = None


@dataclass
class _LoginState:
    started_at: datetime
    before_mtime: float | None
    process: subprocess.Popen[str] | None
    browser_url: str | None
    output_excerpt: str | None


_LOGIN_STATE: _LoginState | None = None


def start_login(capture_timeout_seconds: float = 1.2) -> LoginStartResult:
    global _LOGIN_STATE

    auth_path = settings.codex_auth_file()
    before_mtime = _mtime(auth_path)

    cmd = [settings.codex_cli_bin, "login"]
    try:
        process = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError as exc:
        raise CodexCLIError(f"codex CLI binary not found: {settings.codex_cli_bin}") from exc
    except OSError as exc:
        raise CodexCLIError(f"Unable to start codex login: {exc}") from exc

    out = ""
    err = ""
    try:
        out, err = process.communicate(timeout=capture_timeout_seconds)
        # Process ended quickly; still valid for non-interactive setups.
    except subprocess.TimeoutExpired as exc:
        out = exc.stdout or ""
        err = exc.stderr or ""

    combined = "\n".join(part for part in [out, err] if part).strip()
    browser_url = _extract_first_url(combined)

    _LOGIN_STATE = _LoginState(
        started_at=datetime.now(timezone.utc),
        before_mtime=before_mtime,
        process=process,
        browser_url=browser_url,
        output_excerpt=(combined[:1000] if combined else None),
    )

    instructions = (
        "Codex login started. Complete the browser/device login flow if prompted. "
        "Then call /auth/import-current."
    )
    if process.poll() is not None and process.returncode not in (0, None):
        instructions = "codex login exited early. Check /auth/login/status for details."

    return LoginStartResult(
        started=True,
        pid=process.pid,
        started_at=_LOGIN_STATE.started_at.isoformat(),
        auth_path=str(auth_path),
        browser_url=browser_url,
        instructions=instructions,
        output_excerpt=_LOGIN_STATE.output_excerpt,
    )


def get_login_status() -> LoginStatusResult:
    auth_path = settings.codex_auth_file()
    auth_exists = auth_path.exists()

    if _LOGIN_STATE is None:
        return LoginStatusResult(
            status="idle",
            auth_exists=auth_exists,
            auth_updated=False,
            auth_path=str(auth_path),
            started_at=None,
            completed_at=None,
            browser_url=None,
            pid=None,
        )

    updated = _has_auth_updated(_LOGIN_STATE.before_mtime, auth_path)
    process = _LOGIN_STATE.process

    if updated:
        return LoginStatusResult(
            status="complete",
            auth_exists=True,
            auth_updated=True,
            auth_path=str(auth_path),
            started_at=_LOGIN_STATE.started_at.isoformat(),
            completed_at=datetime.now(timezone.utc).isoformat(),
            browser_url=_LOGIN_STATE.browser_url,
            pid=process.pid if process else None,
        )

    if process is not None:
        rc = process.poll()
        if rc is None:
            return LoginStatusResult(
                status="pending",
                auth_exists=auth_exists,
                auth_updated=False,
                auth_path=str(auth_path),
                started_at=_LOGIN_STATE.started_at.isoformat(),
                completed_at=None,
                browser_url=_LOGIN_STATE.browser_url,
                pid=process.pid,
            )
        if rc == 0:
            return LoginStatusResult(
                status="pending",
                auth_exists=auth_exists,
                auth_updated=False,
                auth_path=str(auth_path),
                started_at=_LOGIN_STATE.started_at.isoformat(),
                completed_at=None,
                browser_url=_LOGIN_STATE.browser_url,
                pid=process.pid,
                error="codex login exited but auth.json has not changed yet",
            )
        return LoginStatusResult(
            status="failed",
            auth_exists=auth_exists,
            auth_updated=False,
            auth_path=str(auth_path),
            started_at=_LOGIN_STATE.started_at.isoformat(),
            completed_at=datetime.now(timezone.utc).isoformat(),
            browser_url=_LOGIN_STATE.browser_url,
            pid=process.pid,
            error=f"codex login exited with code {rc}",
        )

    return LoginStatusResult(
        status="pending",
        auth_exists=auth_exists,
        auth_updated=False,
        auth_path=str(auth_path),
        started_at=_LOGIN_STATE.started_at.isoformat(),
        completed_at=None,
        browser_url=_LOGIN_STATE.browser_url,
        pid=None,
    )


def read_current_auth() -> dict[str, Any]:
    auth_path = settings.codex_auth_file()
    if not auth_path.exists():
        raise CodexCLIError(f"Auth file not found at {auth_path}")

    try:
        raw = auth_path.read_text()
        parsed = json.loads(raw)
    except OSError as exc:
        raise CodexCLIError(f"Unable to read auth file: {exc}") from exc
    except ValueError as exc:
        raise CodexCLIError("Auth file is not valid JSON") from exc

    if not isinstance(parsed, dict):
        raise CodexCLIError("Auth file JSON root must be an object")

    return parsed


def wait_for_auth_update(timeout_seconds: int = 60, poll_interval_seconds: float = 1.0) -> bool:
    auth_path = settings.codex_auth_file()
    baseline = _mtime(auth_path)

    deadline = datetime.now(timezone.utc).timestamp() + timeout_seconds
    while datetime.now(timezone.utc).timestamp() < deadline:
        if _has_auth_updated(baseline, auth_path):
            return True
        # Keep dependencies minimal and avoid busy spinning.
        import time

        time.sleep(poll_interval_seconds)

    return False


def extract_email(auth_json: dict[str, Any]) -> str | None:
    found = _find_first_key(auth_json, EMAIL_KEYS)
    if found:
        return found

    # TODO: If email is absent in auth.json, call an identity endpoint using the
    # bearer access token to resolve the account email.
    return None


def derive_label(email: str, existing_labels: set[str] | None = None) -> str:
    existing = existing_labels or set()
    local_part = email.split("@", 1)[0].strip().lower() if email else ""

    base = NON_ALNUM_RE.sub("-", local_part)
    base = DASH_RE.sub("-", base).strip("-")
    if not base:
        base = "account"

    label = base
    counter = 2
    while label in existing:
        label = f"{base}-{counter}"
        counter += 1

    return label


def _find_first_key(payload: Any, keys: list[str]) -> str | None:
    if isinstance(payload, dict):
        for key in keys:
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for value in payload.values():
            found = _find_first_key(value, keys)
            if found:
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = _find_first_key(item, keys)
            if found:
                return found
    return None


def _extract_first_url(text: str) -> str | None:
    if not text:
        return None
    match = URL_RE.search(text)
    return match.group(0) if match else None


def _mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _has_auth_updated(before_mtime: float | None, auth_path: Path) -> bool:
    if not auth_path.exists():
        return False
    if before_mtime is None:
        return True
    current_mtime = _mtime(auth_path)
    return current_mtime is not None and current_mtime > before_mtime
