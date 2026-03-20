from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

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
    read_current_auth,
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

app = FastAPI(title="Codex Auth Manager", version="0.2.0")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


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
    try:
        result = start_login()
    except CodexCLIError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return JSONResponse(
        {
            "status": "started",
            "auth_path": result.auth_path,
            "pid": result.pid,
            "started_at": result.started_at,
            "browser_url": result.browser_url,
            "instructions": result.instructions,
            "output_excerpt": result.output_excerpt,
        }
    )


@app.get("/auth/login/status")
async def auth_login_status(wait_seconds: int = 0) -> JSONResponse:
    if wait_seconds > 0:
        wait_for_auth_update(timeout_seconds=min(wait_seconds, 120))

    result = get_login_status()
    return JSONResponse(
        {
            "status": result.status,
            "auth": {
                "exists": result.auth_exists,
                "updated": result.auth_updated,
                "path": result.auth_path,
            },
            "started_at": result.started_at,
            "completed_at": result.completed_at,
            "pid": result.pid,
            "browser_url": result.browser_url,
            "error": result.error,
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
            "status": "ok",
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

    results: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=10) as client:
        for profile in profiles:
            if profile.access_token:
                rate_info = await _fetch_rate_limits(client, profile.access_token)
            else:
                rate_info = {"error": "No access token found"}

            results.append(
                {
                    "label": profile.label,
                    "email": profile.email,
                    "is_current": profile.label == current,
                    "rate_limits": rate_info,
                }
            )

    return JSONResponse({"accounts": results, "current_label": current})


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
    if not settings.internal_api_token:
        return
    auth_header = request.headers.get("authorization", "")
    if not auth_header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Bearer token required")
    token = auth_header.split(" ", 1)[1].strip()
    if token != settings.internal_api_token:
        raise HTTPException(status_code=403, detail="Invalid token")


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
          <div class=\"status-title\">Current Label</div>
          <div class=\"status-value\" id=\"currentLabel\">--</div>
        </div>
        <div>
          <div class=\"status-title\">Current Email</div>
          <div class=\"status-value\" id=\"currentEmail\">--</div>
        </div>
        <div>
          <div class=\"status-title\">Login Status</div>
          <div class=\"status-value\" id=\"loginStatus\">idle</div>
        </div>
        <div>
          <div class=\"status-title\">Login URL</div>
          <div class=\"status-value\" id=\"loginUrl\">--</div>
        </div>
      </div>

      <div id=\"statusNote\" class=\"status-note\"></div>
      <div id=\"accounts\" class=\"grid\"></div>
    </div>

    <script>
      const accountsEl = document.getElementById("accounts");
      const statusNoteEl = document.getElementById("statusNote");
      const tokenInput = document.getElementById("tokenInput");
      const currentLabelEl = document.getElementById("currentLabel");
      const currentEmailEl = document.getElementById("currentEmail");
      const loginStatusEl = document.getElementById("loginStatus");
      const loginUrlEl = document.getElementById("loginUrl");

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

      function renderLimit(title, data, extraClass) {
        if (!data) {
          return `<div class="limit-row"><div><div class="limit-title">${title}</div><div class="limit-sub">No data</div></div><div class="percent ${extraClass}">--</div></div>`;
        }
        const percent = data.percent === null || data.percent === undefined ? "--" : data.percent + "%";
        const remaining = data.remaining ?? "--";
        const limit = data.limit ?? "--";
        const reset = data.reset ? `Reset ${data.reset}` : "Reset unknown";
        return `<div class="limit-row"><div><div class="limit-title">${title}</div><div class="limit-sub">${remaining} / ${limit} | ${reset}</div></div><div class="percent ${extraClass}">${percent}</div></div>`;
      }

      function renderCard(account) {
        const badge = account.is_current ? `<div class="pill active">Current</div>` : `<div class="pill">Saved</div>`;
        const email = account.email ? account.email : "email unavailable";
        const rate = account.rate_limits || {};
        return `<div class="card" data-label="${account.label}">
          <div class="account-head">
            <div>
              <div class="label">${account.label}</div>
              <div class="email">${email}</div>
            </div>
            ${badge}
          </div>
          <div class="actions">
            <button type="button" data-action="switch" data-label="${account.label}">Switch</button>
            <button type="button" data-action="export" data-label="${account.label}">Export</button>
          </div>
          ${renderLimit("Requests", rate.requests, "")}
          ${renderLimit("Tokens", rate.tokens, "alt")}
        </div>`;
      }

      async function loadCurrent() {
        try {
          const res = await fetch("/auth/current");
          const data = await res.json();
          currentLabelEl.textContent = data.current_label || "--";
          currentEmailEl.textContent = data.email || "--";
        } catch (_err) {
          currentLabelEl.textContent = "--";
          currentEmailEl.textContent = "--";
        }
      }

      async function loadLoginStatus() {
        try {
          const res = await fetch("/auth/login/status");
          const data = await res.json();
          loginStatusEl.textContent = data.status || "idle";
          if (data.browser_url) {
            loginUrlEl.innerHTML = `<a href="${data.browser_url}" target="_blank" rel="noopener noreferrer" class="btn">Open URL</a>`;
          } else {
            loginUrlEl.textContent = "--";
          }
          if (data.error) {
            setStatus(data.error, true);
          }
        } catch (_err) {
          loginStatusEl.textContent = "unknown";
          loginUrlEl.textContent = "--";
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
          const data = await res.json();
          throw new Error(data.detail?.message || data.detail || "Unable to start login");
        }
        const data = await res.json();
        setStatus(data.instructions || "Login started.");
        await loadLoginStatus();
      }

      async function importCurrent() {
        const requestedLabel = window.prompt("Optional label (leave empty for derived label):", "");
        const body = requestedLabel && requestedLabel.trim() ? { label: requestedLabel.trim() } : {};
        const res = await apiFetch("/auth/import-current", { method: "POST", body: JSON.stringify(body) });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.detail?.message || data.detail || "Import failed");
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
          const data = await res.json();
          throw new Error(data.detail?.message || data.detail || "Switch failed");
        }
        setStatus(`Switched to '${label}'`);
      }

      async function exportProfile(label) {
        const res = await apiFetch(`/auth/export?label=${encodeURIComponent(label)}`, { method: "GET" });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.detail?.message || data.detail || "Export failed");
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
        await Promise.all([loadCurrent(), loadLoginStatus(), loadAccounts()]);
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
        await loadLoginStatus();
        await loadCurrent();
      }, 15000);
    </script>
  </body>
</html>"""
