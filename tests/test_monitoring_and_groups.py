"""Tests for the monitoring lifecycle + per-group enable/collapse."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from netping.api import router
from netping.app import CSRFGuardMiddleware
from netping.monitoring import MonitoringController
from netping.pinger import PingScheduler
from netping.store import Store
from netping.ws import WebSocketHub


async def _poll_until(
    condition: Callable[[], Awaitable[bool]],
    *,
    timeout: float = 10.0,
    interval: float = 0.05,
) -> None:
    """Poll an async condition until true; fail loudly on deadline. Replaces
    fixed asyncio.sleep() synchronization (flaky on loaded CI)."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        if await condition():
            return
        if loop.time() >= deadline:
            raise AssertionError(f"condition not met within {timeout}s")
        await asyncio.sleep(interval)


@pytest.fixture
async def app(tmp_path: Path) -> AsyncIterator[FastAPI]:
    a = FastAPI()
    a.add_middleware(CSRFGuardMiddleware)
    store = Store(tmp_path / "ping.db", flush_interval_s=0.05)
    await store.open()
    store.start_writer()
    hub = WebSocketHub()
    sched = PingScheduler(store, max_concurrent=4, timeout_s=0.5)
    a.state.store = store
    a.state.hub = hub
    a.state.scheduler = sched
    a.state.monitoring = MonitoringController(sched, hub, duration_s=2)
    a.state.reconcile_lock = asyncio.Lock()
    a.include_router(router)
    yield a
    await a.state.monitoring.shutdown()
    await store.close()


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"X-Requested-With": "fetch"},
    ) as c:
        yield c


@asynccontextmanager
async def _client_with_duration(
    tmp_path: Path, duration_s: float
) -> AsyncIterator[AsyncClient]:
    """App + client wired like the fixtures but with a custom (short)
    monitoring duration, so timer tests don't burn wall-clock seconds."""
    a = FastAPI()
    a.add_middleware(CSRFGuardMiddleware)
    store = Store(tmp_path / "ping.db", flush_interval_s=0.05)
    await store.open()
    store.start_writer()
    hub = WebSocketHub()
    sched = PingScheduler(store, max_concurrent=4, timeout_s=0.5)
    a.state.store = store
    a.state.hub = hub
    a.state.scheduler = sched
    a.state.monitoring = MonitoringController(sched, hub, duration_s=duration_s)
    a.state.reconcile_lock = asyncio.Lock()
    a.include_router(router)
    try:
        transport = ASGITransport(app=a)
        async with AsyncClient(
            transport=transport,
            base_url="http://test",
            headers={"X-Requested-With": "fetch"},
        ) as c:
            yield c
    finally:
        await a.state.monitoring.shutdown()
        await store.close()


# --- monitoring -------------------------------------------------------------


async def test_monitoring_starts_paused(client: AsyncClient) -> None:
    r = await client.get("/api/monitoring")
    body = r.json()
    assert body["active"] is False
    assert body["expires_at"] is None


async def test_monitoring_start_sets_expiry(client: AsyncClient) -> None:
    r = await client.post("/api/monitoring/start")
    body = r.json()
    assert body["active"] is True
    assert body["expires_at"] is not None
    assert body["duration_s"] == 2


async def test_monitoring_stop_clears_expiry(client: AsyncClient) -> None:
    await client.post("/api/monitoring/start")
    r = await client.post("/api/monitoring/stop")
    body = r.json()
    assert body["active"] is False
    assert body["expires_at"] is None


async def test_monitoring_auto_stops_after_duration(tmp_path: Path) -> None:
    """Timer wired into MonitoringController auto-stops the scheduler."""
    async with _client_with_duration(tmp_path, duration_s=0.4) as client:
        await client.post("/api/monitoring/start")
        assert (await client.get("/api/monitoring")).json()["active"] is True

        async def _stopped() -> bool:
            return (await client.get("/api/monitoring")).json()["active"] is False

        await _poll_until(_stopped, timeout=10.0)


async def test_monitoring_packet_limit_stops_after_each_active_host(
    client: AsyncClient,
) -> None:
    await client.post(
        "/api/hosts",
        json={"name": "a", "address": "1.1.1.1", "interval_s": 0.2},
    )
    await client.post(
        "/api/hosts",
        json={"name": "b", "address": "1.1.1.2", "interval_s": 0.2},
    )
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
        r = await client.post("/api/monitoring/start", json={"packet_limit": 2})
        body = r.json()
        assert body["active"] is True
        assert body["limit_mode"] == "packets"
        assert body["packet_limit"] == 2

        async def _stopped() -> bool:
            return (await client.get("/api/monitoring")).json()["active"] is False

        await _poll_until(_stopped, timeout=10.0)

    assert (await client.get("/api/monitoring")).json()["active"] is False
    assert fake.await_count >= 4


async def test_monitoring_infinite_packet_limit_skips_duration_timer(
    tmp_path: Path,
) -> None:
    async with _client_with_duration(tmp_path, duration_s=0.3) as client:
        r = await client.post("/api/monitoring/start", json={"packet_limit": None})
        body = r.json()
        assert body["active"] is True
        assert body["limit_mode"] == "infinite"
        assert body["expires_at"] is None
        # Negative test: wait clearly past the 0.3s duration window — the
        # duration timer must NOT fire in infinite mode.
        await asyncio.sleep(0.9)
        assert (await client.get("/api/monitoring")).json()["active"] is True
        await client.post("/api/monitoring/stop")


