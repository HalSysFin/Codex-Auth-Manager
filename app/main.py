from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
import httpx

from .codex_switch import CodexSwitchError, save_label
from .config import settings

app = FastAPI(title="Codex Auth Manager", version="0.1.0")


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True))


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


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
async def oauth_callback_post(payload: dict[str, Any]) -> JSONResponse:
    stored_at = _store_callback(payload)

    label = payload.get("label")
    auth_json = payload.get("auth_json")

    if label and auth_json:
        _persist_auth_and_save(label, auth_json)
        return JSONResponse(
            {
                "stored_at": str(stored_at),
                "saved_label": label,
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
async def auth_callback_post(payload: dict[str, Any]) -> JSONResponse:
    return await oauth_callback_post(payload)


@app.post("/auth/save")
async def save_auth(payload: dict[str, Any]) -> JSONResponse:
    label = payload.get("label")
    auth_json = payload.get("auth_json")

    if not label or not auth_json:
        raise HTTPException(status_code=400, detail="label and auth_json are required")

    _persist_auth_and_save(label, auth_json)

    return JSONResponse({"saved_label": label, "message": "Auth saved."})


@app.post("/auth/exchange")
async def exchange_code(payload: dict[str, Any]) -> JSONResponse:
    code = payload.get("code")
    code_verifier = payload.get("code_verifier")
    label = payload.get("label")
    redirect_uri = payload.get("redirect_uri") or settings.openai_redirect_uri

    if not code or not code_verifier:
        raise HTTPException(
            status_code=400, detail="code and code_verifier are required"
        )

    token_response = await _exchange_code_for_token(code, code_verifier, redirect_uri)

    stored_at = _store_callback(
        {
            "type": "token_response",
            "received_at": datetime.now(timezone.utc).isoformat(),
            "token_response": token_response,
        }
    )

    if label:
        _persist_auth_and_save(label, token_response)
        return JSONResponse(
            {
                "stored_at": str(stored_at),
                "saved_label": label,
                "token_response": token_response,
            }
        )

    return JSONResponse({"stored_at": str(stored_at), "token_response": token_response})


def _persist_auth_and_save(label: str, auth_json: Any) -> None:
    auth_path = settings.codex_auth_file()
    _write_json(auth_path, auth_json)

    try:
        save_label(label)
    except CodexSwitchError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _store_callback(payload: Any) -> Path:
    callback_dir = settings.callback_dir()
    callback_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    filename = f"callback-{timestamp}.json"
    path = callback_dir / filename
    _write_json(path, payload)
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
