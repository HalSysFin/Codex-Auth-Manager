---
description: Check or consume a banked Codex rate-limit reset for the active auth-manager lease.
---

Inspect reset availability without changing anything:

```bash
python scripts/auth_manager_cycler.py rate-limit-resets
```

Only consume a reset after the user explicitly confirms. Redemption requires `--yes`:

```bash
python scripts/auth_manager_cycler.py use-rate-limit-reset --yes
```

Never consume a reset from the watcher or automatic lease maintenance.
