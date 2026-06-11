"""Monitoring lifecycle controller.

The HTTP server runs continuously; the **pinger** lifecycle is gated by an
explicit start/stop from the UI. Default state on app boot is PAUSED.

When the operator presses START, the controller:
  - starts the PingScheduler
  - schedules either a legacy duration auto-stop or a packet-limited run
  - broadcasts the new state to all WS clients

Pressing START again while already active is a no-op.
Pressing STOP cancels the timer and stops the scheduler.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from .pinger import PingScheduler
from .store import Host
from .ws import WebSocketHub

log = logging.getLogger(__name__)
_UNSET = object()


class MonitoringController:
    def __init__(
        self,
        scheduler: PingScheduler,
        hub: WebSocketHub,
        *,
        duration_s: float = 1800,
    ) -> None:
        self.scheduler = scheduler
        self.hub = hub
        self.duration_s = duration_s
        self._active = False
        self._expires_at: datetime | None = None
        self._auto_stop_task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        self._run_id = 0
        self._packet_limit: int | None = None
        self._packet_counts: dict[int, int] = {}
        self._packet_target_ids: set[int] = set()
        self._note_sample_tasks: set[asyncio.Task[None]] = set()
        self._limit_mode = "duration"
        self.scheduler.sample_observer = self.note_sample

    # ---- public API ---------------------------------------------------------

    def status(self) -> dict[str, Any]:
        return {
            "active": self._active,
            "expires_at": self._expires_at.isoformat() if self._expires_at else None,
            "duration_s": self.duration_s,
            "limit_mode": self._limit_mode,
            "packet_limit": self._packet_limit,
            "packet_counts": self._packet_counts,
        }

    async def start(self, *, packet_limit: int | None | object = _UNSET) -> dict[str, Any]:
        async with self._lock:
            if self._active:
                log.info("monitoring start ignored; already active")
                return self.status()
            self._cancel_auto_stop()
            self._run_id += 1
            await self._configure_packet_limit(packet_limit)
            await self.scheduler.start()
            self._active = True
            if packet_limit is _UNSET:
                self._expires_at = datetime.now(UTC) + timedelta(seconds=self.duration_s)
                self._auto_stop_task = asyncio.create_task(
                    self._auto_stop(), name="monitoring-auto-stop"
                )
            else:
                self._expires_at = None
            await self._broadcast()
            if self._expires_at is not None:
                log.info("monitoring started; auto-stop at %s", self._expires_at.isoformat())
            elif self._packet_limit is not None:
                log.info("monitoring started; packet limit=%s", self._packet_limit)
            else:
                log.info("monitoring started; packet limit=infinite")
            return self.status()

    async def stop(self) -> dict[str, Any]:
        async with self._lock:
            self._run_id += 1
            self._cancel_auto_stop()
            if self._active:
                await self.scheduler.stop()
                self._active = False
            self._expires_at = None
            self._clear_packet_limit()
            await self._broadcast()
            log.info("monitoring stopped")
            return self.status()

    def note_sample(self, host_id: int) -> None:
        if not self._active or self._packet_limit is None:
            return
        run_id = self._run_id
        task = asyncio.create_task(
            self._note_sample(host_id, run_id), name="monitoring-packet-count"
        )
        self._note_sample_tasks.add(task)
        task.add_done_callback(self._note_sample_tasks.discard)

    async def reconcile_packet_targets(
        self, hosts: list[Host], *, disabled_groups: set[str] | None = None
    ) -> None:
        async with self._lock:
            if not self._active or self._packet_limit is None:
                return
            active_ids = self._active_host_ids(hosts, disabled_groups or set())
            self._packet_target_ids = active_ids
            self._packet_counts = {
                host_id: self._packet_counts.get(host_id, 0)
                for host_id in self._packet_target_ids
            }
            await self._stop_if_packet_limit_reached_locked()

    async def shutdown(self) -> None:
        """Lifespan shutdown helper: stop scheduler if running, no broadcast."""
        self._run_id += 1
        self._cancel_auto_stop()
        if self._active:
            await self.scheduler.stop()
            self._active = False
            self._expires_at = None
        for task in self._note_sample_tasks:
            task.cancel()
        if self._note_sample_tasks:
            await asyncio.gather(*self._note_sample_tasks, return_exceptions=True)
            self._note_sample_tasks.clear()
        self._clear_packet_limit()

    # ---- internals -----------------------------------------------------------

    async def _configure_packet_limit(self, packet_limit: int | None | object) -> None:
        self._clear_packet_limit()
        if packet_limit is _UNSET:
            self._limit_mode = "duration"
            return
        if packet_limit is None:
            self._limit_mode = "infinite"
            return
        if not isinstance(packet_limit, int) or not 1 <= packet_limit <= 1000:
            raise ValueError("packet_limit must be between 1 and 1000")
        disabled = await self.scheduler.store.disabled_group_names()
        hosts = await self.scheduler.store.list_hosts()
        self._packet_target_ids = self._active_host_ids(hosts, disabled)
        self._packet_counts = {host_id: 0 for host_id in self._packet_target_ids}
        self._packet_limit = packet_limit
        self._limit_mode = "packets"

    def _clear_packet_limit(self) -> None:
        self._packet_limit = None
        self._packet_counts = {}
        self._packet_target_ids = set()
        self._limit_mode = "duration"

    def _active_host_ids(self, hosts: list[Host], disabled_groups: set[str]) -> set[int]:
        return {
            host.id
            for host in hosts
            if host.enabled and host.group_name not in disabled_groups
        }

    async def _note_sample(self, host_id: int, run_id: int) -> None:
        async with self._lock:
            if (
                run_id != self._run_id
                or not self._active
                or self._packet_limit is None
                or host_id not in self._packet_target_ids
            ):
                return
            current = self._packet_counts.get(host_id, 0)
            if current < self._packet_limit:
                self._packet_counts[host_id] = current + 1
            await self._stop_if_packet_limit_reached_locked()

    async def _stop_if_packet_limit_reached_locked(self) -> None:
        if (
            self._packet_limit is None
            or not self._packet_target_ids
            or not self._active
        ):
            return
        if not all(
            self._packet_counts.get(host_id, 0) >= self._packet_limit
            for host_id in self._packet_target_ids
        ):
            return
        with contextlib.suppress(Exception):
            await self.scheduler.stop()
        self._active = False
        self._expires_at = None
        self._clear_packet_limit()
        await self._broadcast()

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
