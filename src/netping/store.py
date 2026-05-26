"""SQLite persistence layer.

Three tables:
- ``hosts`` (operator-managed via UI / API)
- ``samples`` (one row per ping result; high-volume, append-only, rolling retention)
- ``events`` (state transitions / outages; rolling retention)

Concurrency model:
- All writes go through ``Store.enqueue_sample()`` → buffered, flushed by a
  background task (see :class:`Store.writer_loop`) every ``write_flush_interval_s``
  or when ``write_flush_max_batch`` is reached. Keeps the request hot-path free of
  ``INSERT``s and avoids ``database is locked`` under 254 Hz ping load.
- Reads (hosts CRUD, history) use ``aiosqlite`` connections directly.
- WAL mode + ``PRAGMA synchronous=NORMAL`` for throughput.
"""

from __future__ import annotations

import asyncio
import contextlib
import sqlite3
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import aiosqlite

# ----------------------------------------------------------------------------- schema


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS hosts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  address      TEXT    NOT NULL,
  group_name   TEXT    NOT NULL DEFAULT 'default',
  interval_s   REAL    NOT NULL DEFAULT 1.0,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_hosts_enabled ON hosts(enabled);

CREATE TABLE IF NOT EXISTS samples (
  host_id  INTEGER NOT NULL,
  ts       TEXT    NOT NULL,
  rtt_ms   REAL,
  success  INTEGER NOT NULL,
  error    TEXT,
  FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_samples_host_ts ON samples(host_id, ts);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id  INTEGER NOT NULL,
  ts       TEXT    NOT NULL,
  type     TEXT    NOT NULL,
  message  TEXT,
  FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_host_ts ON events(host_id, ts);
"""


# ----------------------------------------------------------------------------- types


def utcnow_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


@dataclass(slots=True)
class Host:
    id: int
    name: str
    address: str
    group_name: str
    interval_s: float
    enabled: bool
    created_at: str

    @classmethod
    def from_row(cls, row: sqlite3.Row | aiosqlite.Row) -> Host:
        return cls(
            id=row["id"],
            name=row["name"],
            address=row["address"],
            group_name=row["group_name"],
            interval_s=row["interval_s"],
            enabled=bool(row["enabled"]),
            created_at=row["created_at"],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "address": self.address,
            "group_name": self.group_name,
            "interval_s": self.interval_s,
            "enabled": self.enabled,
            "created_at": self.created_at,
        }


@dataclass(slots=True)
class Sample:
    host_id: int
    ts: str
    rtt_ms: float | None
    success: bool
    error: str | None


@dataclass(slots=True)
class Event:
    host_id: int
    ts: str
    type: str
    message: str | None


# ----------------------------------------------------------------------------- store


class Store:
    """Lifecycle: ``await Store.open()`` once at startup, ``await close()`` at shutdown.

    Background writer is started by :meth:`start_writer` and stopped by :meth:`close`.
    """

    def __init__(
        self,
        db_path: Path,
        *,
        flush_interval_s: float = 0.5,
        flush_max_batch: int = 1000,
    ) -> None:
        self.db_path = db_path
        self.flush_interval_s = flush_interval_s
        self.flush_max_batch = flush_max_batch
        self._sample_buf: list[Sample] = []
        self._event_buf: list[Event] = []
        self._buf_lock = asyncio.Lock()
        self._writer_task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()

    # ---- lifecycle -----------------------------------------------------------

    async def open(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        async with self._conn() as db:
            await db.executescript(SCHEMA_SQL)
            await db.commit()

    async def close(self) -> None:
        if self._writer_task is not None:
            self._stop.set()
            await self._writer_task
            self._writer_task = None
        # final flush
        await self._flush_now()

    def start_writer(self) -> None:
        if self._writer_task is None:
            self._stop.clear()
            self._writer_task = asyncio.create_task(self._writer_loop(), name="store-writer")

    # ---- connection helper ---------------------------------------------------

    @asynccontextmanager
    async def _conn(self) -> AsyncIterator[aiosqlite.Connection]:
        db = await aiosqlite.connect(self.db_path)
        try:
            db.row_factory = aiosqlite.Row
            await db.execute("PRAGMA journal_mode=WAL")
            await db.execute("PRAGMA synchronous=NORMAL")
            await db.execute("PRAGMA foreign_keys=ON")
            yield db
        finally:
            await db.close()

    # ---- hosts CRUD ----------------------------------------------------------

    async def list_hosts(self) -> list[Host]:
        async with (
            self._conn() as db,
            db.execute(
                "SELECT id, name, address, group_name, interval_s, enabled, created_at "
                "FROM hosts ORDER BY group_name, name"
            ) as cur,
        ):
            rows = await cur.fetchall()
        return [Host.from_row(r) for r in rows]

    async def get_host(self, host_id: int) -> Host | None:
        async with (
            self._conn() as db,
            db.execute(
                "SELECT id, name, address, group_name, interval_s, enabled, created_at "
                "FROM hosts WHERE id = ?",
                (host_id,),
            ) as cur,
        ):
            row = await cur.fetchone()
        return Host.from_row(row) if row else None

    async def create_host(
        self,
        *,
        name: str,
        address: str,
        group_name: str = "default",
        interval_s: float = 1.0,
        enabled: bool = True,
    ) -> Host:
        async with self._conn() as db:
            cur = await db.execute(
                "INSERT INTO hosts (name, address, group_name, interval_s, enabled) "
                "VALUES (?, ?, ?, ?, ?)",
                (name, address, group_name, interval_s, int(enabled)),
            )
            await db.commit()
            host_id = cur.lastrowid
        host = await self.get_host(host_id)
        assert host is not None
        return host

    async def update_host(self, host_id: int, **fields: Any) -> Host | None:
        allowed = {"name", "address", "group_name", "interval_s", "enabled"}
        sets = []
        vals: list[Any] = []
        for k, v in fields.items():
            if k not in allowed:
                continue
            sets.append(f"{k} = ?")
            vals.append(int(v) if k == "enabled" else v)
        if not sets:
            return await self.get_host(host_id)
        vals.append(host_id)
        async with self._conn() as db:
            await db.execute(f"UPDATE hosts SET {', '.join(sets)} WHERE id = ?", vals)
            await db.commit()
        return await self.get_host(host_id)

    async def delete_host(self, host_id: int) -> bool:
        async with self._conn() as db:
            cur = await db.execute("DELETE FROM hosts WHERE id = ?", (host_id,))
            await db.commit()
            return cur.rowcount > 0

    # ---- samples / events ----------------------------------------------------

    async def enqueue_sample(self, sample: Sample) -> None:
        async with self._buf_lock:
            self._sample_buf.append(sample)

    async def enqueue_event(self, event: Event) -> None:
        async with self._buf_lock:
            self._event_buf.append(event)

    async def history(
        self,
        host_id: int,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: int = 10_000,
    ) -> list[dict[str, Any]]:
        params: list[Any] = [host_id]
        sql = "SELECT ts, rtt_ms, success, error FROM samples WHERE host_id = ?"
        if since is not None:
            sql += " AND ts >= ?"
            params.append(since.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ"))
        if until is not None:
            sql += " AND ts <= ?"
            params.append(until.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ"))
        sql += " ORDER BY ts DESC LIMIT ?"
        params.append(limit)
        async with self._conn() as db, db.execute(sql, params) as cur:
            rows = await cur.fetchall()
        return [
            {
                "ts": r["ts"],
                "rtt_ms": r["rtt_ms"],
                "success": bool(r["success"]),
                "error": r["error"],
            }
            for r in rows
        ]

    async def events(
        self,
        host_id: int | None = None,
        *,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        if host_id is not None:
            sql = (
                "SELECT id, host_id, ts, type, message FROM events "
                "WHERE host_id = ? ORDER BY ts DESC LIMIT ?"
            )
            params: tuple[Any, ...] = (host_id, limit)
        else:
            sql = "SELECT id, host_id, ts, type, message FROM events ORDER BY ts DESC LIMIT ?"
            params = (limit,)
        async with self._conn() as db, db.execute(sql, params) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    # ---- writer loop & retention --------------------------------------------

    async def _writer_loop(self) -> None:
        while not self._stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=self.flush_interval_s)
            await self._flush_now()

    async def _flush_now(self) -> None:
        async with self._buf_lock:
            samples, self._sample_buf = self._sample_buf, []
            events, self._event_buf = self._event_buf, []
        if not samples and not events:
            return
        async with self._conn() as db:
            if samples:
                await self._insert_samples(db, samples)
            if events:
                await self._insert_events(db, events)
            await db.commit()

    @staticmethod
    async def _insert_samples(db: aiosqlite.Connection, samples: Iterable[Sample]) -> None:
        await db.executemany(
            "INSERT INTO samples (host_id, ts, rtt_ms, success, error) VALUES (?, ?, ?, ?, ?)",
            [(s.host_id, s.ts, s.rtt_ms, int(s.success), s.error) for s in samples],
        )

    @staticmethod
    async def _insert_events(db: aiosqlite.Connection, events: Iterable[Event]) -> None:
        await db.executemany(
            "INSERT INTO events (host_id, ts, type, message) VALUES (?, ?, ?, ?)",
            [(e.host_id, e.ts, e.type, e.message) for e in events],
        )

    async def purge(self, *, sample_days: int, event_days: int) -> tuple[int, int]:
        """Delete samples older than ``sample_days`` and events older than
        ``event_days``. Returns ``(samples_deleted, events_deleted)``."""
        now = datetime.now(UTC)
        sample_cutoff = (now - timedelta(days=sample_days)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        event_cutoff = (now - timedelta(days=event_days)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        async with self._conn() as db:
            cur1 = await db.execute("DELETE FROM samples WHERE ts < ?", (sample_cutoff,))
            cur2 = await db.execute("DELETE FROM events WHERE ts < ?", (event_cutoff,))
            await db.commit()
            return cur1.rowcount, cur2.rowcount
