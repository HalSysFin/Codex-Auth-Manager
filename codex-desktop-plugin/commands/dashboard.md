---
description: Generate a local HTML dashboard for the current Codex Desktop lease and live usage data.
---

# Auth Manager Dashboard

Generate a local dashboard snapshot for the current Codex Desktop auth-manager state.

## What to run

```powershell
python ./scripts/auth_manager_cycler.py dashboard --config ./config.local.json
```

## What to report

- The path to the generated HTML file
- The current leased label
- The lease id
- The recommended action
- Whether the current lease is within limits

## Notes

- The dashboard is a snapshot generated at run time.
- Regenerate it whenever you want fresh data.
