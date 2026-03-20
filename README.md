# Codex Auth Manager (FastAPI)

Central orchestration service for Codex auth profiles.

Primary architecture:
- Codex CLI performs login and writes `~/.codex/auth.json`
- `codex-switch` stores/switches labeled profiles
- `auth-manager` orchestrates login status, import/labeling, API, and UI

Legacy callback/exchange routes are still available, but the primary happy path is now Codex CLI driven.

## Requirements

- Python 3.10+
- `codex` CLI installed and on `PATH` (or set `CODEX_CLI_BIN`)
- `codex-switch` installed and on `PATH` (or set `CODEX_SWITCH_BIN`)

## Setup

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
uvicorn app.main:app --reload --port 8080
```

Open `http://localhost:8080/`.

## Primary Flow

1. Click **Add account** (or `POST /auth/login/start`) to launch Codex CLI login.
2. Codex CLI produces/updates `CODEX_AUTH_PATH` (default `~/.codex/auth.json`).
3. Click **Import current auth** (or `POST /auth/import-current`).
4. auth-manager extracts email and derives a label when none is provided.
5. auth-manager runs `codex-switch save --label <label>`.
6. Switch later via UI or `POST /auth/switch`.

## Endpoints

Core:
- `GET /health`
- `GET /` and `GET /ui` dashboard
- `GET /api/accounts` list saved accounts + rate limit probes
- `POST /auth/login/start` start Codex CLI login
- `GET /auth/login/status` login status (`wait_seconds` optional)
- `POST /auth/import-current` import current auth.json and save label
- `POST /auth/switch` switch active profile via `codex-switch`
- `GET /auth/current` metadata for active auth file and guessed/current label
- `GET /auth/export?label=<label>` return stored auth JSON for a label

Legacy/secondary:
- `GET/POST /oauth/callback`
- `GET/POST /auth/callback`
- `POST /auth/save`
- `POST /auth/exchange`
- `GET /internal/auths`

## Internal Token Protection

When `INTERNAL_API_TOKEN` is set, sensitive endpoints require `Authorization: Bearer <token>`.
This includes endpoints that expose raw auth JSON or mutate active auth state, including:
- `/auth/export`
- `/auth/import-current`
- `/auth/switch`
- `/auth/save`
- `/auth/exchange`
- `/internal/auths`
- `/auth/login/start`

The UI stores the token in `localStorage` key `internalToken` for convenience.

## Environment

Example `.env` values:

```env
CODEX_CLI_BIN=codex
CODEX_SWITCH_BIN=codex-switch
CODEX_AUTH_PATH=~/.codex/auth.json
CALLBACK_STORE_DIR=~/.codex-switch/callbacks
CODEX_PROFILES_DIR=~/.codex-switch/profiles
INTERNAL_API_TOKEN=
RATE_LIMIT_PROBE_URL=https://api.openai.com/v1/models
OPENAI_ORGANIZATION=
OPENAI_PROJECT=
OPENAI_TOKEN_URL=
OPENAI_CLIENT_ID=
OPENAI_CLIENT_SECRET=
OPENAI_REDIRECT_URI=http://localhost:1455/auth/callback
```

## Docker

Build and run:

```bash
docker compose up --build
```

Container defaults:
- `CODEX_AUTH_PATH=/root/.codex/auth.json`
- `CALLBACK_STORE_DIR=/root/.codex-switch/callbacks`
- `CODEX_PROFILES_DIR=/root/.codex-switch/profiles`

Persistent volumes:
- `/root/.codex`
- `/root/.codex-switch/profiles`
- `/root/.codex-switch/callbacks`

Note: Dockerfile assumes Codex CLI and `codex-switch` can be installed via npm (`@openai/codex` and `codex-switch`). Override build arg `CODEX_INSTALL_CMD` if your install command differs.
