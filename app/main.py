from __future__ import annotations

import hmac
import ipaddress
import json
import logging
import secrets
from hashlib import sha256
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from .accounts import AccountProfile, list_profiles
from .auth_store import (
    AuthStoreError,
    persist_and_save_label,
    persist_current_auth,
    save_current_auth_under_label,
)
from .codex_cli import (
    CodexCLIError,
    derive_label,
    extract_email,
    get_login_status,
    read_rate_limits_via_app_server,
    read_current_auth,
    relay_callback_to_login,
    start_login,
    wait_for_auth_update,
)
from .codex_switch import (
    CodexSwitchError,
    current_label,
    list_labels,
    switch_label,
)
from .config import settings
from .login_sessions import (
    create_login_session,
    get_latest_session,
    get_login_session,
    mark_relay_callback,
    session_state,
    to_public_session,
    validate_relay_token,
)

app = FastAPI(title="Codex Auth Manager", version="0.2.0")
logger = logging.getLogger(__name__)


@app.middleware("http")
async def web_login_guard(request: Request, call_next):
    if not _web_login_enabled():
        return await call_next(request)
    if _is_login_exempt_path(request.url.path):
        return await call_next(request)
    if _is_internal_request(request):
        return await call_next(request)
    if _has_valid_internal_api_token(request):
        return await call_next(request)
    if _has_valid_web_session(request):
        return await call_next(request)

    if request.url.path.startswith("/api/") or request.url.path.startswith("/auth/"):
        return JSONResponse({"detail": "Login required"}, status_code=401)

    next_path = request.url.path
    if request.url.query:
        next_path = f"{next_path}?{request.url.query}"
    return RedirectResponse(url=f"/login?next={quote(next_path, safe='/?=&')}", status_code=303)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/login")
async def login_page(next: str = "/") -> HTMLResponse:
    if not _web_login_enabled():
        return RedirectResponse(url=next or "/", status_code=303)
    return HTMLResponse(_render_login(next))


@app.post("/login")
async def login_submit(request: Request) -> RedirectResponse:
    if not _web_login_enabled():
        return RedirectResponse(url="/", status_code=303)

    content_type = request.headers.get("content-type", "")
    username = ""
    password = ""
    next_path = "/"

    if "application/json" in content_type:
        payload = await request.json()
        if isinstance(payload, dict):
            username = str(payload.get("username", "")).strip()
            password = str(payload.get("password", ""))
            next_path = str(payload.get("next", "/")) or "/"
    else:
        raw = (await request.body()).decode("utf-8", errors="replace")
        parsed = parse_qs(raw, keep_blank_values=True)
        username = (parsed.get("username", [""])[0] or "").strip()
        password = parsed.get("password", [""])[0] or ""
        next_path = parsed.get("next", ["/"])[0] or "/"

    if not _verify_web_credentials(username, password):
        return RedirectResponse(
            url=f"/login?next={quote(next_path, safe='/?=&')}&error=1", status_code=303
        )

    response = RedirectResponse(url=_safe_next_path(next_path), status_code=303)
    _set_web_session_cookie(request, response)
    return response


@app.post("/logout")
async def logout(request: Request) -> RedirectResponse:
    response = RedirectResponse(url="/login", status_code=303)
    response.delete_cookie(settings.web_login_cookie_name, path="/")
    return response


@app.get("/")
async def index() -> HTMLResponse:
    return HTMLResponse(_render_index())


@app.get("/ui")
async def ui() -> HTMLResponse:
    return HTMLResponse(_render_index())


@app.get("/oauth/callback")
async def oauth_callback(request: Request) -> JSONResponse:
    received = dict(request.query_params)
    stored_at = _store_callback(received)
    return JSONResponse(
        {
            "received": received,
            "stored_at": str(stored_at),
            "next": "POST /auth/exchange with code + code_verifier (optional)",
        }
    )


@app.post("/oauth/callback")
async def oauth_callback_post(request: Request, payload: dict[str, Any]) -> JSONResponse:
    stored_at = _store_callback(payload)

    label = payload.get("label")
    auth_json = payload.get("auth_json")

    if label and auth_json:
        _require_internal_auth(request)
        _persist_auth_and_save(str(label), auth_json)
        return JSONResponse(
            {
                "stored_at": str(stored_at),
                "saved_label": str(label),
                "message": "Auth saved and codex-switch profile updated.",
            }
        )

    return JSONResponse(
        {
            "stored_at": str(stored_at),
            "message": "Callback captured. To save, POST /auth/save.",
        }
    )


@app.get("/auth/callback")
async def auth_callback(request: Request) -> JSONResponse:
    return await oauth_callback(request)


@app.post("/auth/callback")
async def auth_callback_post(request: Request, payload: dict[str, Any]) -> JSONResponse:
    return await oauth_callback_post(request, payload)


@app.post("/auth/login/start")
async def auth_login_start(request: Request) -> JSONResponse:
    _require_internal_auth(request)
    return _start_login_response()


@app.post("/auth/login/start-relay")
async def auth_login_start_relay() -> JSONResponse:
    # Extension-facing start endpoint; session/relay token still gates callback relay.
    return _start_login_response()


def _start_login_response() -> JSONResponse:
    try:
        result = start_login()
    except CodexCLIError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    auth_url = result.browser_url
    session = create_login_session(
        auth_url=auth_url, ttl_seconds=settings.login_session_ttl_seconds
    )

    return JSONResponse(
        {
            "status": "started",
            "auth_path": result.auth_path,
            "pid": result.pid,
            "started_at": result.started_at,
            "browser_url": result.browser_url,
            "auth_url": auth_url,
            "session_id": session.session_id,
            "relay_token": session.relay_token,
            "session_expires_at": session.expires_at.isoformat(),
            "instructions": result.instructions,
            "output_excerpt": result.output_excerpt,
            "session": to_public_session(session, include_relay_token=True),
        }
    )


