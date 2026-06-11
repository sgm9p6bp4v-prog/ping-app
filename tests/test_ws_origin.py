"""WS handshake Origin check (CSWSH guard, audit fix).

A browser on another LAN origin can open ``new WebSocket("ws://server/ws")``;
without an Origin check it would receive every broadcast. The endpoint now
rejects handshakes whose Origin host does not match the request Host (and is
not allow-listed via PING_CORS_ORIGINS). Absent Origin (curl, scripts) stays
allowed.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from netping.app import create_app
from netping.config import reset_settings


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("PING_DB_PATH", str(tmp_path / "ping.db"))
    reset_settings()  # drop cached singleton so the env override is seen
    with TestClient(create_app()) as c:
        yield c
    reset_settings()


def test_ws_allows_same_origin(client: TestClient) -> None:
    with client.websocket_connect("/ws", headers={"Origin": "http://testserver"}) as ws:
        assert ws.receive_json()["type"] == "snapshot"


def test_ws_allows_absent_origin(client: TestClient) -> None:
    # Non-browser clients (curl, LAN tooling) do not send Origin — keep them.
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "snapshot"


def test_ws_rejects_cross_origin(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect), client.websocket_connect(
        "/ws", headers={"Origin": "http://evil.example"}
    ) as ws:
        ws.receive_json()


def test_ws_rejects_cross_origin_same_scheme_other_host(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect), client.websocket_connect(
        "/ws", headers={"Origin": "http://testserver.attacker.example"}
    ) as ws:
        ws.receive_json()
