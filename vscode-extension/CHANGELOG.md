# Changelog

## 1.12.11 - 2026-07-16

- Show banked Codex rate-limit resets for the currently leased account.
- Add a confirmed command to redeem one reset through the lease-scoped Auth Manager API.

## 1.12.10 - 2026-07-16

- Display one applicable rate limit: weekly for paid accounts and monthly for free accounts.

## 1.12.9 - 2026-07-16

- Trust the manager refresh flag when a safer auth delivery format must be materialized.

## 1.12.6 - 2026-04-01

- added bidirectional auth reconciliation on lease check-in
- detects fresher local `~/.codex/auth.json` and uploads it to Auth Manager
- rewrites the local auth file automatically when the manager has newer tokens
