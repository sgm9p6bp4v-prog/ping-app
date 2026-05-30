"""API tests for /api/hosts CRUD + /info."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from netping import api as api_mod
from netping.api import router
from netping.app import CSRFGuardMiddleware
from netping.store import Store
from netping.ws import WebSocketHub


@pytest.fixture
async def app(tmp_path: Path) -> AsyncIterator[FastAPI]:
    a = FastAPI()
    a.add_middleware(CSRFGuardMiddleware)
    store = Store(tmp_path / "ping.db", flush_interval_s=0.05)
    await store.open()
    store.start_writer()
    a.state.store = store
    a.state.hub = WebSocketHub()
    a.state.reconcile_lock = __import__("asyncio").Lock()
    a.include_router(router)
    yield a
    await store.close()


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    # Browser fetch() always sets X-Requested-With via static/js/api.js; the
    # tests model the same browser, so attach the header globally.
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"X-Requested-With": "fetch"},
    ) as c:
        yield c


async def test_info(client: AsyncClient) -> None:
    r = await client.get("/info")
    assert r.status_code == 200
    body = r.json()
    assert "version" in body
    assert body["ws_clients"] == 0


async def test_list_hosts_empty(client: AsyncClient) -> None:
    r = await client.get("/api/hosts")
    assert r.status_code == 200
    assert r.json() == []


async def test_create_host_happy_path(client: AsyncClient) -> None:
    r = await client.post(
        "/api/hosts",
        json={"name": "dns", "address": "8.8.8.8", "group_name": "ext", "interval_s": 1.5},
    )
    assert r.status_code == 201
    body = r.json()
    assert body["id"] > 0
    assert body["address"] == "8.8.8.8"
    assert body["interval_s"] == 1.5


async def test_create_host_rejects_invalid_address(client: AsyncClient) -> None:
    r = await client.post("/api/hosts", json={"name": "x", "address": "not a host!!"})
    assert r.status_code == 422


async def test_create_host_accepts_hostname(client: AsyncClient) -> None:
    r = await client.post("/api/hosts", json={"name": "g", "address": "google.com"})
    assert r.status_code == 201


async def test_create_host_accepts_ipv6(client: AsyncClient) -> None:
    r = await client.post("/api/hosts", json={"name": "v6", "address": "2001:db8::1"})
    assert r.status_code == 201


async def test_create_host_rejects_interval_out_of_range(client: AsyncClient) -> None:
    r = await client.post(
        "/api/hosts", json={"name": "x", "address": "1.1.1.1", "interval_s": 0.05}
    )
    assert r.status_code == 422


async def test_patch_and_get(client: AsyncClient) -> None:
    created = (await client.post("/api/hosts", json={"name": "a", "address": "1.1.1.1"})).json()
    hid = created["id"]
    r = await client.patch(f"/api/hosts/{hid}", json={"name": "renamed", "enabled": False})
    assert r.status_code == 200
    assert r.json()["name"] == "renamed"
    assert r.json()["enabled"] is False
    g = await client.get(f"/api/hosts/{hid}")
    assert g.json()["name"] == "renamed"


async def test_delete_host(client: AsyncClient) -> None:
    created = (await client.post("/api/hosts", json={"name": "a", "address": "1.1.1.1"})).json()
    r = await client.delete(f"/api/hosts/{created['id']}")
    assert r.status_code == 204
    assert (await client.get(f"/api/hosts/{created['id']}")).status_code == 404


async def test_history_endpoint(client: AsyncClient) -> None:
    h = (await client.post("/api/hosts", json={"name": "a", "address": "1.1.1.1"})).json()
    r = await client.get(f"/api/hosts/{h['id']}/history")
    assert r.status_code == 200
    body = r.json()
    assert body["host_id"] == h["id"]
    assert body["samples"] == []
    assert body["count"] == 0


async def test_history_404_for_unknown_host(client: AsyncClient) -> None:
    r = await client.get("/api/hosts/9999/history")
    assert r.status_code == 404


# --- Regression tests for Grumpy audit fixes ---------------------------------


async def test_history_limit_capped(client: AsyncClient) -> None:
    h = (await client.post("/api/hosts", json={"name": "a", "address": "1.1.1.1"})).json()
    r = await client.get(f"/api/hosts/{h['id']}/history?limit=1000000")
    assert r.status_code == 422  # exceeds HISTORY_MAX_LIMIT


async def test_history_limit_negative_rejected(client: AsyncClient) -> None:
    h = (await client.post("/api/hosts", json={"name": "a", "address": "1.1.1.1"})).json()
    r = await client.get(f"/api/hosts/{h['id']}/history?limit=-1")
    assert r.status_code == 422


async def test_events_limit_capped(client: AsyncClient) -> None:
    r = await client.get("/api/events?limit=999999")
    assert r.status_code == 422


async def test_api_info_returns_hostname_and_lan_ip(client: AsyncClient) -> None:
    r = await client.get("/api/info")
    assert r.status_code == 200
    body = r.json()
    for field in ("version", "ts", "hostname", "lan_ip", "os", "ws_clients"):
        assert field in body
    assert "ping_interface" in body


async def test_network_interface_endpoint_persists_selection(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(api_mod.network, "detect_default_interface", lambda: "en0")
    monkeypatch.setattr(
        api_mod.network,
        "list_network_interfaces",
        lambda: [api_mod.network.NetworkInterface("en0", ["192.168.1.20"], is_default=True)],
    )

    initial = (await client.get("/api/network/interfaces")).json()
    assert initial["selected"] == "auto"
    assert initial["active"]["name"] == "en0"

    updated = (await client.patch("/api/network/interface", json={"name": "en0"})).json()
    assert updated["selected"] == "en0"

    persisted = (await client.get("/api/network/interfaces")).json()
    assert persisted["selected"] == "en0"

    missing = await client.patch("/api/network/interface", json={"name": "missing0"})
    assert missing.status_code == 422


async def test_csrf_guard_blocks_write_without_header(app: FastAPI) -> None:
    """Final audit C1: <form> POST from a malicious LAN page lacks
    X-Requested-With and must be rejected."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as bare:
        r = await bare.post("/api/hosts", json={"name": "x", "address": "1.1.1.1"})
    assert r.status_code == 403


async def test_csrf_guard_allows_read_without_header(app: FastAPI) -> None:
    """GET requests are not state-mutating and must remain reachable."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as bare:
        r = await bare.get("/api/hosts")
    assert r.status_code == 200


async def test_host_cap_enforced(client: AsyncClient, monkeypatch) -> None:
    """Final audit GPT MED: LAN client must not be able to spam unlimited hosts."""
    monkeypatch.setattr(api_mod, "HOST_CAP", 3)
    for i in range(3):
        r = await client.post("/api/hosts", json={"name": f"h{i}", "address": f"1.1.1.{i + 1}"})
        assert r.status_code == 201
    r = await client.post("/api/hosts", json={"name": "h4", "address": "1.1.1.99"})
    assert r.status_code == 409
    assert "cap" in r.json()["detail"].lower()
