from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from .config import settings


@dataclass
class CodexSwitchResult:
    command: list[str]
    returncode: int
    stdout: str
    stderr: str


class CodexSwitchError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        command: list[str],
        exit_code: int | None = None,
        stdout: str = "",
        stderr: str = "",
    ) -> None:
        super().__init__(message)
        self.command = command
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr


def run_codex_switch(args: Sequence[str], *, check: bool = True) -> CodexSwitchResult:
    primary = settings.codex_switch_bin
    candidates: list[str] = [primary]
    if primary == "codex-switch":
        candidates.append("cxs")
    elif primary == "cxs":
        candidates.append("codex-switch")

    completed = None
    cmd: list[str] = []
    last_os_error: OSError | None = None
    for binary in candidates:
        cmd = [binary, *args]
        try:
            completed = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            break
        except FileNotFoundError:
            continue
        except OSError as exc:
            last_os_error = exc
            break

    if completed is None:
        if last_os_error is not None:
            raise CodexSwitchError(
                f"Unable to execute codex-switch: {last_os_error}",
                command=cmd or [primary, *args],
            ) from last_os_error
        raise CodexSwitchError(
            f"codex-switch binary not found: {primary} (also tried: {', '.join(candidates[1:]) or 'none'})",
            command=cmd or [primary, *args],
        )

    result = CodexSwitchResult(
        command=cmd,
        returncode=completed.returncode,
        stdout=(completed.stdout or "").strip(),
        stderr=(completed.stderr or "").strip(),
    )

    if check and result.returncode != 0:
        message = result.stderr or result.stdout or "codex-switch failed"
        raise CodexSwitchError(
            message,
            command=cmd,
            exit_code=result.returncode,
            stdout=result.stdout,
            stderr=result.stderr,
        )

    return result


def save_label(label: str) -> CodexSwitchResult:
    try:
        return run_codex_switch(["save", "--label", label], check=True)
    except CodexSwitchError as exc:
        return _save_label_fallback(label, exc)


def switch_label(label: str) -> CodexSwitchResult:
    try:
        return run_codex_switch(["switch", "--label", label], check=True)
    except CodexSwitchError as exc:
        return _switch_label_fallback(label, exc)


def list_labels() -> list[str]:
    result = run_codex_switch(["list"], check=False)
    if result.returncode == 0 and result.stdout:
        labels: list[str] = []
        for line in result.stdout.splitlines():
            normalized = line.strip()
            if not normalized:
                continue
            normalized = normalized.lstrip("*-").strip()
            if normalized:
                labels.append(normalized)
        if labels:
            return labels

    return _labels_from_profiles_dir(settings.profiles_dir())


def current_label() -> str | None:
    result = run_codex_switch(["current"], check=False)
    if result.returncode == 0 and result.stdout:
        first = result.stdout.splitlines()[0].strip()
        return first or None
    return None


def _labels_from_profiles_dir(profiles_dir: Path) -> list[str]:
    if not profiles_dir.exists():
        return []

    labels: list[str] = []
    for path in sorted(profiles_dir.iterdir()):
        if path.is_file():
            labels.append(path.stem)
    return labels


def _save_label_fallback(label: str, cause: CodexSwitchError) -> CodexSwitchResult:
    auth_path = settings.codex_auth_file()
    if not auth_path.exists():
        raise CodexSwitchError(
            f"Auth file not found at {auth_path}",
            command=["internal-save", "--label", label],
        ) from cause

    try:
        auth_json = json.loads(auth_path.read_text())
    except (OSError, ValueError) as exc:
        raise CodexSwitchError(
            f"Unable to read current auth JSON: {exc}",
            command=["internal-save", "--label", label],
        ) from exc

    profiles_dir = settings.profiles_dir()
    profiles_dir.mkdir(parents=True, exist_ok=True)
    target = profiles_dir / f"{label}.json"
    try:
        target.write_text(json.dumps(auth_json, indent=2, sort_keys=True))
    except OSError as exc:
        raise CodexSwitchError(
            f"Unable to save profile '{label}': {exc}",
            command=["internal-save", "--label", label],
        ) from exc

    return CodexSwitchResult(
        command=["internal-save", "--label", label],
        returncode=0,
        stdout=f"Saved profile '{label}' to {target}",
        stderr=f"Fallback used because external codex-switch failed: {cause}",
    )


def _switch_label_fallback(label: str, cause: CodexSwitchError) -> CodexSwitchResult:
    profile_path = settings.profiles_dir() / f"{label}.json"
    if not profile_path.exists():
        raise CodexSwitchError(
            f"Profile '{label}' not found at {profile_path}",
            command=["internal-switch", "--label", label],
        ) from cause

    try:
        profile_json = json.loads(profile_path.read_text())
    except (OSError, ValueError) as exc:
        raise CodexSwitchError(
            f"Unable to read profile '{label}': {exc}",
            command=["internal-switch", "--label", label],
        ) from exc

    if isinstance(profile_json, dict) and isinstance(profile_json.get("authJson"), dict):
        auth_json = profile_json["authJson"]
    else:
        auth_json = profile_json

    auth_path = settings.codex_auth_file()
    auth_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        auth_path.write_text(json.dumps(auth_json, indent=2, sort_keys=True))
    except OSError as exc:
        raise CodexSwitchError(
            f"Unable to switch to profile '{label}': {exc}",
            command=["internal-switch", "--label", label],
        ) from exc

    return CodexSwitchResult(
        command=["internal-switch", "--label", label],
        returncode=0,
        stdout=f"Switched to profile '{label}' via internal fallback",
        stderr=f"Fallback used because external codex-switch failed: {cause}",
    )
