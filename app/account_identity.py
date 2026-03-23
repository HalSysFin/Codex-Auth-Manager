from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass
from typing import Any

EMAIL_KEYS = [
    "email",
    "user_email",
    "userEmail",
    "account_email",
    "primary_email",
]

ACCESS_TOKEN_KEYS = [
    "access_token",
    "accessToken",
    "token",
    "api_key",
    "apiKey",
]

ID_TOKEN_KEYS = ["id_token", "idToken"]


@dataclass
class AccountIdentity:
    account_key: str
    subject: str | None
    user_id: str | None
    account_id: str | None
    email: str | None
    name: str | None
    plan_type: str | None


def extract_account_identity(auth_json: dict[str, Any]) -> AccountIdentity:
    id_token = _find_first_key(auth_json, ID_TOKEN_KEYS)
    access_token = _find_first_key(auth_json, ACCESS_TOKEN_KEYS)
    id_claims = _decode_jwt_payload(id_token) if id_token else None
    access_claims = _decode_jwt_payload(access_token) if access_token else None

    subject = _first_non_empty(
        _claim_text(id_claims, "sub"),
        _claim_text(access_claims, "sub"),
    )
    user_id = _first_non_empty(
        _auth_claim_text(id_claims, "user_id"),
        _auth_claim_text(id_claims, "chatgpt_user_id"),
        _auth_claim_text(access_claims, "user_id"),
        _auth_claim_text(access_claims, "chatgpt_user_id"),
    )
    account_id = _first_non_empty(
        _auth_claim_text(id_claims, "chatgpt_account_id"),
        _auth_claim_text(access_claims, "chatgpt_account_id"),
        _find_first_key(auth_json, ["accountId", "account_id"]),
    )
    plan_type = _first_non_empty(
        _auth_claim_text(id_claims, "chatgpt_plan_type"),
        _auth_claim_text(access_claims, "chatgpt_plan_type"),
    )

    email = extract_email(auth_json)
    email_norm = email.strip().lower() if isinstance(email, str) and email.strip() else None
    name = _first_non_empty(
        _claim_text(id_claims, "name"),
        _claim_text(access_claims, "name"),
        _find_first_key(auth_json, ["name", "display_name", "displayName"]),
    )

    account_key = _build_account_key(
        subject=subject,
        user_id=user_id,
        account_id=account_id,
        email=email_norm,
        access_token=access_token,
        payload=auth_json,
    )

    return AccountIdentity(
        account_key=account_key,
        subject=subject,
        user_id=user_id,
        account_id=account_id,
        email=email_norm,
        name=name,
        plan_type=plan_type.lower() if isinstance(plan_type, str) else None,
    )


def extract_email(auth_json: dict[str, Any]) -> str | None:
    found = _find_first_key(auth_json, EMAIL_KEYS)
    if found:
        return found

    for key in ID_TOKEN_KEYS:
        token = _find_first_key(auth_json, [key])
        if not token:
            continue
        claims = _decode_jwt_payload(token)
        if not claims:
            continue
        claim_email = _extract_email_from_claims(claims)
        if claim_email:
            return claim_email

    access_token = _find_first_key(auth_json, ACCESS_TOKEN_KEYS)
    if access_token:
        access_claims = _decode_jwt_payload(access_token)
        if access_claims:
            claim_email = _extract_email_from_claims(access_claims)
            if claim_email:
                return claim_email

    return None


def extract_access_token(payload: Any) -> str | None:
    return _find_first_key(payload, ACCESS_TOKEN_KEYS)


def extract_id_token(payload: Any) -> str | None:
    return _find_first_key(payload, ID_TOKEN_KEYS)


def decode_jwt_claims(token: str | None) -> dict[str, Any] | None:
    if not isinstance(token, str) or not token.strip():
        return None
    return _decode_jwt_payload(token)


def _build_account_key(
    *,
    subject: str | None,
    user_id: str | None,
    account_id: str | None,
    email: str | None,
    access_token: str | None,
    payload: dict[str, Any],
) -> str:
    if subject:
        return f"sub:{subject}"
    if user_id:
        return f"uid:{user_id}"
    if account_id and email:
        return f"acct:{account_id}:{email}"
    if email:
        return f"email:{email}"
    if account_id:
        return f"acct:{account_id}"
    if access_token:
        digest = hashlib.sha256(access_token.encode("utf-8")).hexdigest()[:24]
        return f"tok:{digest}"
    fallback = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:24]
    return f"anon:{fallback}"


def _auth_claim_text(claims: dict[str, Any] | None, key: str) -> str | None:
    if not isinstance(claims, dict):
        return None
    auth_claim = claims.get("https://api.openai.com/auth")
    if isinstance(auth_claim, dict):
        return _claim_text(auth_claim, key)
    return None


def _extract_email_from_claims(claims: dict[str, Any]) -> str | None:
    direct = _find_first_key(claims, EMAIL_KEYS)
    if direct:
        return direct
    profile = claims.get("https://api.openai.com/profile")
    if isinstance(profile, dict):
        return _find_first_key(profile, EMAIL_KEYS)
    return None


def _claim_text(payload: dict[str, Any] | None, key: str) -> str | None:
    if not isinstance(payload, dict):
        return None
    value = payload.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _first_non_empty(*values: str | None) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


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
        for value in payload:
            found = _find_first_key(value, keys)
            if found:
                return found
    return None


def _decode_jwt_payload(token: str) -> dict[str, Any] | None:
    parts = token.split(".")
    if len(parts) < 2:
        return None
    payload = parts[1]
    padding = "=" * ((4 - (len(payload) % 4)) % 4)
    try:
        decoded = base64.urlsafe_b64decode((payload + padding).encode("ascii"))
        parsed = json.loads(decoded.decode("utf-8", errors="replace"))
    except (ValueError, OSError):
        return None
    if isinstance(parsed, dict):
        return parsed
    return None
