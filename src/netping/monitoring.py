"""Monitoring lifecycle controller.

The HTTP server runs continuously; the **pinger** lifecycle is gated by an
explicit start/stop from the UI. Default state on app boot is PAUSED.

When the operator presses START, the controller:
  - starts the PingScheduler
  - schedules an auto-stop task that fires after ``duration_s`` seconds
  - broadcasts the new state to all WS clients (with ``expires_at`` so the
    front-end can render a countdown)

Pressing START again while already active re-arms the timer from zero.
Pressing STOP cancels the timer and stops the scheduler.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from .pinger import PingScheduler
from .ws import WebSocketHub

log = logging.getLogger(__name__)


class MonitoringController:
    def __init__(
        self,
        scheduler: PingScheduler,
        hub: WebSocketHub,
        *,
        duration_s: int = 1800,
    ) -> None:
        self.scheduler = scheduler
        self.hub = hub
        self.duration_s = duration_s
        self._active = False
        self._expires_at: datetime | None = None
        self._auto_stop_task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()

    # ---- public API ---------------------------------------------------------

    def status(self) -> dict[str, Any]:
        return {
            "active": self._active,
            "expires_at": self._expires_at.isoformat() if self._expires_at else None,
            "duration_s": self.duration_s,
        }

    async def start(self) -> dict[str, Any]:
        async with self._lock:
            # Re-arming while already active: cancel old timer + scheduler is
            # already running, just set a new expiry.
            self._cancel_auto_stop()
            if not self._active:
                await self.scheduler.start()
                self._active = True
            self._expires_at = datetime.now(UTC) + timedelta(seconds=self.duration_s)
            self._auto_stop_task = asyncio.create_task(
                self._auto_stop(), name="monitoring-auto-stop"
            )
            await self._broadcast()
            log.info("monitoring started; auto-stop at %s", self._expires_at.isoformat())
            return self.status()

    async def stop(self) -> dict[str, Any]:
        async with self._lock:
            self._cancel_auto_stop()
            if self._active:
                await self.scheduler.stop()
                self._active = False
            self._expires_at = None
            await self._broadcast()
            log.info("monitoring stopped")
            return self.status()

    async def shutdown(self) -> None:
        """Lifespan shutdown helper: stop scheduler if running, no broadcast."""
        self._cancel_auto_stop()
        if self._active:
            await self.scheduler.stop()
            self._active = False
            self._expires_at = None

    # ---- internals -----------------------------------------------------------

    def _cancel_auto_stop(self) -> None:
        if self._auto_stop_task is not None and not self._auto_stop_task.done():
            self._auto_stop_task.cancel()
        self._auto_stop_task = None

    async def _auto_stop(self) -> None:
        try:
            await asyncio.sleep(self.duration_s)
        except asyncio.CancelledError:
            return
        # Reach here only if not cancelled.
        log.info("monitoring auto-stop firing after %ds", self.duration_s)
        async with self._lock:
            if self._active:
                with contextlib.suppress(Exception):
                    await self.scheduler.stop()
                self._active = False
                self._expires_at = None
                await self._broadcast()

    async def _broadcast(self) -> None:
        await self.hub.broadcast({"type": "monitoring_state", **self.status()})
