from __future__ import annotations

import asyncio
import logging
import signal
import sys
from contextlib import suppress

from .config import settings
from .main import (
    _initialize_runtime_state,
    _periodic_reconcile_broker_leases,
    _periodic_reconcile_usage_windows,
    _periodic_refresh_profile_rate_limits,
    _periodic_refresh_saved_auths,
)


logger = logging.getLogger("auth_manager.worker")


async def _run_worker(role: str) -> None:
    await _initialize_runtime_state(refresh_saved_auths_on_startup=(role == "refresh"))
    logger.info("background worker starting role=%s configured_role=%s", role, settings.auth_manager_process_role)

    tasks: list[asyncio.Task] = []
    if role == "lease":
        tasks.append(asyncio.create_task(_periodic_reconcile_broker_leases()))
    elif role == "refresh":
        tasks.append(asyncio.create_task(_periodic_reconcile_usage_windows()))
        if settings.auth_keepalive_in_app:
            tasks.append(asyncio.create_task(_periodic_refresh_saved_auths()))
        tasks.append(asyncio.create_task(_periodic_refresh_profile_rate_limits()))
    else:
        raise SystemExit(f"Unknown worker role: {role}")

    stop_event = asyncio.Event()

    def _request_stop(*_: object) -> None:
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with suppress(NotImplementedError):
            loop.add_signal_handler(sig, _request_stop)

    await stop_event.wait()

    for task in tasks:
        task.cancel()
    for task in tasks:
        with suppress(asyncio.CancelledError):
            await task


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    role = (args[0] if args else "").strip().lower()
    if not role:
        raise SystemExit("Usage: python -m app.worker_main <lease|refresh>")
    logging.basicConfig(level=logging.INFO)
    asyncio.run(_run_worker(role))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
