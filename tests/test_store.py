"""SQLite store tests: schema, CRUD, batched writes, history, retention."""

from __future__ import annotations

import asyncio
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


@pytest.mark.asyncio
async def test_open_creates_schema(store: Store) -> None:
    # Re-opening is a no-op due to IF NOT EXISTS
    await store.open()
    hosts = await store.list_hosts()
    assert hosts == []


@pytest.mark.asyncio
async def test_host_crud(store: Store) -> None:
    h = await store.create_host(name="dns", address="8.8.8.8", group_name="external")
    assert h.id > 0
    assert h.address == "8.8.8.8"
    assert h.group_name == "external"
    assert h.enabled is True

    fetched = await store.get_host(h.id)
    assert fetched is not None
    assert fetched.name == "dns"

    updated = await store.update_host(h.id, name="dns-google", enabled=False)
    assert updated is not None
    assert updated.name == "dns-google"
    assert updated.enabled is False

    listed = await store.list_hosts()
    assert len(listed) == 1

    ok = await store.delete_host(h.id)
    assert ok is True
    assert await store.get_host(h.id) is None

    ok = await store.delete_host(h.id)
    assert ok is False


@pytest.mark.asyncio
async def test_app_settings_roundtrip(store: Store) -> None:
    assert await store.get_setting("ping_interface", "auto") == "auto"
    await store.set_setting("ping_interface", "en0")
    assert await store.get_setting("ping_interface") == "en0"
    await store.set_setting("ping_interface", "auto")
    assert await store.get_setting("ping_interface") == "auto"


@pytest.mark.asyncio
async def test_history_writes_batched(store: Store) -> None:
    h = await store.create_host(name="x", address="1.1.1.1")
    store.start_writer()
    # enqueue 1000 samples — writer should batch + persist them
    for i in range(1000):
        await store.enqueue_sample(
            Sample(host_id=h.id, ts=utcnow_iso(), rtt_ms=float(i), success=True, error=None)
        )
    # wait for at least two flush intervals
    await asyncio.sleep(0.2)
    rows = await store.history(h.id, limit=2000)
    assert len(rows) == 1000


@pytest.mark.asyncio
async def test_history_filters_by_time(store: Store) -> None:
    h = await store.create_host(name="x", address="1.1.1.1")
    store.start_writer()
    base = datetime.now(UTC) - timedelta(hours=2)
    for i in range(10):
        ts = (base + timedelta(minutes=i)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        await store.enqueue_sample(
            Sample(host_id=h.id, ts=ts, rtt_ms=float(i), success=True, error=None)
        )
    await asyncio.sleep(0.2)
    rows = await store.history(h.id, since=base + timedelta(minutes=5))
    assert len(rows) == 5


@pytest.mark.asyncio
async def test_history_naive_since_treated_as_utc(store: Store) -> None:
    """Audit fix: naive since/until must be interpreted as UTC (stored ts are
    UTC) — plain .astimezone(UTC) would read them as server-local time."""
    h = await store.create_host(name="x", address="1.1.1.1")
    base = datetime.now(UTC).replace(microsecond=0) - timedelta(hours=2)
    for i in range(10):
        ts = (base + timedelta(minutes=i)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        await store.enqueue_sample(
            Sample(host_id=h.id, ts=ts, rtt_ms=float(i), success=True, error=None)
        )
    await store._flush_now()
    naive_since = (base + timedelta(minutes=5)).replace(tzinfo=None)
    rows = await store.history(h.id, since=naive_since)
    assert len(rows) == 5
    naive_until = (base + timedelta(minutes=2)).replace(tzinfo=None)
    rows = await store.history(h.id, until=naive_until)
    assert len(rows) == 3


@pytest.mark.asyncio
async def test_events_filtered_by_host(store: Store) -> None:
    a = await store.create_host(name="a", address="10.0.0.1")
    b = await store.create_host(name="b", address="10.0.0.2")
    store.start_writer()
    await store.enqueue_event(
        Event(host_id=a.id, ts=utcnow_iso(), type="outage_start", message=None)
    )
    await store.enqueue_event(
        Event(host_id=b.id, ts=utcnow_iso(), type="outage_start", message=None)
    )
    await asyncio.sleep(0.2)
    evs_a = await store.events(host_id=a.id)
    evs_b = await store.events(host_id=b.id)
    all_evs = await store.events()
    assert len(evs_a) == 1
    assert len(evs_b) == 1
    assert len(all_evs) == 2


@pytest.mark.asyncio
async def test_retention_purge(store: Store) -> None:
    h = await store.create_host(name="x", address="1.1.1.1")
    store.start_writer()
    old = (datetime.now(UTC) - timedelta(days=14)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    fresh = utcnow_iso()
    await store.enqueue_sample(Sample(host_id=h.id, ts=old, rtt_ms=1.0, success=True, error=None))
    await store.enqueue_sample(Sample(host_id=h.id, ts=fresh, rtt_ms=2.0, success=True, error=None))
    await store.enqueue_event(Event(host_id=h.id, ts=old, type="x", message=None))
    await store.enqueue_event(Event(host_id=h.id, ts=fresh, type="y", message=None))
    await asyncio.sleep(0.2)

    s_del, e_del = await store.purge(sample_days=7, event_days=7)
    assert s_del == 1
    assert e_del == 1
    rows = await store.history(h.id)
    assert len(rows) == 1
    evs = await store.events()
    assert len(evs) == 1


@pytest.mark.asyncio
async def test_cascade_delete_drops_samples(store: Store) -> None:
    h = await store.create_host(name="x", address="1.1.1.1")
    store.start_writer()
    for _ in range(5):
        await store.enqueue_sample(
            Sample(host_id=h.id, ts=utcnow_iso(), rtt_ms=1.0, success=True, error=None)
        )
    await asyncio.sleep(0.2)
    assert len(await store.history(h.id)) == 5
    await store.delete_host(h.id)
    assert await store.get_host(h.id) is None
    # samples for that host_id remain orphaned only if FK cascade isn't honoured;
    # we set PRAGMA foreign_keys=ON, so cascade should fire.
    rows = await store.history(h.id)
    assert rows == []
