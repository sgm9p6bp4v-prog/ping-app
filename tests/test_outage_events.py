"""Outage event emission: 3 fails → outage_start, 1 success → outage_end."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from itertools import cycle
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


def _mk_result(success: bool, rtt_ms: float | None = None) -> dict:
    return {
        "success": success,
        "rtt_ms": rtt_ms,
        "error": None if success else "timeout",
        "ts": utcnow_iso(),
        "host": "x",
    }


async def test_outage_start_emitted_after_three_fails(store: Store) -> None:
    h = await store.create_host(name="a", address="1.1.1.1", interval_s=0.05)
    # Pattern: success, fail, fail, fail, fail, fail (no recovery)
    seq = [
        _mk_result(True, 1.0),
        _mk_result(False),
        _mk_result(False),
        _mk_result(False),
        _mk_result(False),
        _mk_result(False),
    ]
    it = iter(seq)
    fake = AsyncMock(side_effect=lambda *_a, **_kw: next(it, _mk_result(False)))

    with patch("netping.pinger.do_ping", fake):
        sched = PingScheduler(store, max_concurrent=2, timeout_s=0.1)
        await sched.start()
        # Wait long enough for ~6 ping cycles + 2 flush intervals.
        await asyncio.sleep(0.6)
        await sched.stop()

    await asyncio.sleep(0.1)
    events = await store.events(h.id)
    types = [e["type"] for e in events]
    assert "outage_start" in types
    assert "outage_end" not in types


async def test_outage_end_emitted_after_recovery(store: Store) -> None:
    h = await store.create_host(name="b", address="1.1.1.2", interval_s=0.05)
    # 3 fails (outage_start), then successes (outage_end)
    seq = cycle([
        _mk_result(False),
        _mk_result(False),
        _mk_result(False),
        _mk_result(True, 1.0),
        _mk_result(True, 1.0),
        _mk_result(True, 1.0),
    ])
    fake = AsyncMock(side_effect=lambda *_a, **_kw: next(seq))

    with patch("netping.pinger.do_ping", fake):
        sched = PingScheduler(store, max_concurrent=2, timeout_s=0.1)
        await sched.start()
        await asyncio.sleep(0.6)
        await sched.stop()

    await asyncio.sleep(0.1)
    events = await store.events(h.id)
    types = [e["type"] for e in events]
    assert "outage_start" in types
    assert "outage_end" in types
    # outage_end must come after outage_start in the original event sequence
    # (events DESC by ts, so end is earlier in the returned list).
    end_idx = types.index("outage_end")
    start_idx = types.index("outage_start")
    assert end_idx < start_idx


async def test_no_outage_event_for_single_blip(store: Store) -> None:
    h = await store.create_host(name="c", address="1.1.1.3", interval_s=0.05)
    seq = cycle([
        _mk_result(True, 1.0),
        _mk_result(True, 1.0),
        _mk_result(False),  # single blip
        _mk_result(True, 1.0),
        _mk_result(True, 1.0),
    ])
    fake = AsyncMock(side_effect=lambda *_a, **_kw: next(seq))

    with patch("netping.pinger.do_ping", fake):
        sched = PingScheduler(store, max_concurrent=2, timeout_s=0.1)
        await sched.start()
        await asyncio.sleep(0.5)
        await sched.stop()

    await asyncio.sleep(0.1)
    events = await store.events(h.id)
    assert events == [], f"single-blip should not emit outage events, got {events}"