@app.get("/auth/login/status")
async def auth_login_status(wait_seconds: int = 0, session_id: str | None = None) -> JSONResponse:
    if wait_seconds > 0:
        wait_for_auth_update(timeout_seconds=min(wait_seconds, 120))

    session = get_login_session(session_id) if session_id else get_latest_session()
    if session_id and session is None:
        raise HTTPException(status_code=404, detail="Login session not found or expired")
    result = get_login_status()
    state, state_error = session_state(
        session,
        auth_updated=result.auth_updated,
        cli_failed=result.status == "failed",
        cli_error=result.error,
        cli_status=result.status,
    )
    callback_received = bool(session is not None and session.callback_received_at is not None)
    relay_stage = "not_received"
    if callback_received and result.auth_updated:
        relay_stage = "relayed_and_auth_updated"
    elif callback_received and not result.auth_updated:
        relay_stage = "relayed_waiting_for_auth_update"
    elif session is not None and session.provider_error:
        relay_stage = "provider_error"

    return JSONResponse(
        {
            "status": state,
            "session_id": session.session_id if session else None,
            "auth": {
                "exists": result.auth_exists,
                "updated": result.auth_updated,
                "path": result.auth_path,
            },
            "callback_received": callback_received,
            "session": to_public_session(session) if session else None,
            "started_at": result.started_at,
            "completed_at": result.completed_at,
            "pid": result.pid,
            "browser_url": result.browser_url,
            "error": state_error or result.error,
            "raw_cli_status": result.status,
            "relay": {
                "stage": relay_stage,
                "callback_received": callback_received,
                "callback_received_at": (
                    session.callback_received_at.isoformat()
                    if session and session.callback_received_at
                    else None
                ),
                "provider_error": session.provider_error if session else None,
                "provider_error_description": (
                    session.provider_error_description if session else None
                ),
                "auth_updated": result.auth_updated,
                "cli_status": result.status,
                "handoff_supported": False,
                "finalization_supported": False,
                "next_action": (
                    "Relay callback captured. Direct CLI callback handoff is not implemented; "
                    "finalize auth in CLI/manual flow, then run POST /auth/import-current."
                    if callback_received and not result.auth_updated
                    else (
                        "Run POST /auth/import-current to save this auth into codex-switch profiles."
                        if result.auth_updated
                        else None
                    )
                ),
            },
        }
    )


@app.post("/auth/relay-callback")
async def auth_relay_callback(payload: dict[str, Any]) -> JSONResponse:
    session_id = str(payload.get("session_id", "")).strip()
    relay_token = str(payload.get("relay_token", "")).strip()
    code = payload.get("code")
    state = payload.get("state")
    error = payload.get("error")
    error_description = payload.get("error_description")
    full_url = str(payload.get("full_url", "")).strip()

    if not session_id or not relay_token:
        logger.warning("relay-callback rejected: missing session_id or relay_token")
        raise HTTPException(
            status_code=400, detail="session_id and relay_token are required"
        )
    if not full_url:
        logger.warning("relay-callback rejected: missing full_url for session_id=%s", session_id)
        raise HTTPException(status_code=400, detail="full_url is required")
    if not code and not error:
        logger.warning(
            "relay-callback rejected: missing code/error for session_id=%s",
            session_id,
        )
        raise HTTPException(
            status_code=400, detail="code or error must be present in callback payload"
        )

    session = get_login_session(session_id)
    if session is None:
        logger.warning("relay-callback rejected: session not found or expired session_id=%s", session_id)
        raise HTTPException(status_code=404, detail="Login session not found or expired")
    if not validate_relay_token(session, relay_token):
        logger.warning("relay-callback rejected: invalid relay token session_id=%s", session_id)
        raise HTTPException(status_code=403, detail="Invalid relay token")

    callback_payload = {
        "code": code,
        "state": state,
        "error": error,
        "error_description": error_description,
        "full_url": full_url,
        "relayed_at": datetime.now(timezone.utc).isoformat(),
    }

    updated = mark_relay_callback(
        session_id,
        callback_payload,
        provider_error=(str(error) if error else None),
        provider_error_description=(
            str(error_description) if error_description else None
        ),
    )
    if updated is None:
        logger.warning("relay-callback rejected: session already consumed session_id=%s", session_id)
        raise HTTPException(
            status_code=409,
            detail="Session has already consumed a different callback or has expired",
        )

    _store_callback({"type": "relay_callback", "session_id": session_id, "payload": callback_payload})
    handoff = relay_callback_to_login(callback_payload)
    logger.info(
        "relay-callback accepted session_id=%s provider_error=%s handoff_supported=%s",
        session_id,
        bool(error),
        bool(handoff.get("supported")),
    )

    return JSONResponse(
        {
            "status": "callback_received",
            "session": to_public_session(updated),
            "handoff": handoff,
        }
    )


@app.post("/auth/import-current")
async def import_current_auth(request: Request, payload: dict[str, Any] | None = None) -> JSONResponse:
    _require_internal_auth(request)
    desired_label = (payload or {}).get("label") if payload else None

    try:
        auth_json = read_current_auth()
    except CodexCLIError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    email = extract_email(auth_json)
    existing = set(list_labels())

    if desired_label:
        label = str(desired_label).strip()
        if not label:
            raise HTTPException(status_code=400, detail="label cannot be empty")
    else:
        label = derive_label(email or "account", existing_labels=existing)

    try:
        # Keep current auth.json as the active source of truth, then save profile.
        persist_current_auth(auth_json)
        switch_save = save_current_auth_under_label(label)
    except (AuthStoreError, CodexSwitchError) as exc:
        raise _to_switch_http_error(exc) from exc

    return JSONResponse(
        {
            "status": "imported",
            "label": label,
            "email": email,
            "saved": True,
            "codex_switch": {
                "command": switch_save.command,
                "exit_code": switch_save.returncode,
                "stdout": switch_save.stdout,
            },
        }
    )


