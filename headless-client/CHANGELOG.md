# Changelog

## 0.1.4 - 2026-07-16

- add read-only `resets` and explicitly confirmed `reset --yes` commands
- scope reset operations to the active lease identity
- replace legacy 5-hour and 7-day status lines with the selected rate-limit period

## 0.1.2 - 2026-04-01

- added bidirectional auth reconciliation before lease status refreshes
- uploads fresher local auth back to Auth Manager when Codex refreshed outside the agent
- rewrites the local auth file when the manager has newer tokens
