"""WebSocket hub: fan-out for ping samples and host CRUD events.

Each connected client subscribes implicitly to all host events; per-group
filtering is performed client-side (the message bandwidth is well within
budget at 254 hosts x 1 Hz). The hub serialises broadcasts on a single task
to keep ordering deterministic and ensure that a slow client cannot block
others — disconnected clients are dropped silently.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Iterable
from typing import Any

from starlette.websockets import WebSocket, WebSocketState

log = logging.getLogger(__name__)


class WebSocketHub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)
        if ws.client_state != WebSocketState.DISCONNECTED:
            with contextlib.suppress(Exception):
                await ws.close()

    async def broadcast(self, message: dict[str, Any]) -> None:
        payload = json.dumps(message, default=str)
        dead: list[WebSocket] = []
        async with self._lock:
            clients = list(self._clients)
        for ws in clients:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)

    def __len__(self) -> int:
        return len(self._clients)

    async def snapshot_to(self, ws: WebSocket, messages: Iterable[dict[str, Any]]) -> None:
        """Send a sequence of one-off messages to a single client (e.g. on reconnect)."""
        for m in messages:
            await ws.send_text(json.dumps(m, default=str))