@app.post("/auth/switch")
async def auth_switch(request: Request, payload: dict[str, Any]) -> JSONResponse:
    _require_internal_auth(request)
    label = str(payload.get("label", "")).strip()
    if not label:
        raise HTTPException(status_code=400, detail="label is required")

    try:
        result = switch_label(label)
        now_current = _resolve_current_label(read_current_auth(), list_profiles())
    except CodexSwitchError as exc:
        raise _to_switch_http_error(exc) from exc
    except CodexCLIError:
        now_current = None

    return JSONResponse(
        {
            "status": "switched",
            "label": label,
            "current_label": now_current or label,
            "codex_switch": {
                "command": result.command,
                "exit_code": result.returncode,
                "stdout": result.stdout,
            },
        }
    )


@app.get("/auth/current")
async def auth_current() -> JSONResponse:
    auth_path = settings.codex_auth_file()
    meta = _auth_file_metadata(auth_path)

    if not meta["exists"]:
        return JSONResponse(
            {
                "auth": meta,
                "email": None,
                "current_label": None,
                "status": "missing",
            }
        )

    try:
        auth_json = read_current_auth()
        email = extract_email(auth_json)
        current = _resolve_current_label(auth_json, list_profiles())
    except CodexCLIError as exc:
        return JSONResponse(
            {
                "auth": meta,
                "email": None,
                "current_label": None,
                "status": "invalid",
                "error": str(exc),
            }
        )

    return JSONResponse(
        {
            "auth": meta,
            "email": email,
            "current_label": current,
            "current_display_label": _display_label(current, email),
            "status": "ok",
        }
    )


@app.get("/auth/rate-limits")
async def auth_rate_limits(request: Request) -> JSONResponse:
    _require_internal_auth(request)
    try:
        result = read_rate_limits_via_app_server()
    except CodexCLIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return JSONResponse(
        {
            "source": "codex_app_server",
            "account": result.account,
            "rate_limits": result.rate_limits,
            "notifications": result.notifications,
        }
    )


@app.get("/auth/export")
async def auth_export(request: Request, label: str) -> JSONResponse:
    _require_internal_auth(request)
    profile = _profile_for_label(label)
    if profile is None:
        raise HTTPException(status_code=404, detail="Label not found")

    return JSONResponse(
        {
            "label": profile.label,
            "email": profile.email,
            "auth_json": profile.auth,
        }
    )


@app.post("/auth/save")
async def save_auth(request: Request, payload: dict[str, Any]) -> JSONResponse:
    _require_internal_auth(request)
    label = payload.get("label")
    auth_json = payload.get("auth_json")

    if not label or not auth_json:
        raise HTTPException(status_code=400, detail="label and auth_json are required")

    _persist_auth_and_save(str(label), auth_json)
    return JSONResponse({"saved_label": str(label), "message": "Auth saved."})


@app.post("/auth/exchange")
async def exchange_code(request: Request, payload: dict[str, Any]) -> JSONResponse:
    _require_internal_auth(request)
    code = payload.get("code")
    code_verifier = payload.get("code_verifier")
    label = payload.get("label")
    redirect_uri = payload.get("redirect_uri") or settings.openai_redirect_uri

    if not code or not code_verifier:
        raise HTTPException(
            status_code=400, detail="code and code_verifier are required"
        )

    token_response = await _exchange_code_for_token(str(code), str(code_verifier), redirect_uri)

    stored_at = _store_callback(
        {
            "type": "token_response",
            "received_at": datetime.now(timezone.utc).isoformat(),
            "token_response": token_response,
        }
    )

    if label:
        _persist_auth_and_save(str(label), token_response)
        return JSONResponse(
            {
                "stored_at": str(stored_at),
                "saved_label": str(label),
                "token_response": token_response,
            }
        )

    return JSONResponse({"stored_at": str(stored_at), "token_response": token_response})


@app.get("/api/accounts")
async def api_accounts(request: Request) -> JSONResponse:
    _require_internal_auth(request)
    profiles = list_profiles()

    current = None
    try:
        current = _resolve_current_label(read_current_auth(), profiles)
    except CodexCLIError:
        current = None

    probe_by_label: dict[str, dict[str, Any]] = {}
    async with httpx.AsyncClient(timeout=10) as client:
        for profile in profiles:
            if profile.access_token:
                rate_info = await _fetch_rate_limits(client, profile.access_token)
            else:
                rate_info = {"error": "No access token found"}
            probe_by_label[profile.label] = rate_info

    session_by_label = _fetch_session_limits_for_profiles(
        profiles, baseline_auth=_safe_read_current_auth()
    )

    results: list[dict[str, Any]] = []
    for profile in profiles:
        rate_info = probe_by_label.get(profile.label, {})
        if _has_limit_data(rate_info):
            final_rate_info = rate_info
        else:
            final_rate_info = session_by_label.get(profile.label, rate_info)

        results.append(
            {
                "label": profile.label,
                "display_label": _display_label(profile.label, profile.email),
                "email": profile.email,
                "is_current": profile.label == current,
                "rate_limits": final_rate_info,
            }
        )

    return JSONResponse({"accounts": results, "current_label": current})


@app.get("/api/public-stats")
async def api_public_stats() -> JSONResponse:
    profiles = list_profiles()
    auth_meta = _auth_file_metadata(settings.codex_auth_file())
    login = get_login_status()

    profiles_with_tokens = sum(1 for p in profiles if bool(p.access_token))
    profiles_with_email = sum(1 for p in profiles if bool(p.email))

    return JSONResponse(
        {
            "accounts_managed": len(profiles),
            "profiles_with_tokens": profiles_with_tokens,
            "profiles_with_email": profiles_with_email,
            "auth_file": {
                "exists": auth_meta["exists"],
                "modified_at": auth_meta["modified_at"],
            },
            "login_status": login.status,
        }
    )


