"""Tests for the WebSocket hub, the /ws endpoint and the real app lifespan.

These run the REAL ``netping.app.create_app()`` (lifespan included) against a
tmp_path SQLite DB so the wiring in ``app.state`` (store/hub/scheduler/
monitoring/reconcile_lock) is exercised end-to-end. The server boots PAUSED,
so no real ping subprocesses are spawned by host CRUD here.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
from starlette.websockets import WebSocketState

# NOTE: importing netping.app executes the module-level ``app = create_app()``
# with default settings; the fixture below builds its OWN app after pointing
# the (reset) settings singleton at a tmp DB.
from netping.app import create_app
from netping.config import reset_settings
from netping.ws import WebSocketHub

CSRF = {"X-Requested-With": "fetch"}
# Browsers always send Origin on WS upgrades; send a same-origin value so the
# tests model a real browser on the dashboard page.
WS_HEADERS = {"origin": "http://testserver"}


@pytest.fixture
def real_app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[FastAPI]:
    """The real create_app() with settings pointed at a tmp DB.

    reset_settings() runs before (pick up env) and after (un-pollute the
    cached singleton for every other test module).
    """
    monkeypatch.setenv("PING_DB_PATH", str(tmp_path / "ping.db"))
    monkeypatch.setenv("PING_WRITE_FLUSH_INTERVAL_S", "0.05")
    reset_settings()
    try:
        yield create_app()
    finally:
        reset_settings()


# --- /ws endpoint -------------------------------------------------------------


def test_ws_connect_sends_empty_snapshot(real_app: FastAPI) -> None:
    with TestClient(real_app) as client, client.websocket_connect(
        "/ws", headers=WS_HEADERS
    ) as ws:
        msg = ws.receive_json()
        assert msg["type"] == "snapshot"
        assert msg["hosts"] == []


def test_ws_snapshot_contains_existing_hosts(real_app: FastAPI) -> None:
    with TestClient(real_app) as client:
        r = client.post(
            "/api/hosts",
            json={"name": "gw", "address": "192.0.2.1", "group_name": "lan"},
            headers=CSRF,
        )
        assert r.status_code == 201
        with client.websocket_connect("/ws", headers=WS_HEADERS) as ws:
            msg = ws.receive_json()
            assert msg["type"] == "snapshot"
            addresses = [h["address"] for h in msg["hosts"]]
            assert addresses == ["192.0.2.1"]


def test_ws_receives_host_created_broadcast(real_app: FastAPI) -> None:
    with TestClient(real_app) as client, client.websocket_connect(
        "/ws", headers=WS_HEADERS
    ) as ws:
        assert ws.receive_json()["type"] == "snapshot"
        r = client.post(
            "/api/hosts",
            json={"name": "dns", "address": "192.0.2.53"},
            headers=CSRF,
        )
        assert r.status_code == 201
        msg = ws.receive_json()
        assert msg["type"] == "host_created"
        assert msg["host"]["address"] == "192.0.2.53"
        assert msg["host"]["id"] == r.json()["id"]


def test_ws_receives_host_deleted_broadcast(real_app: FastAPI) -> None:
    with TestClient(real_app) as client:
        created = client.post(
            "/api/hosts", json={"name": "x", "address": "192.0.2.9"}, headers=CSRF
        ).json()
        with client.websocket_connect("/ws", headers=WS_HEADERS) as ws:
            assert ws.receive_json()["type"] == "snapshot"
            assert client.delete(f"/api/hosts/{created['id']}", headers=CSRF).status_code == 204
            msg = ws.receive_json()
            assert msg == {"type": "host_deleted", "host_id": created["id"]}


def test_ws_client_count_reflected_in_info(real_app: FastAPI) -> None:
    with TestClient(real_app) as client:
        assert client.get("/api/info").json()["ws_clients"] == 0
        with client.websocket_connect("/ws", headers=WS_HEADERS) as ws:
            assert ws.receive_json()["type"] == "snapshot"
            assert client.get("/api/info").json()["ws_clients"] == 1


# --- WebSocketHub unit tests ----------------------------------------------------


class FakeWS:
    """Minimal stand-in for a starlette WebSocket as the hub uses it."""

    def __init__(self, *, fail: bool = False, hang: bool = False) -> None:
        self.fail = fail
        self.hang = hang
        self.sent: list[str] = []
        # Lets hub.disconnect() skip the close() handshake.
        self.client_state = WebSocketState.DISCONNECTED

    async def accept(self) -> None:
        pass

    async def send_text(self, payload: str) -> None:
        if self.fail:
            raise RuntimeError("simulated send failure")
        if self.hang:
            await asyncio.sleep(30)  # cancelled by the hub's per-client timeout
        self.sent.append(payload)


async def test_hub_broadcast_delivers_to_all_clients() -> None:
    hub = WebSocketHub()
    a, b = FakeWS(), FakeWS()
    await hub.connect(a)  # type: ignore[arg-type]
    await hub.connect(b)  # type: ignore[arg-type]
    assert len(hub) == 2

    await hub.broadcast({"type": "ping", "n": 1})
    assert json.loads(a.sent[0]) == {"type": "ping", "n": 1}
    assert json.loads(b.sent[0]) == {"type": "ping", "n": 1}
    assert len(hub) == 2


async def test_hub_broadcast_prunes_client_whose_send_raises() -> None:
    hub = WebSocketHub()
    good, bad = FakeWS(), FakeWS(fail=True)
    await hub.connect(good)  # type: ignore[arg-type]
    await hub.connect(bad)  # type: ignore[arg-type]

    await hub.broadcast({"type": "x"})
    assert len(hub) == 1  # bad client dropped
    assert len(good.sent) == 1

    # the survivor keeps receiving on subsequent broadcasts
    await hub.broadcast({"type": "y"})
    assert len(good.sent) == 2
    assert len(hub) == 1


async def test_hub_broadcast_prunes_slow_client_via_timeout() -> None:
    """A client whose send never completes hits the per-client timeout and is
    pruned without stalling delivery to healthy clients."""
    hub = WebSocketHub()
    good, slow = FakeWS(), FakeWS(hang=True)
    await hub.connect(good)  # type: ignore[arg-type]
    await hub.connect(slow)  # type: ignore[arg-type]

    await hub.broadcast({"type": "x"})
    assert len(good.sent) == 1
    assert slow.sent == []
    assert len(hub) == 1


async def test_hub_disconnect_removes_client() -> None:
    hub = WebSocketHub()
    ws = FakeWS()
    await hub.connect(ws)  # type: ignore[arg-type]
    assert len(hub) == 1
    await hub.disconnect(ws)  # type: ignore[arg-type]
    assert len(hub) == 0
    # idempotent
    await hub.disconnect(ws)  # type: ignore[arg-type]
    assert len(hub) == 0


async def test_hub_snapshot_to_sends_each_message() -> None:
    hub = WebSocketHub()
    ws = FakeWS()
    await hub.snapshot_to(ws, [{"a": 1}, {"b": 2}])  # type: ignore[arg-type]
    assert [json.loads(m) for m in ws.sent] == [{"a": 1}, {"b": 2}]


# --- lifespan / create_app ------------------------------------------------------


def test_lifespan_boots_and_serves_api(real_app: FastAPI, tmp_path: Path) -> None:
    with TestClient(real_app) as client:
        info = client.get("/api/info")
        assert info.status_code == 200
        body = info.json()
        for field in ("version", "ts", "hostname", "lan_ip", "os", "ws_clients"):
            assert field in body
        assert body["ws_clients"] == 0

        mon = client.get("/api/monitoring")
        assert mon.status_code == 200
        m = mon.json()
        assert m["active"] is False  # boots PAUSED (PRD contract)
        assert m["expires_at"] is None

    # the DB landed where PING_DB_PATH pointed
    assert (tmp_path / "ping.db").exists()


def test_lifespan_host_crud_roundtrip_against_real_wiring(real_app: FastAPI) -> None:
    """CRUD via the real app exercises store + reconcile_lock + hub wiring."""
    with TestClient(real_app) as client:
        r = client.post(
            "/api/hosts",
            json={"name": "gw", "address": "192.0.2.1", "group_name": "lan"},
            headers=CSRF,
        )
        assert r.status_code == 201
        hosts = client.get("/api/hosts").json()
        assert [h["address"] for h in hosts] == ["192.0.2.1"]
        groups = client.get("/api/groups").json()
        assert "lan" in {g["name"] for g in groups}


def test_static_js_module_served_with_no_cache(real_app: FastAPI) -> None:
    """ES-module imports are unversioned (cache busting only on the entry
    point) — every static file must carry ``Cache-Control: no-cache`` so
    browsers revalidate (ETag/304) instead of heuristically caching stale
    submodules across upgrades."""
    with TestClient(real_app) as client:
        r = client.get("/js/api.js")
        assert r.status_code == 200
        assert r.headers["cache-control"] == "no-cache"


def test_lifespan_shutdown_is_clean_and_app_restartable(real_app: FastAPI) -> None:
    """Open/close the lifespan twice on the same app — shutdown must release
    everything so a restart against the same DB works."""
    with TestClient(real_app) as client:
        client.post(
            "/api/hosts", json={"name": "a", "address": "192.0.2.2"}, headers=CSRF
        )
    with TestClient(real_app) as client:
        hosts = client.get("/api/hosts").json()
        assert [h["address"] for h in hosts] == ["192.0.2.2"]
