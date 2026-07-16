#!/usr/bin/env python3
"""Run the Codex Desktop auth-manager cycler as a lease-based desktop client."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REQUESTED_TTL_SECONDS = 1800
RENEW_LEEWAY_SECONDS = 5 * 60


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_windows_drive_path(value: str) -> bool:
    return bool(re.match(r"^[A-Za-z]:[\\/]", value))


def resolve_config_path(raw_value: str, *, label: str) -> Path:
    raw = str(expand_env(raw_value) or "").strip()
    if not raw:
        raise ValueError(f"Missing configured path for {label}.")
    if _is_windows_drive_path(raw):
        if os.name != "nt":
            raise RuntimeError(
                f"{label} uses a Windows path ({raw}) but this plugin is running on {os.name}; refusing to create cross-OS files."
            )
        return Path(raw)
    return Path(raw).expanduser().resolve()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Lease, materialize, reconcile, and rotate Codex Desktop auth via Auth Manager."
    )
    parser.add_argument(
        "command",
        choices=(
            "status",
            "usage-summary",
            "rate-limit-resets",
            "use-rate-limit-reset",
            "ensure-lease",
            "dashboard",
            "cycle-if-needed",
            "apply-recommended",
            "watcher-run",
            "watcher-start",
            "watcher-stop",
            "watcher-status",
        ),
        help="Action to perform.",
    )
    parser.add_argument(
        "--config",
        default=str(Path(__file__).resolve().parent.parent / "config.local.json"),
        help="Path to the auth manager config file.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report actions without changing the local auth file, lease, or restarting Codex.",
    )
    parser.add_argument(
        "--no-reload",
        action="store_true",
        help="Apply auth locally without restarting Codex.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Required when consuming a banked rate-limit reset.",
    )
    parser.add_argument(
        "--credit-id",
        default=None,
        help="Optional opaque reset credit ID returned by rate-limit-resets.",
    )
    return parser.parse_args()


def load_config(path: str) -> dict[str, Any]:
    config_path = Path(path).expanduser().resolve()
    if not config_path.exists():
        raise FileNotFoundError(
            f"Config file not found: {config_path}. Copy config.example.json to config.local.json first."
        )
    with config_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def expand_env(value: Any, extra_env: dict[str, str] | None = None) -> Any:
    merged_env = dict(os.environ)
    merged_env.setdefault("HOME_DIR", str(Path.home()))
    if extra_env:
        merged_env.update(extra_env)

    if isinstance(value, str):
        return re.sub(r"\$\{([^}]+)\}", lambda match: merged_env.get(match.group(1), ""), value)
    if isinstance(value, dict):
        return {key: expand_env(item, extra_env) for key, item in value.items()}
    if isinstance(value, list):
        return [expand_env(item, extra_env) for item in value]
    return value


def get_client_identity(config: dict[str, Any], *, persist: bool = True) -> dict[str, str]:
    client_config = config.get("client", {})
    product = str(client_config.get("product", "codex-desktop")).strip() or "codex-desktop"
    id_path = resolve_config_path(
        client_config.get("id_path", str(Path.home() / ".codex" / "codex-desktop-plugin-client-id.txt")),
        label="client.id_path",
    )

    if id_path.exists():
        client_id = id_path.read_text(encoding="utf-8").strip()
    else:
        if persist:
            id_path.parent.mkdir(parents=True, exist_ok=True)
            client_id = str(uuid.uuid4())
            id_path.write_text(client_id + "\n", encoding="utf-8")
        else:
            client_id = "dry-run-client"

    lease_config = config.get("lease", {})
    machine_id = str(lease_config.get("machine_id") or "").strip() or f"{product}-{client_id}"
    agent_id = str(lease_config.get("agent_id") or "").strip() or f"{product}-plugin"

    return {
        "product": product,
        "id": client_id,
        "id_path": str(id_path),
        "machine_id": machine_id,
        "agent_id": agent_id,
    }


def build_url(base_url: str, endpoint: str) -> str:
    return urllib.parse.urljoin(base_url.rstrip("/") + "/", endpoint.lstrip("/"))


def request_json(
    method: str,
    url: str,
    headers: dict[str, str],
    timeout_seconds: int,
    payload: dict[str, Any] | None = None,
) -> Any:
    data = None
    final_headers = dict(headers)
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        final_headers.setdefault("Content-Type", "application/json")

    request = urllib.request.Request(
        url=url,
        method=method.upper(),
        headers=final_headers,
        data=data,
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8")
            if not body.strip():
                return {}
            return json.loads(body)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code} from {url}: {body}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Failed to reach {url}: {error.reason}") from error


def request_api(
    config: dict[str, Any],
    method: str,
    endpoint: str,
    payload: dict[str, Any] | None = None,
    *,
    persist_client_identity: bool = True,
) -> Any:
    client_identity = get_client_identity(config, persist=persist_client_identity)
    headers = expand_env(config.get("headers", {}))
    headers["X-Client-Product"] = client_identity["product"]
    headers["X-Client-Id"] = client_identity["id"]
    return request_json(
        method=method,
        url=build_url(config["base_url"], endpoint),
        headers=headers,
        timeout_seconds=int(config.get("timeout_seconds", 20)),
        payload=payload,
    )


def watcher_paths(config: dict[str, Any]) -> dict[str, Path]:
    watcher = config.get("watcher", {})
    base_dir = resolve_config_path(
        watcher.get("state_dir", str(Path.home() / ".codex" / "codex-desktop-plugin")),
        label="watcher.state_dir",
    )
    return {
        "base_dir": base_dir,
        "pid_file": base_dir / "watcher.pid",
        "status_file": base_dir / "watcher-status.json",
        "log_file": base_dir / "watcher.log",
        "lease_state_file": base_dir / "lease-state.json",
    }


def watcher_interval_seconds(config: dict[str, Any]) -> int:
    watcher = config.get("watcher", {})
    return max(15, int(watcher.get("interval_seconds", 60)))


def watcher_codex_exit_grace_seconds(config: dict[str, Any]) -> int:
    watcher = config.get("watcher", {})
    return max(15, int(watcher.get("codex_exit_grace_seconds", 90)))


def default_lease_state(config: dict[str, Any], *, persist_client_identity: bool = True) -> dict[str, Any]:
    client = get_client_identity(config, persist=persist_client_identity)
    return {
        "machine_id": client["machine_id"],
        "agent_id": client["agent_id"],
        "lease_id": None,
        "credential_id": None,
        "account_label": None,
        "account_email": None,
        "account_name": None,
        "lease_state": None,
        "issued_at": None,
        "expires_at": None,
        "renewed_at": None,
        "latest_telemetry_at": None,
        "latest_utilization_pct": None,
        "latest_primary_utilization_pct": None,
        "latest_primary_reset_at": None,
        "latest_secondary_utilization_pct": None,
        "latest_secondary_reset_at": None,
        "latest_quota_remaining": None,
        "credential_auth_updated_at": None,
        "last_backend_refresh_at": None,
        "last_auth_write_at": None,
        "last_error_at": None,
        "replacement_required": False,
        "rotation_recommended": False,
        "backend_reachable": True,
        "auth_file_path": str(resolve_config_path(config["codex"]["auth_path"], label="codex.auth_path")),
    }


def read_lease_state(config: dict[str, Any], *, persist_client_identity: bool = True) -> dict[str, Any]:
    path = watcher_paths(config)["lease_state_file"]
    state = default_lease_state(config, persist_client_identity=persist_client_identity)
    if path.exists():
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if isinstance(payload, dict):
            state.update(payload)
    client = get_client_identity(config, persist=persist_client_identity)
    state["machine_id"] = client["machine_id"]
    state["agent_id"] = client["agent_id"]
    state["auth_file_path"] = str(resolve_config_path(config["codex"]["auth_path"], label="codex.auth_path"))
    return state


def write_lease_state(config: dict[str, Any], payload: dict[str, Any]) -> None:
    paths = watcher_paths(config)
    paths["base_dir"].mkdir(parents=True, exist_ok=True)
    with paths["lease_state_file"].open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


def write_watcher_status(config: dict[str, Any], payload: dict[str, Any]) -> None:
    paths = watcher_paths(config)
    paths["base_dir"].mkdir(parents=True, exist_ok=True)
    with paths["status_file"].open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


def read_watcher_status(config: dict[str, Any]) -> dict[str, Any] | None:
    path = watcher_paths(config)["status_file"]
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def read_watcher_pid(config: dict[str, Any]) -> int | None:
    pid_path = watcher_paths(config)["pid_file"]
    if not pid_path.exists():
        return None
    try:
        return int(pid_path.read_text(encoding="utf-8").strip())
    except ValueError:
        return None


def process_is_running(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def write_watcher_pid(config: dict[str, Any], pid: int) -> None:
    paths = watcher_paths(config)
    paths["base_dir"].mkdir(parents=True, exist_ok=True)
    paths["pid_file"].write_text(f"{pid}\n", encoding="utf-8")


def clear_watcher_pid(config: dict[str, Any]) -> None:
    pid_path = watcher_paths(config)["pid_file"]
    if pid_path.exists():
        pid_path.unlink()


def append_watcher_log(config: dict[str, Any], message: str) -> None:
    paths = watcher_paths(config)
    paths["base_dir"].mkdir(parents=True, exist_ok=True)
    with paths["log_file"].open("a", encoding="utf-8") as handle:
        handle.write(f"[{utc_now_iso()}] {message}\n")


def codex_is_running() -> bool:
    completed = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            "Get-Process Codex -ErrorAction SilentlyContinue | Select-Object -First 1",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return bool(completed.stdout.strip())


def watcher_status_payload(config: dict[str, Any], state: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = {
        "state": state,
        "pid": read_watcher_pid(config),
        "running": process_is_running(read_watcher_pid(config)),
        "updated_at": utc_now_iso(),
        "interval_seconds": watcher_interval_seconds(config),
        "codex_running": codex_is_running(),
        "codex_exit_grace_seconds": watcher_codex_exit_grace_seconds(config),
        "lease_state": read_lease_state(config),
    }
    if extra:
        payload.update(extra)
    return payload


def read_local_auth(config: dict[str, Any]) -> dict[str, Any] | None:
    auth_path = resolve_config_path(config["codex"]["auth_path"], label="codex.auth_path")
    if not auth_path.exists():
        return None
    with auth_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def local_auth_summary(auth_json: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(auth_json, dict):
        return {"present": False, "account_id": None, "last_refresh": None}
    tokens = auth_json.get("tokens")
    account_id = tokens.get("account_id") if isinstance(tokens, dict) else None
    if not isinstance(account_id, str):
        account_id = None
    last_refresh = auth_json.get("last_refresh")
    if not isinstance(last_refresh, str):
        last_refresh = None
    return {
        "present": True,
        "account_id": account_id,
        "last_refresh": last_refresh,
    }


def backup_auth_file(auth_path: Path, backup_dir: Path) -> Path:
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = backup_dir / f"auth-{timestamp}.json"
    shutil.copy2(auth_path, destination)
    return destination


def save_codex_auth(config: dict[str, Any], auth_json: dict[str, Any], dry_run: bool) -> dict[str, Any]:
    codex_config = config["codex"]
    auth_path = resolve_config_path(codex_config["auth_path"], label="codex.auth_path")
    backup_dir = resolve_config_path(codex_config["backup_dir"], label="codex.backup_dir")

    result = {
        "auth_path": str(auth_path),
        "backup_dir": str(backup_dir),
    }

    if dry_run:
        result["saved"] = False
        result["backup_path"] = None
        result["written_at"] = None
        return result

    auth_path.parent.mkdir(parents=True, exist_ok=True)
    backup_path = backup_auth_file(auth_path, backup_dir) if auth_path.exists() else None
    with auth_path.open("w", encoding="utf-8") as handle:
        json.dump(auth_json, handle, indent=2)
        handle.write("\n")

    result["saved"] = True
    result["backup_path"] = str(backup_path) if backup_path else None
    result["written_at"] = utc_now_iso()
    return result


def parse_iso_datetime(value: str | None) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def seconds_until(timestamp: str | None) -> float | None:
    dt = parse_iso_datetime(timestamp)
    if dt is None:
        return None
    return (dt - datetime.now(timezone.utc)).total_seconds()


def update_state_from_lease(state: dict[str, Any], lease: dict[str, Any]) -> dict[str, Any]:
    state["lease_id"] = lease.get("id")
    state["credential_id"] = lease.get("credential_id")
    state["lease_state"] = lease.get("state")
    state["issued_at"] = lease.get("issued_at")
    state["expires_at"] = lease.get("expires_at")
    state["renewed_at"] = lease.get("renewed_at")
    state["latest_telemetry_at"] = lease.get("last_telemetry_at")
    state["latest_utilization_pct"] = lease.get("latest_utilization_pct")
    state["latest_quota_remaining"] = lease.get("latest_quota_remaining")
    metadata = lease.get("metadata") if isinstance(lease.get("metadata"), dict) else {}
    state["latest_primary_utilization_pct"] = metadata.get("primary_used_percent")
    state["latest_primary_reset_at"] = metadata.get("primary_reset_at")
    state["latest_secondary_utilization_pct"] = metadata.get("secondary_used_percent")
    state["latest_secondary_reset_at"] = metadata.get("secondary_reset_at")
    state["credential_auth_updated_at"] = metadata.get("auth_updated_at") or state.get("credential_auth_updated_at")
    return state


def update_state_from_status(state: dict[str, Any], status: dict[str, Any]) -> dict[str, Any]:
    state["lease_id"] = status.get("lease_id")
    state["credential_id"] = status.get("credential_id")
    state["lease_state"] = status.get("state")
    state["issued_at"] = status.get("issued_at")
    state["expires_at"] = status.get("expires_at")
    state["renewed_at"] = status.get("renewed_at")
    state["latest_telemetry_at"] = status.get("latest_telemetry_at")
    state["latest_utilization_pct"] = status.get("latest_utilization_pct")
    state["latest_quota_remaining"] = status.get("latest_quota_remaining")
    state["latest_primary_utilization_pct"] = status.get("primary_utilization_pct")
    state["latest_primary_reset_at"] = status.get("primary_reset_at")
    state["latest_secondary_utilization_pct"] = status.get("secondary_utilization_pct")
    state["latest_secondary_reset_at"] = status.get("secondary_reset_at")
    state["credential_auth_updated_at"] = status.get("credential_auth_updated_at")
    state["replacement_required"] = bool(status.get("replacement_required"))
    state["rotation_recommended"] = bool(status.get("rotation_recommended"))
    state["last_backend_refresh_at"] = utc_now_iso()
    state["backend_reachable"] = True
    return state


def update_state_from_materialized(state: dict[str, Any], material: dict[str, Any] | None) -> dict[str, Any]:
    payload = material if isinstance(material, dict) else {}
    state["account_label"] = payload.get("label")
    state["account_email"] = payload.get("email")
    state["account_name"] = payload.get("name")
    return state


def clear_lease_assignment(state: dict[str, Any]) -> dict[str, Any]:
    state["lease_id"] = None
    state["credential_id"] = None
    state["account_label"] = None
    state["account_email"] = None
    state["account_name"] = None
    state["lease_state"] = None
    state["issued_at"] = None
    state["expires_at"] = None
    state["renewed_at"] = None
    state["latest_telemetry_at"] = None
    state["latest_utilization_pct"] = None
    state["latest_primary_utilization_pct"] = None
    state["latest_primary_reset_at"] = None
    state["latest_secondary_utilization_pct"] = None
    state["latest_secondary_reset_at"] = None
    state["latest_quota_remaining"] = None
    state["credential_auth_updated_at"] = None
    state["replacement_required"] = False
    state["rotation_recommended"] = False
    return state


def lease_payload(config: dict[str, Any], extra: dict[str, Any] | None = None) -> dict[str, Any]:
    client = get_client_identity(config)
    payload = {
        "machine_id": client["machine_id"],
        "agent_id": client["agent_id"],
    }
    if extra:
        payload.update(extra)
    return payload


def api_acquire_lease(config: dict[str, Any], reason: str, exclude_ids: list[str] | None = None) -> dict[str, Any]:
    payload = lease_payload(
        config,
        {
            "requested_ttl_seconds": int(config.get("lease", {}).get("requested_ttl_seconds", REQUESTED_TTL_SECONDS)),
            "reason": reason,
            "exclude_credential_ids": exclude_ids or None,
        },
    )
    return request_api(config, "POST", "/api/leases/acquire", payload)


def api_get_lease(config: dict[str, Any], lease_id: str) -> dict[str, Any]:
    return request_api(config, "GET", f"/api/leases/{urllib.parse.quote(lease_id, safe='')}")


def api_renew_lease(config: dict[str, Any], lease_id: str) -> dict[str, Any]:
    return request_api(
        config,
        "POST",
        f"/api/leases/{urllib.parse.quote(lease_id, safe='')}/renew",
        lease_payload(config),
    )


def api_rotate_lease(config: dict[str, Any], lease_id: str, reason: str) -> dict[str, Any]:
    payload = lease_payload(
        config,
        {
            "lease_id": lease_id,
            "reason": reason,
        },
    )
    return request_api(config, "POST", "/api/leases/rotate", payload)


def api_materialize_lease(config: dict[str, Any], lease_id: str) -> dict[str, Any]:
    return request_api(
        config,
        "POST",
        f"/api/leases/{urllib.parse.quote(lease_id, safe='')}/materialize",
        lease_payload(config),
    )


def api_post_telemetry(config: dict[str, Any], lease_id: str, state: dict[str, Any]) -> dict[str, Any]:
    payload = lease_payload(
        config,
        {
            "captured_at": utc_now_iso(),
            "status": "ok" if state.get("lease_state") == "active" else str(state.get("lease_state") or "unknown"),
            "last_success_at": state.get("last_backend_refresh_at"),
            "last_error_at": state.get("last_error_at"),
            "utilization_pct": state.get("latest_utilization_pct"),
            "quota_remaining": state.get("latest_quota_remaining"),
            "requests_count": None,
            "tokens_in": None,
            "tokens_out": None,
            "rate_limit_remaining": None,
            "error_rate_1h": None,
        },
    )
    return request_api(
        config,
        "POST",
        f"/api/leases/{urllib.parse.quote(lease_id, safe='')}/telemetry",
        payload,
    )


def api_reconcile_auth(config: dict[str, Any], lease_id: str, auth_json: dict[str, Any]) -> dict[str, Any]:
    payload = lease_payload(
        config,
        {
            "auth_json": auth_json,
        },
    )
    return request_api(
        config,
        "POST",
        f"/api/leases/{urllib.parse.quote(lease_id, safe='')}/reconcile-auth",
        payload,
    )


def api_rate_limit_resets(config: dict[str, Any], lease_id: str) -> dict[str, Any]:
    return request_api(
        config,
        "POST",
        f"/api/leases/{urllib.parse.quote(lease_id, safe='')}/rate-limit-resets/read",
        lease_payload(config),
    )


def api_consume_rate_limit_reset(
    config: dict[str, Any],
    lease_id: str,
    *,
    credit_id: str | None = None,
) -> dict[str, Any]:
    return request_api(
        config,
        "POST",
        f"/api/leases/{urllib.parse.quote(lease_id, safe='')}/rate-limit-resets/consume",
        lease_payload(
            config,
            {
                "idempotency_key": str(uuid.uuid4()),
                "credit_id": str(credit_id or "").strip() or None,
            },
        ),
    )


def active_lease_id(config: dict[str, Any]) -> str:
    state = read_lease_state(config, persist_client_identity=False)
    lease_id = str(state.get("lease_id") or "").strip()
    if not lease_id:
        raise RuntimeError("No active lease is available. Run ensure-lease first.")
    return lease_id


def should_renew_lease(state: dict[str, Any]) -> bool:
    remaining = seconds_until(state.get("expires_at"))
    if remaining is None:
        return False
    return remaining <= RENEW_LEEWAY_SECONDS


def should_rematerialize_auth(state: dict[str, Any]) -> bool:
    if not state.get("credential_auth_updated_at"):
        return False
    if not state.get("last_auth_write_at"):
        return True
    return str(state["credential_auth_updated_at"]) > str(state["last_auth_write_at"])


def materialize_and_write_auth(
    config: dict[str, Any],
    state: dict[str, Any],
    dry_run: bool,
) -> dict[str, Any]:
    lease_id = str(state.get("lease_id") or "").strip()
    if not lease_id:
        raise RuntimeError("Cannot materialize auth without an active lease.")
    if dry_run:
        return {
            "materialized": False,
            "dry_run": True,
            "lease_id": lease_id,
        }

    materialized = api_materialize_lease(config, lease_id)
    if materialized.get("status") != "ok":
        raise RuntimeError(materialized.get("reason") or "Lease materialization failed.")

    lease = materialized.get("lease")
    if isinstance(lease, dict):
        update_state_from_lease(state, lease)
    credential_material = materialized.get("credential_material")
    update_state_from_materialized(state, credential_material if isinstance(credential_material, dict) else None)
    auth_json = credential_material.get("auth_json") if isinstance(credential_material, dict) else None
    if not isinstance(auth_json, dict):
        raise RuntimeError(materialized.get("reason") or "Backend returned no auth payload for this lease.")

    save_result = save_codex_auth(config, auth_json, dry_run=False)
    state["last_auth_write_at"] = save_result.get("written_at") or utc_now_iso()
    return {
        "materialized": True,
        "dry_run": False,
        "lease_id": lease_id,
        "credential_material": {
            "label": state.get("account_label"),
            "email": state.get("account_email"),
            "name": state.get("account_name"),
            "credential_id": state.get("credential_id"),
        },
        "save": save_result,
    }


def reconcile_local_auth_if_needed(config: dict[str, Any], state: dict[str, Any]) -> dict[str, Any] | None:
    lease_id = str(state.get("lease_id") or "").strip()
    if not lease_id:
        return None
    local_auth = read_local_auth(config)
    if not isinstance(local_auth, dict):
        return None

    reconciled = api_reconcile_auth(config, lease_id, local_auth)
    updated_at = reconciled.get("credential_auth_updated_at")
    if isinstance(updated_at, str) and updated_at.strip():
        state["credential_auth_updated_at"] = updated_at.strip()

    decision = str(reconciled.get("decision") or "")
    auth_json = reconciled.get("auth_json")
    if decision in {"manager_updated_client", "identity_mismatch"} and isinstance(auth_json, dict):
        save_result = save_codex_auth(config, auth_json, dry_run=False)
        state["last_auth_write_at"] = save_result.get("written_at") or utc_now_iso()
        return {
            "decision": decision,
            "reason": reconciled.get("reason"),
            "save": save_result,
        }
    if decision == "client_updated_manager":
        state["last_auth_write_at"] = updated_at or local_auth.get("last_refresh") or utc_now_iso()
    return reconciled


def health_state_from_state(state: dict[str, Any]) -> str:
    if not state.get("backend_reachable") and state.get("last_error_at"):
        return "backend_unavailable"
    if not state.get("lease_id") or not state.get("lease_state") or not state.get("expires_at"):
        return "no_lease"
    if state.get("replacement_required"):
        return "rotation_required"
    remaining = seconds_until(state.get("expires_at"))
    if remaining is not None and remaining <= RENEW_LEEWAY_SECONDS:
        return "expiring"
    if str(state.get("lease_state") or "") in {"revoked", "released"}:
        return "revoked"
    return "active"


def sync_lease_runtime(
    config: dict[str, Any],
    *,
    dry_run: bool,
    no_reload: bool,
    force_rotate: bool,
) -> dict[str, Any]:
    persist_state = not dry_run
    state = read_lease_state(config, persist_client_identity=persist_state)
    actions: list[dict[str, Any]] = []
    local_auth = read_local_auth(config)

    try:
        if state.get("lease_id"):
            try:
                status = api_get_lease(config, str(state["lease_id"]))
                update_state_from_status(state, status)
            except Exception:
                clear_lease_assignment(state)
                state["backend_reachable"] = True

        if not state.get("lease_id"):
            if dry_run:
                status = None
                actions.append({"action": "acquire_lease", "dry_run": True})
            else:
                acquired = api_acquire_lease(config, reason="codex_desktop_plugin_ensure")
                if acquired.get("status") != "ok" or not isinstance(acquired.get("lease"), dict):
                    raise RuntimeError(acquired.get("reason") or "No eligible credentials available for lease acquisition.")
                update_state_from_lease(state, acquired["lease"])
                actions.append({"action": "acquire_lease", "reason": acquired.get("reason"), "lease_id": state.get("lease_id")})
                status = api_get_lease(config, str(state["lease_id"]))
                update_state_from_status(state, status)
        else:
            status = api_get_lease(config, str(state["lease_id"]))
            update_state_from_status(state, status)

        if not dry_run and state.get("lease_id") and isinstance(local_auth, dict):
            reconciled = reconcile_local_auth_if_needed(config, state)
            if reconciled is not None:
                actions.append({"action": "reconcile_auth", "result": reconciled})

        if force_rotate or state.get("replacement_required") or state.get("rotation_recommended"):
            if dry_run:
                actions.append(
                    {
                        "action": "rotate_lease",
                        "dry_run": True,
                        "reason": "forced" if force_rotate else "rotation_recommended_or_required",
                    }
                )
            else:
                rotated = api_rotate_lease(
                    config,
                    str(state["lease_id"]),
                    "forced_rotation" if force_rotate else "approaching_utilization_threshold",
                )
                if rotated.get("status") != "ok" or not isinstance(rotated.get("lease"), dict):
                    raise RuntimeError(rotated.get("reason") or "Lease rotation denied.")
                update_state_from_lease(state, rotated["lease"])
                actions.append({"action": "rotate_lease", "reason": rotated.get("reason"), "lease_id": state.get("lease_id")})
                materialized = materialize_and_write_auth(config, state, dry_run=False)
                actions.append({"action": "materialize_auth", "result": materialized})
                if not no_reload:
                    actions.append({"action": "reload_codex", "result": reload_codex(config, dry_run=False)})
        elif should_renew_lease(state):
            if dry_run:
                actions.append({"action": "renew_lease", "dry_run": True})
            else:
                renewed = api_renew_lease(config, str(state["lease_id"]))
                if renewed.get("status") != "ok" or not isinstance(renewed.get("lease"), dict):
                    raise RuntimeError(renewed.get("reason") or "Lease renewal denied.")
                update_state_from_lease(state, renewed["lease"])
                actions.append({"action": "renew_lease", "reason": renewed.get("reason"), "lease_id": state.get("lease_id")})
        elif not local_auth_summary(local_auth).get("present") or should_rematerialize_auth(state):
            if dry_run:
                actions.append({"action": "materialize_auth", "dry_run": True})
            else:
                materialized = materialize_and_write_auth(config, state, dry_run=False)
                actions.append({"action": "materialize_auth", "result": materialized})
                if not no_reload:
                    actions.append({"action": "reload_codex", "result": reload_codex(config, dry_run=False)})

        if not dry_run and state.get("lease_id"):
            api_post_telemetry(config, str(state["lease_id"]), state)
            refreshed = api_get_lease(config, str(state["lease_id"]))
            update_state_from_status(state, refreshed)
            actions.append({"action": "post_telemetry"})

        state["backend_reachable"] = True
        state["last_backend_refresh_at"] = utc_now_iso()
    except Exception as error:
        state["backend_reachable"] = False
        state["last_error_at"] = utc_now_iso()
        if persist_state:
            write_lease_state(config, state)
        raise

    if persist_state:
        write_lease_state(config, state)
    local_auth_after = read_local_auth(config)
    status = build_status(
        config,
        state_override=state,
        local_auth_override=local_auth_after,
        persist_client_identity=persist_state,
    )
    return {
        "status": status,
        "actions": actions,
    }


def build_status(
    config: dict[str, Any],
    *,
    state_override: dict[str, Any] | None = None,
    local_auth_override: dict[str, Any] | None = None,
    persist_client_identity: bool = False,
) -> dict[str, Any]:
    state = dict(state_override or read_lease_state(config, persist_client_identity=persist_client_identity))
    local_auth = local_auth_override if local_auth_override is not None else read_local_auth(config)
    local_summary = local_auth_summary(local_auth)
    health_state = health_state_from_state(state)
    needs_cycle = bool(state.get("replacement_required") or state.get("rotation_recommended"))

    restart_required = False
    restart_notice = None
    local_account_id = local_summary.get("account_id")
    expected_account_label = state.get("account_label")
    if not local_summary.get("present"):
        restart_notice = "No local auth.json found for Codex Desktop."
    elif state.get("last_auth_write_at") and state.get("credential_auth_updated_at"):
        if str(state["credential_auth_updated_at"]) > str(state["last_auth_write_at"]):
            restart_required = True
            restart_notice = "Local auth.json is older than the leased credential material."

    return {
        "client": get_client_identity(config, persist=persist_client_identity),
        "lease": state,
        "health_state": health_state,
        "backend": {
            "reachable": bool(state.get("backend_reachable", True)),
            "last_backend_refresh_at": state.get("last_backend_refresh_at"),
            "last_error_at": state.get("last_error_at"),
        },
        "current": {
            "current_label": expected_account_label,
            "email": state.get("account_email"),
            "name": state.get("account_name"),
            "account_key": state.get("credential_id"),
            "status": health_state,
        },
        "local_auth": local_summary,
        "windows": {
            "five_hour": {
                "used_percent": state.get("latest_primary_utilization_pct"),
                "resets_at": state.get("latest_primary_reset_at"),
                "maxed": bool(isinstance(state.get("latest_primary_utilization_pct"), (int, float)) and state.get("latest_primary_utilization_pct") >= 100),
            },
            "seven_day": {
                "used_percent": state.get("latest_secondary_utilization_pct"),
                "resets_at": state.get("latest_secondary_reset_at"),
                "maxed": bool(isinstance(state.get("latest_secondary_utilization_pct"), (int, float)) and state.get("latest_secondary_utilization_pct") >= 100),
            },
        },
        "restart_required": restart_required,
        "restart_notice": restart_notice,
        "needs_cycle": needs_cycle,
        "recommended_label": state.get("account_label"),
        "recommended_action": (
            "rotate"
            if needs_cycle
            else "renew"
            if should_renew_lease(state)
            else "materialize"
            if (not local_summary.get("present") or should_rematerialize_auth(state))
            else "noop"
        ),
        "local_sync": {
            "expected_label": expected_account_label,
            "local_account_id": local_account_id,
            "last_auth_write_at": state.get("last_auth_write_at"),
            "credential_auth_updated_at": state.get("credential_auth_updated_at"),
        },
    }


def build_usage_summary(config: dict[str, Any]) -> dict[str, Any]:
    status = build_status(config)
    lease = status.get("lease", {})
    windows = status.get("windows", {})
    backend = status.get("backend", {})
    return {
        "health_state": status.get("health_state"),
        "backend_reachable": backend.get("reachable"),
        "lease_id": lease.get("lease_id"),
        "credential_id": lease.get("credential_id"),
        "leased_label": status.get("current", {}).get("current_label"),
        "leased_email": status.get("current", {}).get("email"),
        "machine_id": status.get("client", {}).get("machine_id"),
        "agent_id": status.get("client", {}).get("agent_id"),
        "five_hour_used_percent": windows.get("five_hour", {}).get("used_percent"),
        "five_hour_resets_at": windows.get("five_hour", {}).get("resets_at"),
        "seven_day_used_percent": windows.get("seven_day", {}).get("used_percent"),
        "seven_day_resets_at": windows.get("seven_day", {}).get("resets_at"),
        "latest_quota_remaining": lease.get("latest_quota_remaining"),
        "rotation_recommended": lease.get("rotation_recommended"),
        "replacement_required": lease.get("replacement_required"),
        "recommended_action": status.get("recommended_action"),
        "local_auth_present": status.get("local_auth", {}).get("present"),
        "local_account_id": status.get("local_auth", {}).get("account_id"),
        "last_backend_refresh_at": backend.get("last_backend_refresh_at"),
        "last_auth_write_at": lease.get("last_auth_write_at"),
        "credential_auth_updated_at": lease.get("credential_auth_updated_at"),
        "restart_required": status.get("restart_required"),
        "restart_notice": status.get("restart_notice"),
        "token_usage_supported": False,
        "token_usage_note": "Exact per-request token counts are not available from Codex Desktop here; this summary reflects lease and rate-limit telemetry from Auth Manager.",
    }


def run_single_watcher_cycle(config: dict[str, Any]) -> dict[str, Any]:
    result = sync_lease_runtime(
        config,
        dry_run=False,
        no_reload=False,
        force_rotate=False,
    )
    append_watcher_log(
        config,
        f"Watcher synced lease={result['status']['lease'].get('lease_id')} action_count={len(result['actions'])} health={result['status']['health_state']}",
    )
    return result


def watcher_run(config: dict[str, Any]) -> int:
    write_watcher_pid(config, os.getpid())
    append_watcher_log(config, "Watcher started.")
    interval_seconds = watcher_interval_seconds(config)
    codex_missing_since: float | None = None
    try:
        while True:
            if not codex_is_running():
                if codex_missing_since is None:
                    codex_missing_since = time.time()
                    append_watcher_log(
                        config,
                        "Codex.exe not detected. Waiting through grace period before stopping watcher.",
                    )

                elapsed = time.time() - codex_missing_since
                if elapsed >= watcher_codex_exit_grace_seconds(config):
                    write_watcher_status(
                        config,
                        watcher_status_payload(
                            config,
                            "stopped",
                            {
                                "reason": "Codex.exe has been closed beyond the configured grace period.",
                                "codex_missing_for_seconds": round(elapsed, 1),
                            },
                        ),
                    )
                    append_watcher_log(
                        config,
                        "Codex.exe remained closed past grace period. Stopping watcher.",
                    )
                    return 0

                write_watcher_status(
                    config,
                    watcher_status_payload(
                        config,
                        "waiting-for-codex",
                        {
                            "reason": "Codex.exe is not running. Waiting to see if it restarts.",
                            "codex_missing_for_seconds": round(elapsed, 1),
                        },
                    ),
                )
                time.sleep(min(interval_seconds, 5))
                continue

            if codex_missing_since is not None:
                append_watcher_log(config, "Codex.exe detected again during grace period. Continuing watcher.")
                codex_missing_since = None

            try:
                cycle = run_single_watcher_cycle(config)
                write_watcher_status(
                    config,
                    watcher_status_payload(
                        config,
                        "running",
                        {
                            "last_cycle": cycle,
                        },
                    ),
                )
            except Exception as error:  # noqa: BLE001
                append_watcher_log(config, f"Watcher cycle failed: {error}")
                write_watcher_status(
                    config,
                    watcher_status_payload(
                        config,
                        "error",
                        {
                            "error": str(error),
                        },
                    ),
                )
            time.sleep(interval_seconds)
    finally:
        append_watcher_log(config, "Watcher stopped.")
        clear_watcher_pid(config)


def watcher_start(config: dict[str, Any], config_path: str) -> dict[str, Any]:
    pid = read_watcher_pid(config)
    if process_is_running(pid):
        return {
            "started": False,
            "reason": "Watcher is already running.",
            "pid": pid,
        }

    paths = watcher_paths(config)
    paths["base_dir"].mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "watcher-run",
        "--config",
        str(Path(config_path).expanduser().resolve()),
    ]
    process = subprocess.Popen(
        command,
        stdout=paths["log_file"].open("a", encoding="utf-8"),
        stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        close_fds=True,
    )
    write_watcher_pid(config, process.pid)
    write_watcher_status(config, watcher_status_payload(config, "starting"))
    return {
        "started": True,
        "pid": process.pid,
        "log_file": str(paths["log_file"]),
        "status_file": str(paths["status_file"]),
        "lease_state_file": str(paths["lease_state_file"]),
    }


def watcher_stop(config: dict[str, Any]) -> dict[str, Any]:
    pid = read_watcher_pid(config)
    if not process_is_running(pid):
        clear_watcher_pid(config)
        write_watcher_status(config, watcher_status_payload(config, "stopped"))
        return {
            "stopped": False,
            "reason": "Watcher is not running.",
        }

    subprocess.run(
        ["powershell", "-NoProfile", "-Command", f"Stop-Process -Id {pid} -Force"],
        capture_output=True,
        text=True,
        check=False,
    )
    clear_watcher_pid(config)
    write_watcher_status(config, watcher_status_payload(config, "stopped"))
    append_watcher_log(config, f"Watcher stop requested for pid {pid}.")
    return {
        "stopped": True,
        "pid": pid,
    }


def watcher_status(config: dict[str, Any]) -> dict[str, Any]:
    pid = read_watcher_pid(config)
    paths = watcher_paths(config)
    return {
        "pid": pid,
        "running": process_is_running(pid),
        "interval_seconds": watcher_interval_seconds(config),
        "codex_running": codex_is_running(),
        "codex_exit_grace_seconds": watcher_codex_exit_grace_seconds(config),
        "status_file": str(paths["status_file"]),
        "log_file": str(paths["log_file"]),
        "lease_state_file": str(paths["lease_state_file"]),
        "last_status": read_watcher_status(config),
        "lease_state": read_lease_state(config),
    }


def find_codex_executable() -> str | None:
    command = (
        "Get-Process Codex -ErrorAction SilentlyContinue | "
        "Where-Object { $_.Path } | "
        "Select-Object -ExpandProperty Path -First 1"
    )
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-Command", command],
        capture_output=True,
        text=True,
        check=False,
    )
    candidate = completed.stdout.strip()
    return candidate or None


def reload_codex(config: dict[str, Any], dry_run: bool) -> dict[str, Any]:
    executable = find_codex_executable()
    delay_seconds = int(config["codex"].get("restart_delay_seconds", 2))
    if not executable:
        return {
            "reloaded": False,
            "error": "Could not find a running Codex.exe process to restart.",
        }

    command = (
        f"Start-Sleep -Seconds {delay_seconds}; "
        "Get-Process Codex -ErrorAction SilentlyContinue | Stop-Process -Force; "
        f"Start-Process -FilePath '{executable}'"
    )

    if dry_run:
        return {
            "reloaded": False,
            "dry_run": True,
            "command": command,
            "executable": executable,
        }

    subprocess.Popen(
        [
            "powershell",
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            command,
        ],
        creationflags=getattr(subprocess, "DETACHED_PROCESS", 0)
        | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        close_fds=True,
    )
    return {
        "reloaded": True,
        "dry_run": False,
        "executable": executable,
    }


def render_dashboard_html(status: dict[str, Any]) -> str:
    status_json = json.dumps(status)
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Auth Manager Cycler Dashboard</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: #0b1220;
      --panel: rgba(15, 23, 42, 0.86);
      --panel-border: rgba(148, 163, 184, 0.18);
      --text: #e5eefb;
      --muted: #94a3b8;
      --accent: #14b8a6;
      --warn: #f59e0b;
      --danger: #ef4444;
      --good: #22c55e;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: "Segoe UI", system-ui, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(20, 184, 166, 0.16), transparent 30%),
        radial-gradient(circle at top right, rgba(59, 130, 246, 0.12), transparent 28%),
        linear-gradient(180deg, #08101c 0%, #0b1220 100%);
    }}
    main {{
      max-width: 1100px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }}
    .hero {{
      display: grid;
      gap: 18px;
      margin-bottom: 24px;
    }}
    .eyebrow {{
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 12px;
      font-weight: 700;
    }}
    h1 {{
      margin: 0;
      font-size: clamp(32px, 5vw, 54px);
      line-height: 0.96;
    }}
    .sub {{
      max-width: 760px;
      color: var(--muted);
      font-size: 16px;
      line-height: 1.6;
    }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 16px;
    }}
    .panel {{
      background: var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.24);
      backdrop-filter: blur(10px);
    }}
    .label {{
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 10px;
    }}
    .value {{
      font-size: 30px;
      font-weight: 700;
      line-height: 1.1;
      word-break: break-word;
    }}
    .small {{
      margin-top: 8px;
      color: var(--muted);
      font-size: 14px;
    }}
    .mono {{
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 13px;
      word-break: break-all;
    }}
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="eyebrow">Codex Desktop Auth Manager</div>
      <h1>Lease status and local auth sync</h1>
      <div class="sub">This dashboard is a snapshot of the current lease, local auth file state, and 5 hour / 7 day utilization as seen by the desktop plugin.</div>
    </section>
    <section class="grid" id="summary"></section>
  </main>
  <script>
    const status = {status_json};
    const cards = [
      {{
        label: 'Health',
        value: status.health_state || 'unknown',
        small: status.backend.reachable ? 'Backend reachable' : 'Backend unavailable'
      }},
      {{
        label: 'Lease',
        value: status.lease.lease_id || 'none',
        small: status.current.current_label || 'No leased label'
      }},
      {{
        label: '5 Hour Window',
        value: status.windows.five_hour.used_percent ?? 'n/a',
        small: status.windows.five_hour.resets_at || 'No reset time'
      }},
      {{
        label: '7 Day Window',
        value: status.windows.seven_day.used_percent ?? 'n/a',
        small: status.windows.seven_day.resets_at || 'No reset time'
      }},
      {{
        label: 'Recommended Action',
        value: status.recommended_action || 'noop',
        small: status.needs_cycle ? 'Rotation recommended or required' : 'Lease is stable'
      }},
      {{
        label: 'Local Auth',
        value: status.local_auth.present ? 'present' : 'missing',
        small: status.restart_notice || (status.local_auth.account_id || 'No local account id')
      }},
      {{
        label: 'Machine',
        value: status.client.machine_id,
        small: status.client.agent_id
      }},
      {{
        label: 'Credential',
        value: status.lease.credential_id || 'none',
        small: status.current.email || 'No email'
      }}
    ];

    document.getElementById('summary').innerHTML = cards.map(card => `
      <div class="panel">
        <div class="label">${{card.label}}</div>
        <div class="value">${{card.value}}</div>
        <div class="small mono">${{card.small}}</div>
      </div>
    `).join('');
  </script>
</body>
</html>
"""


