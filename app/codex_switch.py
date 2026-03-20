from __future__ import annotations

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
    cmd = [settings.codex_switch_bin, *args]
    try:
        completed = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise CodexSwitchError(
            f"codex-switch binary not found: {settings.codex_switch_bin}",
            command=cmd,
        ) from exc
    except OSError as exc:
        raise CodexSwitchError(f"Unable to execute codex-switch: {exc}", command=cmd) from exc

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
    return run_codex_switch(["save", "--label", label], check=True)


def switch_label(label: str) -> CodexSwitchResult:
    return run_codex_switch(["switch", "--label", label], check=True)


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
