"""Async ping engine.

One ``PingScheduler`` runs per ``Store``. It owns:
- one asyncio task per active host (``_host_loop``), pacing at ``host.interval_s``
- a global ``Semaphore`` capping concurrent subprocesses (PRD §4.1)
- a small initial jitter so 254 hosts do not start their pings at the same
  millisecond after enable()

It writes results into the ``Store`` via ``enqueue_sample`` (no DB on the hot
path) and broadcasts via the ``WebSocketHub`` if one is registered.

The scheduler is OS-aware: on macOS dev, ``ping -c 1 -W 2`` uses milliseconds
(known macOS quirk — see ``tests/test_parser.py``). At runtime on Linux the
``-W`` value means seconds. ``build_ping_command`` documents which path is
taken.
"""

from __future__ import annotations

import asyncio
import contextlib
import platform
import random
from collections.abc import Awaitable, Callable

from .parser import parse_ping_output
from .store import Event, Host, Sample, Store, utcnow_iso

# Three consecutive failures = outage_start; one success after that = outage_end.
OUTAGE_THRESHOLD_FAILS = 3

Broadcaster = Callable[[dict], Awaitable[None]]
SampleObserver = Callable[[int], None]


def build_ping_command(host: str, *, count: int = 1, timeout_s: float = 2.0) -> list[str]:
    """Return an OS-appropriate argv for a single ping.

    Semantics of the timeout flag differ across platforms — keep them
    explicit so dev (macOS) and prod (Linux) both produce meaningful RTTs:

    - **Linux** ``ping -W <seconds>`` per-packet reply timeout.
    - **macOS** ``ping -t <seconds>`` total timeout (``-W`` would be ms).
    - **Windows** ``ping -w <milliseconds>`` per-reply timeout.
    """
    os_name = platform.system()
    timeout_ms = max(1, int(timeout_s * 1000))
    seconds = max(1, int(timeout_s))
    if os_name == "Windows":
        return ["ping", "-n", str(count), "-w", str(timeout_ms), host]
    if os_name == "Darwin":
        return ["ping", "-c", str(count), "-t", str(seconds), host]
    return ["ping", "-c", str(count), "-W", str(seconds), host]


async def do_ping(address: str, *, timeout_s: float = 2.0) -> dict:
    """Run one ping and return ``{rtt_ms, success, error, ts, host}``."""
    cmd = build_ping_command(address, count=1, timeout_s=timeout_s)
    ts = utcnow_iso()
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={"LC_ALL": "C", "LANG": "C", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_s + 2.0)
        output = stdout.decode(errors="replace") + stderr.decode(errors="replace")
        parsed = parse_ping_output(output, platform.system())
    except TimeoutError:
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            with contextlib.suppress(Exception):
                await proc.wait()
        parsed = {"success": False, "rtt_ms": None, "error": "Process timeout"}
    except FileNotFoundError:
        parsed = {"success": False, "rtt_ms": None, "error": "ping command not found"}
    except Exception as exc:
        parsed = {"success": False, "rtt_ms": None, "error": str(exc)}
    parsed["ts"] = ts
    parsed["host"] = address
    return parsed


