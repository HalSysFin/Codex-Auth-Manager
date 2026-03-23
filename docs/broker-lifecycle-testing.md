# Broker Lifecycle Testing

This repo keeps the broker lifecycle aligned across the backend and all client surfaces with a practical, scriptable test stack.

## Covered Scenarios

The current suite exercises the canonical lease lifecycle paths:

- acquire plus materialize
- startup with an existing healthy lease
- missing or stale lease lookup leading to reacquire
- revoked and expired lease handling
- `replacement_required` rotation behavior
- near-expiry renew behavior
- exhaustion-driven lease invalidation on the backend
- weekly reset confirmation behavior
- telemetry round-trip and latest-summary updates
- OpenClaw usage normalization and telemetry flushing

## Coverage By Surface

- `tests/test_lease_broker_store.py`
  Backend broker/store integration against a temporary SQLite test DB. This covers acquire, materialize, renew, rotate, revoke/exhaust, release, ownership validation, telemetry summary updates, and weekly reset confirmation behavior.
- `packages/lease-runtime/src/test/*.test.ts`
  Shared lifecycle parity tests for acquire/reacquire/rotate/renew/noop decisions, auth materialization contract handling, and truthful telemetry shaping.
- `vscode-extension/src/test/*.test.ts`
  VS Code runtime/helper tests that verify shared lifecycle parity, auth payload validation, and persisted lease metadata behavior.
- `desktop-app/src/test/*.test.ts`
  Desktop runtime tests for shared startup actions, auth payload handling, and persisted state.
- `headless-client/src/test/*.test.ts`
  Headless runtime tests for status rendering, shared startup actions, and auth file helpers.
- `openclaw-plugin/src/test/*.test.ts`
  OpenClaw usage normalization, telemetry posting, request-threshold flushing, and lease-context update behavior.

## What Remains Mocked

- GUI event loops and full VS Code/Tauri host integration are still covered through runtime/helper tests instead of full UI harnesses.
- OpenClaw runtime hook-up is still outside this repo. The plugin tests prove normalization and posting behavior, but the final live hook into OpenClaw’s response lifecycle must still be applied in the OpenClaw runtime itself.
- Backend API round-trips for TypeScript clients are covered with mocked fetch implementations rather than a live HTTP server.

## Running The Suite

From the repo root:

```bash
./scripts/run-broker-lifecycle-tests.sh
```

The runner tries the backend broker test in the local Python environment first. If local backend Python dependencies are missing, it falls back to the running `auth_manager-auth-manager-1` container when available.

Or run the pieces directly:

```bash
python3 -m unittest tests.test_lease_broker_store
npm --prefix packages/lease-runtime test
npm --prefix vscode-extension test
npm --prefix desktop-app test
npm --prefix headless-client test
npm --prefix openclaw-plugin test
```

## Notes

- The backend test uses the repo’s temporary SQLite broker store setup, so it does not require a running Postgres instance.
- The client suites expect their package dependencies to be installed first with `npm install` in each package directory.
- The root runner bootstraps missing package-local Node test dependencies automatically with `npm install --no-package-lock` before running the TypeScript suites.