@app.get("/internal/auths")
async def internal_auths(request: Request, label: str | None = None) -> JSONResponse:
    _require_internal_auth(request)
    profiles = list_profiles()

    if label:
        profile = _profile_for_label(label)
        if profile is None:
            raise HTTPException(status_code=404, detail="Label not found")
        return JSONResponse({"label": profile.label, "auth_json": profile.auth})

    return JSONResponse(
        {
            "accounts": [
                {"label": profile.label, "auth_json": profile.auth}
                for profile in profiles
            ]
        }
    )


def _persist_auth_and_save(label: str, auth_json: Any) -> None:
    try:
        persist_and_save_label(label, auth_json)
    except (AuthStoreError, CodexSwitchError) as exc:
        raise _to_switch_http_error(exc) from exc


def _to_switch_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, CodexSwitchError):
        return HTTPException(
            status_code=500,
            detail={
                "message": str(exc),
                "command": exc.command,
                "exit_code": exc.exit_code,
                "stderr": exc.stderr or None,
            },
        )
    return HTTPException(status_code=500, detail=str(exc))


def _store_callback(payload: Any) -> Path:
    callback_dir = settings.callback_dir()
    callback_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    filename = f"callback-{timestamp}.json"
    path = callback_dir / filename

    try:
        path.write_text(json.dumps(payload, indent=2, sort_keys=True))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Unable to store callback: {exc}") from exc

    return path


async def _exchange_code_for_token(
    code: str, code_verifier: str, redirect_uri: str | None
) -> dict[str, Any]:
    if not settings.openai_token_url or not settings.openai_client_id:
        raise HTTPException(
            status_code=400,
            detail="OPENAI_TOKEN_URL and OPENAI_CLIENT_ID must be configured",
        )

    data: dict[str, str] = {
        "grant_type": "authorization_code",
        "client_id": settings.openai_client_id,
        "code": code,
        "code_verifier": code_verifier,
    }

    if redirect_uri:
        data["redirect_uri"] = redirect_uri

    if settings.openai_client_secret:
        data["client_secret"] = settings.openai_client_secret

    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(
            settings.openai_token_url,
            data=data,
            headers={"Accept": "application/json"},
        )

    if response.status_code >= 400:
        raise HTTPException(
            status_code=response.status_code,
            detail=response.text.strip() or "Token exchange failed",
        )

    try:
        return response.json()
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Invalid token response") from exc


def _require_internal_auth(request: Request) -> None:
    configured_token = (settings.internal_api_token or "").strip()
    if not configured_token:
        raise HTTPException(
            status_code=503,
            detail="API key is required for this action, but INTERNAL_API_TOKEN is not configured on the server.",
        )

    if _has_valid_internal_api_token(request):
        return
    if request.headers.get("authorization", "").lower().startswith("bearer "):
        raise HTTPException(status_code=403, detail="Invalid API key")
    if request.headers.get("x-api-key", "").strip():
        raise HTTPException(status_code=403, detail="Invalid API key")

    raise HTTPException(
        status_code=401,
        detail="API key required. Provide Authorization: Bearer <token> or X-API-Key header.",
    )


def _has_valid_internal_api_token(request: Request) -> bool:
    configured_token = (settings.internal_api_token or "").strip()
    if not configured_token:
        return False

    x_api_key = request.headers.get("x-api-key", "").strip()
    if x_api_key:
        return secrets.compare_digest(x_api_key, configured_token)

    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        token = auth_header.split(" ", 1)[1].strip()
        return secrets.compare_digest(token, configured_token)
    return False


def _web_login_enabled() -> bool:
    return bool(
        (settings.web_login_username or "").strip()
        and (settings.web_login_password or "").strip()
        and (settings.web_login_session_secret or "").strip()
    )


def _is_login_exempt_path(path: str) -> bool:
    if path in {"/health", "/login"}:
        return True
    if path.startswith("/oauth/callback") or path.startswith("/auth/callback"):
        return True
    if path.startswith("/docs") or path.startswith("/openapi.json"):
        return True
    return False


def _trusted_proxy_hosts() -> set[str]:
    raw = settings.trusted_proxy_ips or ""
    return {value.strip() for value in raw.split(",") if value.strip()}


def _parse_networks(value: str) -> list[ipaddress._BaseNetwork]:
    networks: list[ipaddress._BaseNetwork] = []
    for chunk in value.split(","):
        text = chunk.strip()
        if not text:
            continue
        try:
            networks.append(ipaddress.ip_network(text, strict=False))
        except ValueError:
            continue
    return networks


def _resolve_client_ip(request: Request) -> str | None:
    direct = request.client.host if request.client else None
    if not direct:
        return None

    trusted = _trusted_proxy_hosts()
    if direct not in trusted:
        return direct

    forwarded = request.headers.get("x-forwarded-for", "")
    if not forwarded:
        return direct
    first = forwarded.split(",")[0].strip()
    return first or direct


def _is_internal_request(request: Request) -> bool:
    ip_text = _resolve_client_ip(request)
    if not ip_text:
        return False
    try:
        ip_value = ipaddress.ip_address(ip_text)
    except ValueError:
        return False

    for network in _parse_networks(settings.internal_network_cidrs):
        if ip_value in network:
            return True
    return False


def _web_session_sign(payload: str) -> str:
    secret = (settings.web_login_session_secret or "").encode("utf-8")
    return hmac.new(secret, payload.encode("utf-8"), sha256).hexdigest()


def _build_web_session_token() -> str:
    now = int(datetime.now(timezone.utc).timestamp())
    expires = now + max(settings.web_login_session_ttl_seconds, 60)
    nonce = secrets.token_hex(8)
    payload = f"{expires}.{nonce}"
    sig = _web_session_sign(payload)
    return f"{payload}.{sig}"


