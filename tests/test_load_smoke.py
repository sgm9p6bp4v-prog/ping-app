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

# History (post-flush) for these representative hosts is sampled across the /24.
SAMPLED_HOST_IDS = (1, 50, 100, 200, 254)
# Each host pings at 0.5s interval; require a meaningful minimum per sampled
# host while staying robust on slow CI (the poll deadline is generous).
MIN_SAMPLES_PER_HOST = 2


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

    async def _sampled_counts() -> dict[int, int]:
        return {
            hid: len(await store.history(hid, limit=100)) for hid in SAMPLED_HOST_IDS
        }

    with patch("netping.pinger.do_ping", fake):
        sched = PingScheduler(store, max_concurrent=64, timeout_s=0.5)
        await sched.start()
        try:
            # Poll (instead of a fixed sleep) until every sampled host has
            # flushed enough samples; generous deadline for loaded CI.
            loop = asyncio.get_running_loop()
            deadline = loop.time() + 30.0
            while True:
                counts = await _sampled_counts()
                if all(c >= MIN_SAMPLES_PER_HOST for c in counts.values()):
                    break
                if loop.time() >= deadline:
                    raise AssertionError(
                        f"sampled hosts never reached {MIN_SAMPLES_PER_HOST} "
                        f"flushed samples each within 30s: {counts}"
                    )
                await asyncio.sleep(0.1)
        finally:
            await sched.stop()

    counts = await _sampled_counts()
    # Every sampled host across the /24 produced samples — no host starved by
    # the semaphore and no `database is locked` style writer failures.
    assert all(c >= MIN_SAMPLES_PER_HOST for c in counts.values()), counts
    assert sum(counts.values()) >= MIN_SAMPLES_PER_HOST * len(SAMPLED_HOST_IDS)
