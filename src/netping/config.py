"""Runtime settings, loaded from environment with ``PING_`` prefix.

Examples::

    PING_PORT=8000 PING_DB_PATH=/var/lib/ping-app/ping.db netping ...
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PING_", env_file=".env", extra="ignore")

    # Network
    bind_host: str = "0.0.0.0"
    port: int = 8000
    # Default = no cross-origin requests (LAN-trust UI lives on the same origin).
    # Operator sets PING_CORS_ORIGINS='["http://other-lan-host"]' to allow more.
    cors_origins: list[str] = Field(default_factory=list)

    # Storage
    db_path: Path = Path("data/ping.db")
    sample_retention_days: int = 7
    event_retention_days: int = 30

    # Pinger
    max_concurrent_pings: int = 64
    default_interval_s: float = 1.0
    ping_timeout_s: float = 2.0
    slow_threshold_ms: float = 100.0

    # Writer
    write_flush_interval_s: float = 0.5
    write_flush_max_batch: int = 1000

    # Frontend defaults
    language_default: str = "en"


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


def reset_settings() -> None:
    """Test helper: drop cached singleton so env changes are picked up."""
    global _settings
    _settings = None