class PingScheduler:
    def __init__(
        self,
        store: Store,
        *,
        max_concurrent: int = 64,
        timeout_s: float = 2.0,
        broadcaster: Broadcaster | None = None,
        sample_observer: SampleObserver | None = None,
    ) -> None:
        self.store = store
        self.timeout_s = timeout_s
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self.broadcaster = broadcaster
        self.sample_observer = sample_observer
        self._tasks: dict[int, asyncio.Task[None]] = {}
        # Cached (address, interval_s) per running host_id so reconcile can
        # detect changes that require a task restart (Grumpy audit Sprint 2).
        self._signatures: dict[int, tuple[str, float]] = {}
        self._stop = asyncio.Event()
        # True between start() and stop(). Reconcile no-ops while inactive
        # so CRUD against a paused server doesn't silently start pinging.
        self._started = False

    # ---- public lifecycle ----------------------------------------------------

    async def start(self) -> None:
        """Start a host_loop for every enabled host whose group is enabled."""
        self._started = True
        disabled_groups = await self.store.disabled_group_names()
        for host in await self.store.list_hosts():
            if host.enabled and host.group_name not in disabled_groups:
                self._spawn(host)

    async def stop(self) -> None:
        self._started = False
        self._stop.set()
        tasks = list(self._tasks.values())
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        self._signatures.clear()
        self._stop.clear()

    @property
    def is_started(self) -> bool:
        return self._started

    def reconcile(self, hosts: list[Host], *, disabled_groups: set[str] | None = None) -> None:
        """Sync the running host_loops with the given desired set.

        - Hosts present + enabled with **changed** address/interval: restart task.
        - Hosts present + enabled without changes: leave task running.
        - Hosts disabled or absent: cancel any running task.
        - Hosts in a disabled group: cancel.

        No-ops while the scheduler is not started: CRUD against a paused server
        only updates the DB. The next `start()` will pick up the new state.
        """
        if not self._started:
            return
        dg = disabled_groups or set()
        desired = {h.id: h for h in hosts if h.enabled and h.group_name not in dg}

        # cancel removed/disabled OR changed
        for hid in list(self._tasks):
            current = desired.get(hid)
            signature = self._signatures.get(hid)
            if current is None or (current.address, current.interval_s) != signature:
                task = self._tasks.pop(hid)
                self._signatures.pop(hid, None)
                task.cancel()

        # spawn new (or replacements for cancelled)
        for h in desired.values():
            if h.id not in self._tasks:
                self._spawn(h)

    # ---- internals -----------------------------------------------------------

    def _spawn(self, host: Host) -> None:
        self._signatures[host.id] = (host.address, host.interval_s)
        self._tasks[host.id] = asyncio.create_task(
            self._host_loop(host), name=f"ping-host-{host.id}"
        )

    async def _host_loop(self, host: Host) -> None:
        # jitter so 254 hosts do not bunch on the same wallclock millisecond
        await asyncio.sleep(random.uniform(0, host.interval_s))
        fail_streak = 0
        in_outage = False
        while not self._stop.is_set():
            try:
                async with self.semaphore:
                    result = await do_ping(host.address, timeout_s=self.timeout_s)
                sample = Sample(
                    host_id=host.id,
                    ts=result["ts"],
                    rtt_ms=result["rtt_ms"],
                    success=result["success"],
                    error=result["error"],
                )
                await self.store.enqueue_sample(sample)
                if self.sample_observer is not None:
                    with contextlib.suppress(Exception):
                        self.sample_observer(host.id)

                # Outage detection: emit events on state transitions.
                if result["success"]:
                    if in_outage:
                        await self._emit_event(
                            host.id, result["ts"], "outage_end", "host recovered"
                        )
                        in_outage = False
                    fail_streak = 0
                else:
                    fail_streak += 1
                    if fail_streak == OUTAGE_THRESHOLD_FAILS and not in_outage:
                        why = result.get("error") or "no response"
                        await self._emit_event(
                            host.id,
                            result["ts"],
                            "outage_start",
                            f"failed {OUTAGE_THRESHOLD_FAILS}x: {why}",
                        )
                        in_outage = True
                if self.broadcaster is not None:
                    # Don't let a stuck broadcaster pace the ping loop.
                    with contextlib.suppress(TimeoutError, Exception):
                        await asyncio.wait_for(
                            self.broadcaster(
                                {
                                    "type": "sample",
                                    "host_id": host.id,
                                    "ts": result["ts"],
                                    "rtt_ms": result["rtt_ms"],
                                    "success": result["success"],
                                    "error": result["error"],
                                }
                            ),
                            timeout=0.5,
                        )
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            await asyncio.sleep(host.interval_s)

    async def _emit_event(self, host_id: int, ts: str, evt_type: str, msg: str) -> None:
        await self.store.enqueue_event(Event(host_id=host_id, ts=ts, type=evt_type, message=msg))
        if self.broadcaster is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(
                    self.broadcaster(
                        {"type": "event", "host_id": host_id, "ts": ts,
                         "evt_type": evt_type, "message": msg}
                    ),
                    timeout=0.5,
                )
