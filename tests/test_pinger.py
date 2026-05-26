"""Pinger smoke + scheduler-reconcile tests.

Real ICMP is OS-dependent and may be blocked in CI / non-priv environments;
these tests use a mock subprocess and verify scheduler bookkeeping.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from netping.pinger import PingScheduler, build_ping_command, do_ping
from netping.store import Store


@pytest.fixture
async def store(tmp_path: Path) -> AsyncIterator[Store]:
    s = Store(tmp_path / "ping.db", flush_interval_s=0.05)
    await s.open()
    s.start_writer()
    yield s
    await s.close()


def test_build_ping_command_unix_shape() -> None:
    cmd = build_ping_command("8.8.8.8", count=1, timeout_s=2.0)
    assert cmd[0] == "ping"
    assert "8.8.8.8" in cmd
    assert "-c" in cmd


async def test_do_ping_returns_dict_on_failure() -> None:
    # invalid command path -> FileNotFoundError handled
    with patch("netping.pinger.build_ping_command", return_value=["/nonexistent/ping", "x"]):
        r = await do_ping("x", timeout_s=0.5)
    assert r["success"] is False
    assert r["host"] == "x"
    assert "ts" in r


async def test_scheduler_reconcile_spawns_and_cancels(store: Store) -> None:
    h1 = await store.create_host(name="a", address="1.1.1.1")
    h2 = await store.create_host(name="b", address="1.1.1.2")
    h3 = await store.create_host(name="c", address="1.1.1.3", enabled=False)

    fake_do_ping = AsyncMock(
        return_value={
            "rtt_ms": 1.0,
            "success": True,
            "error": None,
            "ts": "1970-01-01T00:00:00.000Z",
            "host": "x",
        }
    )

    with patch("netping.pinger.do_ping", fake_do_ping):
        sched = PingScheduler(store, max_concurrent=8, timeout_s=0.5)
        await sched.start()
        # h3 is disabled -> not spawned
        assert h1.id in sched._tasks
        assert h2.id in sched._tasks
        assert h3.id not in sched._tasks

        # disable h1, enable h3, reconcile
        await store.update_host(h1.id, enabled=False)
        await store.update_host(h3.id, enabled=True)
        hosts = await store.list_hosts()
        sched.reconcile(hosts)
        await asyncio.sleep(0.05)
        assert h1.id not in sched._tasks
        assert h3.id in sched._tasks

        await sched.stop()
        assert sched._tasks == {}