async def test_monitoring_rejects_packet_limit_above_cap(client: AsyncClient) -> None:
    r = await client.post("/api/monitoring/start", json={"packet_limit": 1001})
    assert r.status_code == 422
    assert (await client.get("/api/monitoring")).json()["active"] is False


async def test_monitoring_start_while_active_is_noop(client: AsyncClient) -> None:
    first = (await client.post("/api/monitoring/start", json={"packet_limit": 3})).json()
    second = (await client.post("/api/monitoring/start", json={"packet_limit": 1})).json()

    assert second["active"] is True
    assert second["limit_mode"] == first["limit_mode"] == "packets"
    assert second["packet_limit"] == first["packet_limit"] == 3
    assert second["packet_counts"] == first["packet_counts"]


# --- groups -----------------------------------------------------------------


async def test_groups_auto_created_with_host(client: AsyncClient) -> None:
    await client.post(
        "/api/hosts", json={"name": "x", "address": "1.1.1.1", "group_name": "external"}
    )
    r = await client.get("/api/groups")
    names = [g["name"] for g in r.json()]
    assert "external" in names


async def test_group_default_enabled_not_collapsed(client: AsyncClient) -> None:
    await client.post(
        "/api/hosts", json={"name": "x", "address": "1.1.1.1", "group_name": "internal"}
    )
    r = await client.get("/api/groups")
    g = next(g for g in r.json() if g["name"] == "internal")
    assert g["enabled"] is True
    assert g["collapsed"] is False


async def test_group_patch_disable(client: AsyncClient) -> None:
    await client.post(
        "/api/hosts", json={"name": "x", "address": "1.1.1.1", "group_name": "external"}
    )
    r = await client.patch("/api/groups/external", json={"enabled": False})
    assert r.status_code == 200
    assert r.json()["enabled"] is False


async def test_group_patch_collapse(client: AsyncClient) -> None:
    await client.post(
        "/api/hosts", json={"name": "x", "address": "1.1.1.1", "group_name": "external"}
    )
    r = await client.patch("/api/groups/external", json={"collapsed": True})
    assert r.status_code == 200
    assert r.json()["collapsed"] is True


async def test_group_rename_moves_hosts(client: AsyncClient) -> None:
    await client.post(
        "/api/hosts", json={"name": "x", "address": "1.1.1.1", "group_name": "external"}
    )
    r = await client.patch("/api/groups/external", json={"name": "lan"})
    assert r.status_code == 200
    assert r.json()["name"] == "lan"

    hosts = (await client.get("/api/hosts")).json()
    assert hosts[0]["group_name"] == "lan"
    groups = (await client.get("/api/groups")).json()
    assert "lan" in {g["name"] for g in groups}
    assert "external" not in {g["name"] for g in groups}


async def test_patch_group_rename_and_disable_together(client: AsyncClient) -> None:
    await client.post(
        "/api/hosts", json={"name": "x", "address": "1.1.1.1", "group_name": "external"}
    )
    r = await client.patch("/api/groups/external", json={"name": "lan", "enabled": False})

    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "lan"
    assert body["enabled"] is False
    groups = (await client.get("/api/groups")).json()
    assert next(g for g in groups if g["name"] == "lan")["enabled"] is False


async def test_patch_group_whitespace_name_422(client: AsyncClient) -> None:
    await client.post(
        "/api/hosts", json={"name": "x", "address": "1.1.1.1", "group_name": "external"}
    )
    r = await client.patch("/api/groups/external", json={"name": "   "})

    assert r.status_code == 422


async def test_patch_group_rename_with_whitespace_and_disable(client: AsyncClient) -> None:
    await client.post(
        "/api/hosts", json={"name": "x", "address": "1.1.1.1", "group_name": "external"}
    )
    r = await client.patch("/api/groups/external", json={"name": " lan ", "enabled": False})

    assert r.status_code == 200
    assert r.json()["name"] == "lan"
    groups = (await client.get("/api/groups")).json()
    names = {g["name"] for g in groups}
    assert "lan" in names
    assert " lan " not in names
    assert next(g for g in groups if g["name"] == "lan")["enabled"] is False


async def test_group_delete_removes_hosts(client: AsyncClient) -> None:
    await client.post(
        "/api/hosts", json={"name": "x", "address": "1.1.1.1", "group_name": "external"}
    )
    r = await client.delete("/api/groups/external")
    assert r.status_code == 204
    assert (await client.get("/api/hosts")).json() == []
    groups = (await client.get("/api/groups")).json()
    assert "external" not in {g["name"] for g in groups}


async def test_group_disable_stops_pinging_after_reconcile(
    client: AsyncClient, app: FastAPI
) -> None:
    """When a group is disabled while monitoring is active, the scheduler
    must cancel that group's host loops."""
    await client.post(
        "/api/hosts", json={"name": "x", "address": "1.1.1.1", "group_name": "external"}
    )
    await client.post("/api/monitoring/start")
    sched: PingScheduler = app.state.scheduler

    async def _running() -> bool:
        return 1 in sched._tasks

    async def _not_running() -> bool:
        return 1 not in sched._tasks

    await _poll_until(_running)

    await client.patch("/api/groups/external", json={"enabled": False})
    await _poll_until(_not_running)

    await client.patch("/api/groups/external", json={"enabled": True})
    await _poll_until(_running)


async def test_patch_unknown_group_404(client: AsyncClient) -> None:
    # update_group upserts only if the row exists; we test the not-found path
    # by patching with empty body so no upsert and no row.
    r = await client.patch("/api/groups/nonexistent", json={})
    assert r.status_code == 404
