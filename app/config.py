from __future__ import annotations

from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


def _expand(path: str) -> Path:
    return Path(path).expanduser().resolve()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    codex_switch_bin: str = "codex-switch"
    codex_auth_path: str = "~/.codex/auth.json"
    callback_store_dir: str = "~/.codex-switch/callbacks"
    openai_token_url: str | None = None
    openai_client_id: str | None = None
    openai_client_secret: str | None = None
    openai_redirect_uri: str | None = None

    def codex_auth_file(self) -> Path:
        return _expand(self.codex_auth_path)

    def callback_dir(self) -> Path:
        return _expand(self.callback_store_dir)


settings = Settings()
