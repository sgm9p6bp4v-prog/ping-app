"""Writer-flush failure paths + chunked retention purge (audit regression tests).

Covers:
- FK violation (host deleted while its rows were buffered) must not poison the
  whole batch: only the violating rows are dropped, everything else persists.
- Transient (non-FK) failures keep the existing re-queue behaviour.
- ``purge()`` deletes in chunks so the write lock is released in between.
"""

from __future__ import annotations

import sqlite3
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from netping.store import Event, Sample, Store, utcnow_iso


@pytest.fixture
async def store(tmp_path: Path) -> AsyncIterator[Store]:
    s = Store(tmp_path / "ping.db", flush_interval_s=0.05)
    await s.open()
    yield s
    await s.close()


def _sample(host_id: int, *, ts: str | None = None, rtt_ms: float = 1.0) -> Sample:
    return Sample(host_id=host_id, ts=ts or utcnow_iso(), rtt_ms=rtt_ms, success=True, error=None)


async def test_fk_violation_drops_only_bad_rows(store: Store) -> None:
    """A non-existent host_id in the batch (deleted mid-buffer) must not drop
    the other hosts' samples — only the violating rows."""
    h = await store.create_host(name="a", address="1.1.1.1")
    for i in range(5):
        await store.enqueue_sample(_sample(h.id, rtt_ms=float(i)))
    # rows for a host that no longer exists (deleted while buffered)
    for _ in range(3):
        await store.enqueue_sample(_sample(9999))
    await store.enqueue_event(
        Event(host_id=h.id, ts=utcnow_iso(), type="outage_start", message=None)
    )
    await store.enqueue_event(
        Event(host_id=9999, ts=utcnow_iso(), type="outage_start", message=None)
    )

    await store._flush_now()

    rows = await store.history(h.id)
    assert len(rows) == 5, "valid samples must persist despite FK-violating rows"
    evs = await store.events()
    assert len(evs) == 1
    assert evs[0]["host_id"] == h.id
    # Nothing was re-queued and the failure counter did not advance — the
    # writer is not on the path towards the batch-drop escape hatch.
    assert store._sample_buf == []
    assert store._event_buf == []
    assert store._flush_failures == 0


async def test_transient_failure_still_requeues_batch(
    store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Non-FK errors (e.g. database locked) keep the re-queue-then-drop path."""
    h = await store.create_host(name="a", address="1.1.1.1")
    await store.enqueue_sample(_sample(h.id))

    async def boom(db, samples) -> None:
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(Store, "_insert_samples", staticmethod(boom))
    await store._flush_now()
    assert store._flush_failures == 1
    assert len(store._sample_buf) == 1, "transient failure must re-queue the batch"


async def test_purge_chunks_large_deletes(
    store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Purge must delete in chunks (rowid-subquery form) and still report the
    full deleted-row count."""
    monkeypatch.setattr("netping.store.PURGE_CHUNK_ROWS", 3)
    h = await store.create_host(name="a", address="1.1.1.1")
    old = (datetime.now(UTC) - timedelta(days=14)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    for i in range(10):
        await store.enqueue_sample(_sample(h.id, ts=old, rtt_ms=float(i)))
    await store.enqueue_sample(_sample(h.id))  # fresh — must survive
    await store._flush_now()

    s_del, e_del = await store.purge(sample_days=7, event_days=7)
    assert s_del == 10
    assert e_del == 0
    assert len(await store.history(h.id)) == 1
