# Codex Desktop Plugin

This is a repo-local Codex Desktop plugin scaffold for connecting Codex Desktop to your auth manager through the same lease flow used by the other clients. It acquires a lease, materializes auth into Codex Desktop, reconciles stale local auth, and reports readable lease telemetry.

## What it does

- Acquires and refreshes `/api/leases/*` auth-manager leases
- Materializes leased auth into `~/.codex/auth.json`
- Reconciles stale local auth back to the manager when needed
- Posts lease telemetry and reads 5-hour / 7-day utilization from lease status
- Sends `codex-desktop` plus a persistent unique client ID on each request
- Backs up the previous Codex auth file before overwriting it
- Restarts Codex Desktop so it re-instantiates with the new auth

## Files

- `.codex-plugin/plugin.json`: Codex Desktop plugin manifest
- `commands/status.md`: on-demand status workflow
- `commands/dashboard.md`: dashboard generation workflow
- `config.example.json`: example API wiring
- `scripts/auth_manager_cycler.py`: local runner for lease status, sync, and rotation
- `ui/auth-manager-dashboard.html`: generated live status snapshot
- `skills/auth-manager-cycler/SKILL.md`: instructions Codex can use inside the plugin

## Quick start

1. Copy `config.example.json` to `config.local.json`.
2. Copy your real token into the environment as `INTERNAL_API_TOKEN`.
3. Review the Codex paths in `config.local.json` if your home directory differs.
4. The plugin will persist a unique client ID at `~/.codex/codex-desktop-plugin-client-id.txt` unless you override `client.id_path`.
5. Run:

```bash
python ./scripts/auth_manager_cycler.py status
python ./scripts/auth_manager_cycler.py usage-summary
python ./scripts/auth_manager_cycler.py rate-limit-resets
python ./scripts/auth_manager_cycler.py use-rate-limit-reset --yes
python ./scripts/auth_manager_cycler.py ensure-lease
python ./scripts/auth_manager_cycler.py dashboard
python ./scripts/auth_manager_cycler.py cycle-if-needed --dry-run
python ./scripts/auth_manager_cycler.py apply-recommended --dry-run
python ./scripts/auth_manager_cycler.py watcher-start
python ./scripts/auth_manager_cycler.py watcher-status
python ./scripts/auth_manager_cycler.py watcher-stop
```

## Background watcher

The watcher runs in the background while Codex is open and checks the manager every `watcher.interval_seconds`.

It exists because Codex Desktop does not provide the same always-on extension host lifecycle as the VS Code-style clients. The watcher is the component that keeps the desktop plugin synchronized with Auth Manager between manual commands.

What the watcher does:

- polls the auth manager lease endpoints on an interval
- acquires a lease if Codex Desktop does not currently have one
- refreshes lease status and posts telemetry back to the manager
- materializes fresh auth when the leased credential changes
- reconciles local auth drift if the local `auth.json` no longer matches the leased credential
- rotates the lease when replacement is recommended or required
- stops itself when `Codex.exe` has been closed beyond the configured grace period

- `watcher-start`: starts the detached watcher process
- `watcher-status`: shows whether the watcher is running and its last cycle state
- `watcher-stop`: stops the watcher
- if `Codex.exe` disappears briefly during a restart, the watcher waits through `watcher.codex_exit_grace_seconds`
- if `Codex.exe` stays closed past that grace period, the watcher exits automatically

Watcher files live under `~/.codex/codex-desktop-plugin/` by default:

- `watcher.pid`
- `watcher-status.json`
- `watcher.log`
- `lease-state.json`

## Important assumption

This plugin now targets the live lease endpoints only. The supported flows are lease-based: `ensure-lease`, `usage-summary`, `cycle-if-needed`, `apply-recommended`, and the watcher commands.

## Usage Summary

Use `usage-summary` when you want a compact AI-readable payload instead of the full status object:

```bash
python ./scripts/auth_manager_cycler.py usage-summary
```

It reports lease identity, 5-hour and 7-day utilization, quota/rotation state, local auth sync state, and whether a restart is needed.

## Ensure Lease

Use `ensure-lease` when you want the plugin to acquire or refresh the current lease and materialize auth if needed:

```bash
python ./scripts/auth_manager_cycler.py ensure-lease
```

Add `--dry-run` to preview what it would do, or `--no-reload` to update local auth without restarting Codex Desktop.

## Rate-Limit Resets

`rate-limit-resets` lists banked resets for the leased account without changing anything. `use-rate-limit-reset --yes` consumes one; `--credit-id <id>` can select a specific returned credit. Watcher and automatic lease flows never redeem resets.