def write_dashboard(config: dict[str, Any], status: dict[str, Any]) -> dict[str, Any]:
    dashboard_path = Path(__file__).resolve().parent.parent / "ui" / "auth-manager-dashboard.html"
    dashboard_path.parent.mkdir(parents=True, exist_ok=True)
    dashboard_path.write_text(render_dashboard_html(status), encoding="utf-8")
    return {
        "path": str(dashboard_path),
    }


def main() -> int:
    args = parse_args()

    try:
        config = load_config(args.config)

        if args.command == "watcher-run":
            return watcher_run(config)

        if args.command == "watcher-start":
            result = watcher_start(config, args.config)
            print(json.dumps({"watcher": result}, indent=2))
            return 0

        if args.command == "watcher-stop":
            result = watcher_stop(config)
            print(json.dumps({"watcher": result}, indent=2))
            return 0

        if args.command == "watcher-status":
            result = watcher_status(config)
            print(json.dumps({"watcher": result}, indent=2))
            return 0

        if args.command == "status":
            status = build_status(config)
            print(json.dumps(status, indent=2))
            return 0

        if args.command == "usage-summary":
            summary = build_usage_summary(config)
            print(json.dumps(summary, indent=2))
            return 0

        if args.command == "rate-limit-resets":
            resets = api_rate_limit_resets(config, active_lease_id(config))
            print(json.dumps(resets, indent=2))
            return 0

        if args.command == "use-rate-limit-reset":
            if not args.yes:
                raise RuntimeError("Refusing to consume a reset without --yes.")
            result = api_consume_rate_limit_reset(
                config,
                active_lease_id(config),
                credit_id=args.credit_id,
            )
            print(json.dumps(result, indent=2))
            return 0

        if args.command == "ensure-lease":
            result = sync_lease_runtime(
                config,
                dry_run=args.dry_run,
                no_reload=args.no_reload,
                force_rotate=False,
            )
            print(json.dumps(result, indent=2))
            return 0

        if args.command == "dashboard":
            status = build_status(config)
            result = write_dashboard(config, status)
            print(json.dumps({"status": status, "dashboard": result}, indent=2))
            return 0

        if args.command == "apply-recommended":
            result = sync_lease_runtime(
                config,
                dry_run=args.dry_run,
                no_reload=args.no_reload,
                force_rotate=True,
            )
            print(json.dumps(result, indent=2))
            return 0

        result = sync_lease_runtime(
            config,
            dry_run=args.dry_run,
            no_reload=args.no_reload,
            force_rotate=False,
        )
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
