FROM python:3.11-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG CODEX_INSTALL_CMD="npm install -g @openai/codex codex-switch"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl nodejs npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Assumes codex CLI and codex-switch are available as npm packages.
RUN sh -c "$CODEX_INSTALL_CMD"

COPY . .

ENV CODEX_CLI_BIN=codex \
    CODEX_SWITCH_BIN=codex-switch \
    CODEX_AUTH_PATH=/root/.codex/auth.json \
    CALLBACK_STORE_DIR=/root/.codex-switch/callbacks \
    CODEX_PROFILES_DIR=/root/.codex-switch/profiles \
    LOGIN_SESSION_TTL_SECONDS=600

EXPOSE 8080

VOLUME ["/root/.codex", "/root/.codex-switch/profiles", "/root/.codex-switch/callbacks"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
