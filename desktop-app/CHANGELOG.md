# Changelog

## 0.1.4 - 2026-07-16

- show banked rate-limit reset availability for the active lease
- add a separately confirmed action to consume one reset
- keep all automatic lease and auth refresh paths read-only for reset credits

## 0.1.2 - 2026-04-01

- added bidirectional auth reconciliation before lease status refreshes
- uploads fresher local auth back to Auth Manager when Codex refreshed outside the app
- rewrites the local auth file when the manager has newer tokens
