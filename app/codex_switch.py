from __future__ import annotations

import subprocess
from typing import Sequence

from .config import settings


class CodexSwitchError(RuntimeError):
    pass


def run_codex_switch(args: Sequence[str]) -> None:
    cmd = [settings.codex_switch_bin, *args]
    try:
        completed = subprocess.run(
            cmd,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError as exc:
        raise CodexSwitchError(
            f"codex-switch binary not found: {settings.codex_switch_bin}"
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise CodexSwitchError(
            f"codex-switch failed: {exc.stderr.strip() or exc.stdout.strip()}"
        ) from exc

    if completed.stderr:
        stderr = completed.stderr.strip()
        if stderr:
            raise CodexSwitchError(stderr)


def save_label(label: str) -> None:
    run_codex_switch(["save", "--label", label])
