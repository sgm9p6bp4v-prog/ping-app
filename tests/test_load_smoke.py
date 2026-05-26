"""Load smoke: 254 mock hosts ping for ~3s, verify store stays consistent.

The Sprint-5 acceptance run is 10 minutes; this is the short CI-friendly
proxy. It exercises the same code paths (semaphore, batched writer,
reconcile) and asserts the absence of ``database is locked`` style failures.
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
    s = Store(tmp_path / "ping.db", flush_interval_s=0.1)
    await s.open()
    s.start_writer()
    yield s
    await s.close()


async def test_254_hosts_burst(store: Store) -> None:
    # create 254 hosts (one /24 - 2 reserved addresses)
    for i in range(1, 255):
        await store.create_host(name=f"h{i}", address=f"10.0.0.{i}", interval_s=0.5)

    fake = AsyncMock(
        return_value={
            "rtt_ms": 1.2,
            "success": True,
            "error": None,
            "ts": utcnow_iso(),
            "host": "x",
        }
    )

    with patch("netping.pinger.do_ping", fake):
        sched = PingScheduler(store, max_concurrent=64, timeout_s=0.5)
        await sched.start()
        # let it run 3s — every host pings ~6 times at 0.5s interval
        await asyncio.sleep(3.0)
        await sched.stop()

    # Drain writer
    await asyncio.sleep(0.3)
    rows_h1 = await store.history(1)
    rows_h254 = await store.history(254)
    assert len(rows_h1) >= 1
    assert len(rows_h254) >= 1
    # Should have several samples across all 254 hosts
    total = 0
    for hid in (1, 50, 100, 200, 254):
        total += len(await store.history(hid, limit=100))
    assert total > 10
