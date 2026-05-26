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
from .store import Host, Sample, Store, utcnow_iso

Broadcaster = Callable[[dict], Awaitable[None]]


def build_ping_command(host: str, *, count: int = 1, timeout_s: float = 2.0) -> list[str]:
    """Return an OS-appropriate argv for a single ping.

    On Linux ``-W`` is seconds. On macOS ``-W`` is **milliseconds** (quirk):
    we send seconds intended for Linux; on macOS the value is interpreted as
    ms and effectively means "give up almost immediately". Dev-time tests
    therefore use the host's natural timeout — this matters mostly for
    air-gapped Linux deploys where the value is meaningful.
    """
    os_name = platform.system()
    timeout_ms = max(1, int(timeout_s * 1000))
    if os_name == "Windows":
        return ["ping", "-n", str(count), "-w", str(timeout_ms), host]
    # Linux + macOS use the same flags; semantics differ (see docstring).
    return ["ping", "-c", str(count), "-W", str(int(timeout_s)), host]


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
    ) -> None:
        self.store = store
        self.timeout_s = timeout_s
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self.broadcaster = broadcaster
        self._tasks: dict[int, asyncio.Task[None]] = {}
        # Cached (address, interval_s) per running host_id so reconcile can
        # detect changes that require a task restart (Grumpy audit Sprint 2).
        self._signatures: dict[int, tuple[str, float]] = {}
        self._stop = asyncio.Event()

    # ---- public lifecycle ----------------------------------------------------

    async def start(self) -> None:
        """Start a host_loop for every enabled host in the store."""
        for host in await self.store.list_hosts():
            if host.enabled:
                self._spawn(host)

    async def stop(self) -> None:
        self._stop.set()
        tasks = list(self._tasks.values())
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        self._signatures.clear()
        self._stop.clear()

    def reconcile(self, hosts: list[Host]) -> None:
        """Sync the running host_loops with the given desired set.

        - Hosts present + enabled with **changed** address/interval: restart task.
        - Hosts present + enabled without changes: leave task running.
        - Hosts disabled or absent: cancel any running task.
        """
        desired = {h.id: h for h in hosts if h.enabled}

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