def _has_valid_web_session(request: Request) -> bool:
    token = request.cookies.get(settings.web_login_cookie_name, "")
    if not token:
        return False
    parts = token.split(".")
    if len(parts) != 3:
        return False
    expires_text, nonce, sig = parts
    payload = f"{expires_text}.{nonce}"
    expected = _web_session_sign(payload)
    if not hmac.compare_digest(sig, expected):
        return False
    try:
        expires = int(expires_text)
    except ValueError:
        return False
    now = int(datetime.now(timezone.utc).timestamp())
    return expires > now


def _verify_web_credentials(username: str, password: str) -> bool:
    expected_user = (settings.web_login_username or "").strip()
    expected_pass = settings.web_login_password or ""
    return secrets.compare_digest(username, expected_user) and secrets.compare_digest(
        password, expected_pass
    )


def _safe_next_path(next_path: str) -> str:
    candidate = (next_path or "/").strip()
    if not candidate.startswith("/"):
        return "/"
    if candidate.startswith("//"):
        return "/"
    return candidate


def _set_web_session_cookie(request: Request, response: RedirectResponse) -> None:
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(
        key=settings.web_login_cookie_name,
        value=_build_web_session_token(),
        httponly=True,
        secure=secure,
        samesite="lax",
        max_age=max(settings.web_login_session_ttl_seconds, 60),
        path="/",
    )


async def _fetch_rate_limits(
    client: httpx.AsyncClient, token: str
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"}
    if settings.openai_organization:
        headers["OpenAI-Organization"] = settings.openai_organization
    if settings.openai_project:
        headers["OpenAI-Project"] = settings.openai_project

    try:
        response = await client.get(settings.rate_limit_probe_url, headers=headers)
    except httpx.RequestError as exc:
        return {"error": str(exc)}

    rate_headers = {
        key.lower(): value
        for key, value in response.headers.items()
        if key.lower().startswith("x-ratelimit-")
    }

    requests_remaining = _parse_int(rate_headers.get("x-ratelimit-remaining-requests"))
    requests_limit = _parse_int(rate_headers.get("x-ratelimit-limit-requests"))
    tokens_remaining = _parse_int(rate_headers.get("x-ratelimit-remaining-tokens"))
    tokens_limit = _parse_int(rate_headers.get("x-ratelimit-limit-tokens"))

    return {
        "status": response.status_code,
        "requests": _format_limit(
            requests_remaining,
            requests_limit,
            rate_headers.get("x-ratelimit-reset-requests"),
        ),
        "tokens": _format_limit(
            tokens_remaining,
            tokens_limit,
            rate_headers.get("x-ratelimit-reset-tokens"),
        ),
        "raw_headers": rate_headers,
        "error": response.text.strip() if response.status_code >= 400 else None,
    }


def _has_limit_data(rate_info: dict[str, Any]) -> bool:
    if not isinstance(rate_info, dict):
        return False
    return bool(rate_info.get("requests") or rate_info.get("tokens"))


def _safe_read_current_auth() -> dict[str, Any] | None:
    try:
        return read_current_auth()
    except CodexCLIError:
        return None


def _normalize_session_limit_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"raw": payload}

    limits = payload.get("rateLimits")
    if isinstance(limits, dict):
        payload = limits

    primary = payload.get("primary")
    secondary = payload.get("secondary")
    return {
        "primary": primary if isinstance(primary, dict) else None,
        "secondary": secondary if isinstance(secondary, dict) else None,
        "raw": payload,
    }


def _fetch_session_limits_for_profiles(
    profiles: list[AccountProfile], baseline_auth: dict[str, Any] | None
) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    if not profiles:
        return out

    try:
        for profile in profiles:
            try:
                switch_label(profile.label)
                result = read_rate_limits_via_app_server()
                out[profile.label] = _normalize_session_limit_payload(result.rate_limits)
            except (CodexSwitchError, CodexCLIError) as exc:
                out[profile.label] = {"error": str(exc)}
    finally:
        if baseline_auth is not None:
            try:
                persist_current_auth(baseline_auth)
            except AuthStoreError:
                pass

    return out


def _format_limit(
    remaining: int | None, limit: int | None, reset: str | None
) -> dict[str, Any] | None:
    if remaining is None and limit is None and reset is None:
        return None
    percent = None
    if remaining is not None and limit:
        percent = round((remaining / limit) * 100, 1)
    return {
        "remaining": remaining,
        "limit": limit,
        "percent": percent,
        "reset": reset,
    }


def _parse_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _profile_for_label(label: str) -> AccountProfile | None:
    wanted = label.strip()
    for profile in list_profiles():
        if profile.label == wanted:
            return profile
    return None


def _resolve_current_label(
    current_auth: dict[str, Any], profiles: list[AccountProfile]
) -> str | None:
    try:
        label = current_label()
        if label:
            return label
    except CodexSwitchError:
        pass

    token = _extract_token(current_auth)
    for profile in profiles:
        if profile.auth == current_auth:
            return profile.label
        if token and profile.access_token and profile.access_token == token:
            return profile.label
    return None


def _display_label(label: str | None, email: str | None) -> str | None:
    if not label:
        return None
    if not email:
        return label
    local = email.split("@", 1)[0].strip().lower()
    if not local:
        return label
    return local


def _extract_token(payload: Any) -> str | None:
    if isinstance(payload, dict):
        for key in ["access_token", "accessToken", "token", "api_key", "apiKey"]:
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for value in payload.values():
            found = _extract_token(value)
            if found:
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = _extract_token(item)
            if found:
                return found
    return None


def _auth_file_metadata(path: Path) -> dict[str, Any]:
    exists = path.exists()
    stat = path.stat() if exists else None
    modified_at = (
        datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat() if stat else None
    )
    return {
        "path": str(path),
        "exists": exists,
        "size_bytes": stat.st_size if stat else None,
        "modified_at": modified_at,
    }


