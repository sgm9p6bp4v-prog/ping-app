"""Outage state must survive host-loop restarts (audit regression tests).

``fail_streak``/``in_outage`` used to be locals of each ``_host_loop`` task, so
any task restart (interface/interval change, monitoring stop/start) reset them
and produced unpaired/duplicate outage_start/outage_end events. The state now
lives on the scheduler, keyed by host id.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from netping.pinger import PingScheduler
from netping.store import Store, utcnow_iso


@pytest.fixture
async def store(tmp_path: Path) -> AsyncIterator[Store]:
    s = Store(tmp_path / "ping.db", flush_interval_s=0.02)
    await s.open()
    s.start_writer()
    yield s
    await s.close()


def _mk_result(success: bool) -> dict:
    return {
        "success": success,
        "rtt_ms": 1.0 if success else None,
        "error": None if success else "timeout",
        "ts": utcnow_iso(),
        "host": "x",
    }


async def test_no_duplicate_outage_start_after_loop_restart(store: Store) -> None:
    h = await store.create_host(name="a", address="1.1.1.1", interval_s=0.02)
    fake = AsyncMock(side_effect=lambda *_a, **_kw: _mk_result(False))

    with patch("netping.pinger.do_ping", fake):
        sched = PingScheduler(store, max_concurrent=2, timeout_s=0.1)
        await sched.start()
        await asyncio.sleep(0.4)  # well past 3 fails → outage_start emitted

        # Restart the host loop via a signature change (interface switch),
        # exactly what the API reconcile does — failures continue.
        sched.set_ping_interface("eth0", source_address="192.168.1.20")
        sched.reconcile(await store.list_hosts())
        await asyncio.sleep(0.4)
        await sched.stop()

    await asyncio.sleep(0.1)
    events = await store.events(h.id)
    types = [e["type"] for e in events]
    assert types.count("outage_start") == 1, f"duplicate outage_start: {types}"
    assert "outage_end" not in types


async def test_outage_end_emitted_after_recovery_across_restart(store: Store) -> None:
    h = await store.create_host(name="b", address="1.1.1.2", interval_s=0.02)
    mode = {"success": False}
    fake = AsyncMock(side_effect=lambda *_a, **_kw: _mk_result(mode["success"]))

    with patch("netping.pinger.do_ping", fake):
        sched = PingScheduler(store, max_concurrent=2, timeout_s=0.1)
        await sched.start()
        await asyncio.sleep(0.4)  # outage_start emitted

        # Restart the loop, then recover — the restarted loop must still know
        # it is in an outage and emit a paired outage_end.
        sched.set_ping_interface("eth0", source_address="192.168.1.20")
        sched.reconcile(await store.list_hosts())
        mode["success"] = True
        await asyncio.sleep(0.4)
        await sched.stop()

    await asyncio.sleep(0.1)
    events = await store.events(h.id)
    types = [e["type"] for e in events]
    assert types.count("outage_start") == 1
    assert types.count("outage_end") == 1


async def test_outage_state_cleared_when_host_removed(store: Store) -> None:
    h = await store.create_host(name="c", address="1.1.1.3", interval_s=0.02)
    fake = AsyncMock(side_effect=lambda *_a, **_kw: _mk_result(False))

    with patch("netping.pinger.do_ping", fake):
        sched = PingScheduler(store, max_concurrent=2, timeout_s=0.1)
        await sched.start()
        await asyncio.sleep(0.2)
        assert h.id in sched._outage_state

        # Disabling keeps the state (host still exists) ...
        await store.update_host(h.id, enabled=False)
        sched.reconcile(await store.list_hosts())
        assert h.id in sched._outage_state

        # ... deleting the host entirely drops it.
        await store.delete_host(h.id)
        sched.reconcile(await store.list_hosts())
        assert h.id not in sched._outage_state
        await sched.stop()
