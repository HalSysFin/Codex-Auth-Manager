---
name: auth-manager-cycler
description: Check lease-based auth-manager utilization for 5-hour and 7-day windows, and rotate the Codex Desktop lease when needed.
---

# Auth Manager Cycler

Use this skill when the user wants Codex Desktop to inspect lease utilization, materialize the leased auth into Codex's local auth file, and restart Codex when needed.

## Setup

1. Copy `config.example.json` to `config.local.json`.
2. Set `INTERNAL_API_TOKEN` in the environment.
3. Review `codex.auth_path` and `codex.backup_dir` if needed.

## Commands

Check utilization only:

```bash
python ./scripts/auth_manager_cycler.py status
```

Check a compact AI-friendly lease summary:

```bash
python ./scripts/auth_manager_cycler.py usage-summary
```

Ensure Codex Desktop has an active lease and materialized auth:

```bash
python ./scripts/auth_manager_cycler.py ensure-lease
```

Check utilization and only replace the Codex auth if either window is maxed:

```bash
python ./scripts/auth_manager_cycler.py cycle-if-needed
```

Preview the replacement and reload flow without changing anything:

```bash
python ./scripts/auth_manager_cycler.py cycle-if-needed --dry-run
```

Apply the manager's recommended auth immediately:

```bash
python ./scripts/auth_manager_cycler.py apply-recommended
```

## Expected API shape

- `/api/leases/acquire` should issue a lease for the current desktop client.
- `/api/leases/{lease_id}` should return current lease status, including 5-hour and 7-day utilization.
- `/api/leases/{lease_id}/materialize` should return the current leased auth payload.
- `/api/leases/{lease_id}/reconcile-auth` should keep local auth and manager auth in sync.
- `/api/leases/{lease_id}/telemetry` should accept lightweight lease telemetry.

## Notes

- The script overwrites Codex's local auth file and creates a timestamped backup first when materializing new auth.
- Reload uses a detached PowerShell helper that stops `Codex.exe` and starts it again.
- Exact per-request token counts are not exposed by Codex Desktop here; the plugin reports lease and rate-limit telemetry instead.
