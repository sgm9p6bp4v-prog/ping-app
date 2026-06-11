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


def test_build_ping_command_linux_binds_interface(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("netping.pinger.platform.system", lambda: "Linux")
    cmd = build_ping_command("8.8.8.8", count=1, timeout_s=2.0, interface="eth0")
    assert cmd == ["ping", "-c", "1", "-W", "2", "-I", "eth0", "8.8.8.8"]


def test_build_ping_command_darwin_binds_source_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("netping.pinger.platform.system", lambda: "Darwin")
    cmd = build_ping_command(
        "8.8.8.8",
        count=2,
        timeout_s=3.0,
        interface="en0",
        source_address="192.168.1.20",
    )
    assert cmd == ["ping", "-c", "2", "-t", "3", "-S", "192.168.1.20", "8.8.8.8"]


def test_build_ping_command_windows_ipv4_uses_route_table(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("netping.pinger.platform.system", lambda: "Windows")
    cmd = build_ping_command(
        "8.8.8.8",
        count=3,
        timeout_s=2.0,
        interface="Ethernet",
        source_address="192.168.1.20",
    )
    assert cmd == ["ping", "-n", "3", "-w", "2000", "8.8.8.8"]


def test_build_ping_command_windows_ipv6_can_bind_source_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("netping.pinger.platform.system", lambda: "Windows")
    cmd = build_ping_command(
        "2001:4860:4860::8888",
        count=1,
        timeout_s=1.5,
        source_address="fe80::1",
    )
    assert cmd == [
        "ping",
        "-n",
        "1",
        "-w",
        "1500",
        "-S",
        "fe80::1",
        "2001:4860:4860::8888",
    ]


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


async def test_scheduler_reconcile_restarts_task_on_address_change(store: Store) -> None:
    """Grumpy audit Sprint 2 HIGH: reconcile must restart loops if
    address/interval changed."""
    h = await store.create_host(name="a", address="1.1.1.1", interval_s=1.0)

    fake = AsyncMock(
        return_value={
            "rtt_ms": 1.0,
            "success": True,
            "error": None,
            "ts": "1970-01-01T00:00:00.000Z",
            "host": "x",
        }
    )

    with patch("netping.pinger.do_ping", fake):
        sched = PingScheduler(store, max_concurrent=4, timeout_s=0.5)
        await sched.start()
        task_before = sched._tasks[h.id]

        # change address — reconcile should cancel + respawn
        await store.update_host(h.id, address="2.2.2.2")
        sched.reconcile(await store.list_hosts())
        await asyncio.sleep(0.05)
        assert sched._tasks[h.id] is not task_before
        assert sched._signatures[h.id] == ("2.2.2.2", 1.0, None, None)

        # change interval — reconcile should cancel + respawn
        task_mid = sched._tasks[h.id]
        await store.update_host(h.id, interval_s=2.0)
        sched.reconcile(await store.list_hosts())
        await asyncio.sleep(0.05)
        assert sched._tasks[h.id] is not task_mid
        assert sched._signatures[h.id] == ("2.2.2.2", 2.0, None, None)

        # no change — reconcile should NOT respawn
        task_after = sched._tasks[h.id]
        sched.reconcile(await store.list_hosts())
        await asyncio.sleep(0.05)
        assert sched._tasks[h.id] is task_after

        await sched.stop()


async def test_start_skips_hosts_already_spawned_by_concurrent_reconcile(store: Store) -> None:
    """Audit fix: start() sets _started=True then awaits store calls; an API
    _reconcile (guarded by a different lock) can spawn host loops in that
    window. start() must not overwrite (and thereby orphan) those tasks."""
    h = await store.create_host(name="a", address="1.1.1.1")
    fake = AsyncMock(
        return_value={
            "rtt_ms": 1.0,
            "success": True,
            "error": None,
            "ts": "1970-01-01T00:00:00.000Z",
            "host": "x",
        }
    )

    with patch("netping.pinger.do_ping", fake):
        sched = PingScheduler(store, max_concurrent=4, timeout_s=0.5)
        # Simulate the race window: _started already flipped, reconcile ran.
        sched._started = True
        sched.reconcile(await store.list_hosts())
        existing = sched._tasks[h.id]

        await sched.start()
        assert sched._tasks[h.id] is existing, "start() must not respawn a running loop"
        await sched.stop()


async def test_spawn_cancels_preexisting_task_for_same_host(store: Store) -> None:
    """Defensive layer of the same audit fix: _spawn must cancel a live
    pre-existing task instead of orphaning it (duplicate ping loops)."""
    h = await store.create_host(name="a", address="1.1.1.1")
    fake = AsyncMock(
        return_value={
            "rtt_ms": 1.0,
            "success": True,
            "error": None,
            "ts": "1970-01-01T00:00:00.000Z",
            "host": "x",
        }
    )

    with patch("netping.pinger.do_ping", fake):
        sched = PingScheduler(store, max_concurrent=4, timeout_s=0.5)
        sched._spawn(h)
        first = sched._tasks[h.id]
        sched._spawn(h)
        second = sched._tasks[h.id]
        assert second is not first
        await asyncio.sleep(0.05)
        assert first.cancelled() or first.done(), "orphaned loop must be cancelled"
        await sched.stop()


async def test_scheduler_reconcile_restarts_task_on_interface_change(store: Store) -> None:
    h = await store.create_host(name="a", address="1.1.1.1", interval_s=1.0)
    fake = AsyncMock(
        return_value={
            "rtt_ms": 1.0,
            "success": True,
            "error": None,
            "ts": "1970-01-01T00:00:00.000Z",
            "host": "x",
        }
    )

    with patch("netping.pinger.do_ping", fake):
        sched = PingScheduler(store, max_concurrent=4, timeout_s=0.5)
        await sched.start()
        task_before = sched._tasks[h.id]

        sched.set_ping_interface("eth0", source_address="192.168.1.20")
        sched.reconcile(await store.list_hosts())
        await asyncio.sleep(0.05)

        assert sched._tasks[h.id] is not task_before
        assert sched._signatures[h.id] == ("1.1.1.1", 1.0, "eth0", "192.168.1.20")
        await sched.stop()
