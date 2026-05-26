"""API tests for /api/hosts CRUD + /info."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from netping.api import router
from netping.store import Store
from netping.ws import WebSocketHub


@pytest.fixture
async def app(tmp_path: Path) -> AsyncIterator[FastAPI]:
    a = FastAPI()
    store = Store(tmp_path / "ping.db", flush_interval_s=0.05)
    await store.open()
    store.start_writer()
    a.state.store = store
    a.state.hub = WebSocketHub()
    a.include_router(router)
    yield a
    await store.close()


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
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