def _render_login(next_path: str) -> str:
    safe_next = _safe_next_path(next_path)
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Auth Manager Login</title>
    <style>
      :root {{
        --bg: #0b1320;
        --panel: #132033;
        --text: #e8f0ff;
        --muted: #9eb0cc;
        --border: rgba(255,255,255,0.12);
        --accent: #5fd0a5;
      }}
      * {{ box-sizing: border-box; }}
      body {{
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: "Space Grotesk", sans-serif;
        background: radial-gradient(circle at 20% 10%, rgba(95,208,165,0.18), transparent 45%), var(--bg);
        color: var(--text);
      }}
      .card {{
        width: min(420px, 92vw);
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 22px;
      }}
      h1 {{ margin: 0 0 8px; font-size: 24px; }}
      p {{ margin: 0 0 16px; color: var(--muted); }}
      label {{ display: block; margin: 10px 0 6px; font-size: 13px; color: var(--muted); }}
      input {{
        width: 100%;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: #0d1727;
        color: var(--text);
        padding: 10px 12px;
      }}
      button {{
        margin-top: 14px;
        width: 100%;
        border: none;
        border-radius: 10px;
        padding: 10px 12px;
        background: linear-gradient(135deg, var(--accent), #6ca6ff);
        color: #001818;
        font-weight: 700;
        cursor: pointer;
      }}
    </style>
  </head>
  <body>
    <form class="card" method="post" action="/login">
      <h1>Sign in</h1>
      <p>Public access requires credentials. Internal-network access is allowed automatically.</p>
      <input type="hidden" name="next" value="{safe_next}" />
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" required />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">Login</button>
    </form>
  </body>
</html>"""


def _render_index() -> str:
    return """<!doctype html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>Codex Auth Manager</title>
    <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\" />
    <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin />
    <link href=\"https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&display=swap\" rel=\"stylesheet\" />
    <style>
      :root {
        --bg: #091016;
        --panel: #15202b;
        --panel-2: #1c2a37;
        --text: #ecf3ff;
        --muted: #a1aec2;
        --accent: #85d6ff;
        --accent-2: #97f7b1;
        --warn: #ffd86b;
        --border: rgba(255, 255, 255, 0.1);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: \"Space Grotesk\", sans-serif;
        color: var(--text);
        background: radial-gradient(circle at 15% 5%, rgba(133,214,255,0.2), transparent 45%),
                    radial-gradient(circle at 85% 5%, rgba(151,247,177,0.2), transparent 40%),
                    var(--bg);
        min-height: 100vh;
        padding: 28px 16px;
      }
      .shell {
        width: min(1080px, 100%);
        margin: 0 auto;
        display: grid;
        gap: 18px;
      }
      .top {
        display: grid;
        gap: 10px;
      }
      .top-row {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
        flex-wrap: wrap;
      }
      h1 {
        margin: 0;
        font-size: 28px;
      }
      .subtitle {
        color: var(--muted);
        font-size: 14px;
      }
      .toolbar {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      button,
      .btn {
        background: var(--panel-2);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px 12px;
        font-size: 13px;
        cursor: pointer;
      }
      button.primary {
        background: linear-gradient(135deg, #4eb8e6, #45cf8f);
        color: #042220;
        font-weight: 600;
      }
      .token-box {
        display: flex;
        gap: 8px;
        align-items: center;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 10px 12px;
      }
      .token-box input {
        background: transparent;
        border: none;
        outline: none;
        color: var(--text);
        width: 200px;
        font-size: 13px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 14px;
        box-shadow: 0 14px 24px rgba(0, 0, 0, 0.28);
      }
      .status-grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      }
      .status-title {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .status-value {
        margin-top: 4px;
        font-size: 16px;
        font-weight: 600;
      }
      .grid {
        display: grid;
        gap: 12px;
      }
      .account-head {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: center;
        margin-bottom: 10px;
      }
      .label {
        font-size: 16px;
        font-weight: 600;
      }
      .email {
        color: var(--muted);
        font-size: 12px;
      }
      .pill {
        border-radius: 999px;
        padding: 5px 10px;
        font-size: 11px;
        border: 1px solid var(--border);
        color: var(--muted);
      }
      .pill.active {
        background: rgba(151,247,177,0.2);
        color: var(--accent-2);
        border-color: rgba(151,247,177,0.4);
      }
      .actions {
        display: flex;
        gap: 8px;
        margin-bottom: 6px;
      }
      .limit-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-top: 1px solid var(--border);
        padding-top: 8px;
        margin-top: 8px;
      }
      .limit-title {
        font-size: 14px;
      }
      .limit-sub {
        font-size: 12px;
        color: var(--muted);
      }
      .percent {
        color: var(--accent);
        font-weight: 600;
      }
      .percent.alt { color: var(--accent-2); }
      .status-note {
        color: var(--muted);
        font-size: 12px;
      }
      .status-note.warn {
        color: var(--warn);
      }
      @media (max-width: 680px) {
        .token-box input { width: 140px; }
        .actions { flex-wrap: wrap; }
      }
    </style>
  </head>
  <body>
    <div class=\"shell\">
      <div class=\"top\">
        <div class=\"top-row\">
          <div>
            <h1>Codex Auth Manager</h1>
            <div class=\"subtitle\">Codex CLI login plus codex-switch profile orchestration</div>
          </div>
          <div class=\"toolbar\">
            <button id=\"addAccount\" class=\"primary\" type=\"button\">Add account</button>
            <button id=\"importCurrent\" type=\"button\">Import current auth</button>
            <button id=\"refreshAll\" type=\"button\">Refresh</button>
          </div>
        </div>
        <div class=\"token-box\">
          <input id=\"tokenInput\" type=\"password\" placeholder=\"Bearer token\" />
          <button id=\"tokenSave\" type=\"button\">Save token</button>
          <button id=\"tokenClear\" type=\"button\">Clear</button>
        </div>
      </div>

      <div class=\"card status-grid\">
        <div>
          <div class=\"status-title\">Accounts Managed</div>
          <div class=\"status-value\" id=\"accountsManaged\">--</div>
        </div>
        <div>
          <div class=\"status-title\">Profiles With Token</div>
          <div class=\"status-value\" id=\"profilesWithTokens\">--</div>
        </div>
        <div>
          <div class=\"status-title\">Login Status</div>
          <div class=\"status-value\" id=\"loginStatus\">idle</div>
        </div>
        <div>
          <div class=\"status-title\">Auth File Updated</div>
          <div class=\"status-value\" id=\"authUpdatedAt\">--</div>
        </div>
        <div>
          <div class=\"status-title\">Session Requests</div>
          <div class=\"status-value\" id=\"sessionRequests\">--</div>
        </div>
        <div>
          <div class=\"status-title\">Session Tokens</div>
          <div class=\"status-value\" id=\"sessionTokens\">--</div>
        </div>
      </div>

      <div id=\"statusNote\" class=\"status-note\"></div>
      <div id=\"accounts\" class=\"grid\"></div>
    </div>

    <script>
      const accountsEl = document.getElementById("accounts");
      const statusNoteEl = document.getElementById("statusNote");
      const tokenInput = document.getElementById("tokenInput");
      const accountsManagedEl = document.getElementById("accountsManaged");
      const profilesWithTokensEl = document.getElementById("profilesWithTokens");
      const loginStatusEl = document.getElementById("loginStatus");
      const authUpdatedAtEl = document.getElementById("authUpdatedAt");
      const sessionRequestsEl = document.getElementById("sessionRequests");
      const sessionTokensEl = document.getElementById("sessionTokens");

      function getToken() {
        return (localStorage.getItem("internalToken") || "").trim();
      }

      function setStatus(text, warn = false) {
        statusNoteEl.textContent = text || "";
        statusNoteEl.className = warn ? "status-note warn" : "status-note";
      }

      function authHeaders() {
        const token = getToken();
        return token ? { "Authorization": "Bearer " + token } : {};
      }

      async function apiFetch(url, options = {}) {
        const headers = {
          "Content-Type": "application/json",
          ...authHeaders(),
          ...(options.headers || {}),
        };
        return fetch(url, { ...options, headers });
      }

      async function readError(res, fallback) {
        const raw = await res.text();
        try {
          const data = JSON.parse(raw);
          if (typeof data.detail === "string") {
            return data.detail;
          }
          if (data.detail && typeof data.detail.message === "string") {
            return data.detail.message;
          }
          if (typeof data.message === "string") {
            return data.message;
          }
        } catch (_err) {
          // Fall through to raw text.
        }
        return raw || fallback;
      }

      function renderLimit(title, data, extraClass) {
        if (!data) {
          return `<div class="limit-row"><div><div class="limit-title">${title}</div><div class="limit-sub">No data</div></div><div class="percent ${extraClass}">--</div></div>`;
        }
        const percent = (
          data.percent === null || data.percent === undefined
            ? (data.usedPercent === null || data.usedPercent === undefined ? "--" : data.usedPercent + "%")
            : data.percent + "%"
        );
        const remaining = data.remaining ?? "--";
        const limit = data.limit ?? "--";
        const reset = data.reset
          ? `Reset ${data.reset}`
          : (data.windowDurationMins ? `Window ${data.windowDurationMins}m` : "Reset unknown");
        return `<div class="limit-row"><div><div class="limit-title">${title}</div><div class="limit-sub">${remaining} / ${limit} | ${reset}</div></div><div class="percent ${extraClass}">${percent}</div></div>`;
      }

      function renderCard(account) {
        const badge = account.is_current ? `<div class="pill active">Current</div>` : `<div class="pill">Saved</div>`;
        const email = account.email ? account.email : "email unavailable";
        const displayLabel = account.display_label || account.label;
        const rate = account.rate_limits || {};
        const fiveHour = rate.requests || rate.primary || null;
        const sevenDay = rate.tokens || rate.secondary || null;
        return `<div class="card" data-label="${account.label}">
          <div class="account-head">
            <div>
              <div class="label">${displayLabel}</div>
              <div class="email">${email}</div>
            </div>
            ${badge}
          </div>
          <div class="actions">
            <button type="button" data-action="switch" data-label="${account.label}">Switch</button>
            <button type="button" data-action="export" data-label="${account.label}">Export</button>
          </div>
          ${renderLimit("5hr Limit", fiveHour, "")}
          ${renderLimit("7 Day Limit", sevenDay, "alt")}
        </div>`;
      }

      function formatLimitInline(limit) {
        if (!limit || typeof limit !== "object") {
          return "--";
        }
        const remaining = limit.remaining ?? limit.remainingRequests ?? limit.remainingTokens;
        const max = limit.limit ?? limit.max ?? limit.total;
        if (remaining !== undefined && max !== undefined) {
          return `${remaining} / ${max}`;
        }
        if (limit.usedPercent !== undefined) {
          const pct = `${limit.usedPercent}% used`;
          const mins = limit.windowDurationMins !== undefined ? ` / ${limit.windowDurationMins}m` : "";
          return pct + mins;
        }
        if (remaining !== undefined) {
          return `${remaining}`;
        }
        if (max !== undefined) {
          return `-- / ${max}`;
        }
        return "--";
      }

      function parseSessionLimits(payload) {
        if (!payload || typeof payload !== "object") {
          return { requests: null, tokens: null };
        }
        if (payload.requests || payload.tokens) {
          return {
            requests: payload.requests || null,
            tokens: payload.tokens || null,
          };
        }
        if (payload.rateLimits && typeof payload.rateLimits === "object") {
          return parseSessionLimits(payload.rateLimits);
        }
        if (payload.primary || payload.secondary) {
          return {
            requests: payload.primary || null,
            tokens: payload.secondary || null,
          };
        }
        if (Array.isArray(payload.limits)) {
          let requests = null;
          let tokens = null;
          for (const entry of payload.limits) {
            if (!entry || typeof entry !== "object") continue;
            const name = String(entry.name || entry.type || "").toLowerCase();
            if (!requests && name.includes("request")) requests = entry;
            if (!tokens && name.includes("token")) tokens = entry;
          }
          return { requests, tokens };
        }
        return { requests: null, tokens: null };
      }

      async function loadPublicStats() {
        try {
          const res = await fetch("/api/public-stats");
          const data = await res.json();
          accountsManagedEl.textContent = (data.accounts_managed ?? "--").toString();
          profilesWithTokensEl.textContent = (data.profiles_with_tokens ?? "--").toString();
          loginStatusEl.textContent = data.login_status || "idle";
          authUpdatedAtEl.textContent = data.auth_file?.modified_at || "--";
        } catch (_err) {
          accountsManagedEl.textContent = "--";
          profilesWithTokensEl.textContent = "--";
          loginStatusEl.textContent = "unknown";
          authUpdatedAtEl.textContent = "--";
        }
      }

      async function loadSessionRateLimits() {
        sessionRequestsEl.textContent = "--";
        sessionTokensEl.textContent = "--";
        try {
          const res = await apiFetch("/auth/rate-limits", { method: "GET" });
          if (res.status === 401 || res.status === 403) {
            return;
          }
          if (!res.ok) {
            const msg = await readError(res, "Failed to read session limits");
            setStatus(msg, true);
            return;
          }
          const data = await res.json();
          const parsed = parseSessionLimits(data.rate_limits || data);
          sessionRequestsEl.textContent = formatLimitInline(parsed.requests);
          sessionTokensEl.textContent = formatLimitInline(parsed.tokens);
        } catch (_err) {
          sessionRequestsEl.textContent = "--";
          sessionTokensEl.textContent = "--";
        }
      }

      async function loadAccounts() {
        tokenInput.value = getToken();
        try {
          const res = await apiFetch("/api/accounts", { method: "GET" });
          if (res.status === 401 || res.status === 403) {
            accountsEl.innerHTML = `<div class="card">Bearer token required for account actions.</div>`;
            return;
          }
          const data = await res.json();
          const accounts = data.accounts || [];
          if (!accounts.length) {
            accountsEl.innerHTML = `<div class="card">No saved profiles yet.</div>`;
            return;
          }
          accountsEl.innerHTML = accounts.map(renderCard).join("");
        } catch (_err) {
          accountsEl.innerHTML = `<div class="card">Failed to load accounts.</div>`;
        }
      }

      async function startLogin() {
        const res = await apiFetch("/auth/login/start", { method: "POST", body: "{}" });
        if (!res.ok) {
          throw new Error(await readError(res, "Unable to start login"));
        }
        const data = await res.json();
        setStatus(data.instructions || "Login started.");
        await loadPublicStats();
      }

      async function importCurrent() {
        const requestedLabel = window.prompt("Optional label (leave empty for derived label):", "");
        const body = requestedLabel && requestedLabel.trim() ? { label: requestedLabel.trim() } : {};
        const res = await apiFetch("/auth/import-current", { method: "POST", body: JSON.stringify(body) });
        if (!res.ok) {
          throw new Error(await readError(res, "Import failed"));
        }
        const data = await res.json();
        setStatus(`Imported current auth as '${data.label}'`);
      }

      async function switchProfile(label) {
        const res = await apiFetch("/auth/switch", {
          method: "POST",
          body: JSON.stringify({ label }),
        });
        if (!res.ok) {
          throw new Error(await readError(res, "Switch failed"));
        }
        setStatus(`Switched to '${label}'`);
      }

      async function exportProfile(label) {
        const res = await apiFetch(`/auth/export?label=${encodeURIComponent(label)}`, { method: "GET" });
        if (!res.ok) {
          throw new Error(await readError(res, "Export failed"));
        }
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data.auth_json, null, 2)], { type: "application/json" });
        const href = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = href;
        link.download = `${label}-auth.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(href);
        setStatus(`Exported '${label}'`);
      }

      async function refreshAll() {
        await Promise.all([loadPublicStats(), loadSessionRateLimits(), loadAccounts()]);
      }

      document.getElementById("tokenSave").addEventListener("click", async () => {
        localStorage.setItem("internalToken", tokenInput.value.trim());
        await refreshAll();
      });

      document.getElementById("tokenClear").addEventListener("click", async () => {
        localStorage.removeItem("internalToken");
        tokenInput.value = "";
        await refreshAll();
      });

      document.getElementById("addAccount").addEventListener("click", async () => {
        try {
          await startLogin();
        } catch (err) {
          setStatus(err.message || "Login start failed", true);
        }
      });

      document.getElementById("importCurrent").addEventListener("click", async () => {
        try {
          await importCurrent();
          await refreshAll();
        } catch (err) {
          setStatus(err.message || "Import failed", true);
        }
      });

      document.getElementById("refreshAll").addEventListener("click", refreshAll);

      accountsEl.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        const action = target.getAttribute("data-action");
        const label = target.getAttribute("data-label");
        if (!action || !label) {
          return;
        }

        try {
          if (action === "switch") {
            await switchProfile(label);
            await refreshAll();
          } else if (action === "export") {
            await exportProfile(label);
          }
        } catch (err) {
          setStatus(err.message || "Action failed", true);
        }
      });

      refreshAll();
      setInterval(async () => {
        await loadPublicStats();
        await loadSessionRateLimits();
      }, 15000);
    </script>
  </body>
</html>"""
