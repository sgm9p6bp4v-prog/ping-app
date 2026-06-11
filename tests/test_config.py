"""Tests for netping.config Settings env parsing + singleton lifecycle."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from netping.config import Settings, get_settings, reset_settings


@pytest.fixture(autouse=True)
def _isolated_settings() -> Iterator[None]:
    """Drop the cached singleton before AND after each test so no other test
    (or this module's env tweaks) leaks a stale Settings instance."""
    reset_settings()
    yield
    reset_settings()


def test_defaults() -> None:
    s = Settings()
    assert s.port == 8000
    assert s.bind_host == "0.0.0.0"
    assert s.cors_origins == []
    assert s.db_path == Path("data/ping.db")


def test_ping_port_env_parsed_as_int(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PING_PORT", "9123")
    s = get_settings()
    assert s.port == 9123
    assert isinstance(s.port, int)


def test_ping_port_invalid_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PING_PORT", "not-a-port")
    with pytest.raises(Exception):  # pydantic ValidationError  # noqa: B017
        get_settings()


def test_ping_db_path_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    target = tmp_path / "custom" / "ping.db"
    monkeypatch.setenv("PING_DB_PATH", str(target))
    s = get_settings()
    assert s.db_path == target
    assert isinstance(s.db_path, Path)


def test_cors_origins_json_list(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "PING_CORS_ORIGINS", '["http://other-lan-host", "http://192.168.1.5:8000"]'
    )
    s = get_settings()
    assert s.cors_origins == ["http://other-lan-host", "http://192.168.1.5:8000"]


def test_cors_origins_default_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PING_CORS_ORIGINS", raising=False)
    assert get_settings().cors_origins == []


def test_get_settings_returns_cached_singleton() -> None:
    first = get_settings()
    second = get_settings()
    assert first is second


def test_singleton_ignores_env_change_until_reset(monkeypatch: pytest.MonkeyPatch) -> None:
    cached = get_settings()
    assert cached.port == 8000
    monkeypatch.setenv("PING_PORT", "9999")
    # Still the cached instance — env changes only apply after reset.
    assert get_settings() is cached
    assert get_settings().port == 8000
    reset_settings()
    assert get_settings().port == 9999


def test_reset_settings_creates_fresh_instance() -> None:
    first = get_settings()
    reset_settings()
    second = get_settings()
    assert first is not second


def test_unknown_ping_env_vars_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    # model_config has extra="ignore" — unknown PING_* keys must not blow up.
    monkeypatch.setenv("PING_TOTALLY_UNKNOWN_OPTION", "whatever")
    s = get_settings()
    assert s.port == 8000
