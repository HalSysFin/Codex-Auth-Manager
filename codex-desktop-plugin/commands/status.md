---
description: Show the current Codex Desktop lease, live 5-hour and 7-day utilization, and local auth sync state.
---

# Auth Manager Status

Inspect the current Codex Desktop auth-manager state without changing auths.

For a smaller AI-friendly payload, use `usage-summary` instead of `status`.
For an active repair/sync action, use `ensure-lease`.

## What to run

```powershell
python ./scripts/auth_manager_cycler.py status --config ./config.local.json
```

## What to report

- Current leased label and email
- Whether the backend connection is healthy
- The 5-hour `used_percent`
- The 7-day `used_percent`
- Whether a rotation is needed now
- The recommended action
- The active lease id and credential id
- The client identity being sent to the manager:
  - product
  - unique client id
  - machine id
  - agent id

## Rules

- Do not rotate auths in this command.
- Do not print raw token material.
- If the API call fails, report the error clearly and stop.
