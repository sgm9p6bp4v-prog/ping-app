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
import logging
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
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id  INTEGER NOT NULL,
  ts       TEXT    NOT NULL,
  type     TEXT    NOT NULL,
  message  TEXT,
  FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_host_ts ON events(host_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS groups (
  name       TEXT    PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 1,
  collapsed  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS group_cidrs (
  group_name TEXT    NOT NULL,
  cidr       TEXT    NOT NULL,
  PRIMARY KEY (group_name, cidr),
  FOREIGN KEY (group_name) REFERENCES groups(name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dismissed_suggestions (
  host_id    INTEGER NOT NULL,
  group_name TEXT    NOT NULL,
  PRIMARY KEY (host_id, group_name),
  FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE,
  FOREIGN KEY (group_name) REFERENCES groups(name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


# ----------------------------------------------------------------------------- types


# Retention purge deletes in chunks of this many rows per transaction so the
# write lock is released between chunks (see Store._purge_table).
PURGE_CHUNK_ROWS = 50_000

# Single source of truth for the samples/events INSERTs: used by BOTH the
# batched executemany flush path and the per-row FK-violation fallback, so the
# two statements (and their param tuples) can never drift apart.
_SAMPLES_INSERT_SQL = (
    "INSERT INTO samples (host_id, ts, rtt_ms, success, error) VALUES (?, ?, ?, ?, ?)"
)
_EVENTS_INSERT_SQL = "INSERT INTO events (host_id, ts, type, message) VALUES (?, ?, ?, ?)"


def _sample_params(s: Sample) -> tuple[Any, ...]:
    return (s.host_id, s.ts, s.rtt_ms, int(s.success), s.error)


def _event_params(e: Event) -> tuple[Any, ...]:
    return (e.host_id, e.ts, e.type, e.message)


def utcnow_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _query_ts(dt: datetime) -> str:
    """Format a query bound for comparison against stored (UTC) timestamps.

    Naive datetimes are taken as UTC — ``.astimezone(UTC)`` alone would
    interpret them as server-local time and skew the window (audit fix)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


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


@dataclass(slots=True)
class Group:
    name: str
    enabled: bool
    collapsed: bool

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "enabled": self.enabled, "collapsed": self.collapsed}


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
        self._flush_failures = 0

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

    # ---- app settings --------------------------------------------------------

    async def get_setting(self, key: str, default: str | None = None) -> str | None:
        async with self._conn() as db, db.execute(
            "SELECT value FROM app_settings WHERE key = ?", (key,),
        ) as cur:
            row = await cur.fetchone()
        return row["value"] if row else default

    async def set_setting(self, key: str, value: str) -> None:
        async with self._conn() as db:
            await db.execute(
                "INSERT INTO app_settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
            await db.commit()

    # ---- connection helper ---------------------------------------------------

    @asynccontextmanager
    async def _conn(self) -> AsyncIterator[aiosqlite.Connection]:
        db = await aiosqlite.connect(self.db_path)
        try:
            db.row_factory = aiosqlite.Row
            await db.execute("PRAGMA journal_mode=WAL")
            await db.execute("PRAGMA synchronous=NORMAL")
            await db.execute("PRAGMA foreign_keys=ON")
            # Explicit busy timeout so short write-lock contention (e.g. the
            # retention purge) waits instead of failing the writer flush.
            await db.execute("PRAGMA busy_timeout=5000")
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
            # Ensure the group row exists so the operator can toggle it later.
            await db.execute(
                "INSERT OR IGNORE INTO groups (name, enabled, collapsed) VALUES (?, 1, 0)",
                (group_name,),
            )
            cur = await db.execute(
                "INSERT INTO hosts (name, address, group_name, interval_s, enabled) "
                "VALUES (?, ?, ?, ?, ?)",
                (name, address, group_name, interval_s, int(enabled)),
            )
            await db.commit()
            host_id = cur.lastrowid
        assert host_id is not None  # successful INSERT always sets lastrowid
        host = await self.get_host(host_id)
        assert host is not None
        return host

    # ---- groups --------------------------------------------------------------

    async def list_groups(self) -> list[Group]:
        # Auto-create rows for any group_name in hosts that doesn't have one yet
        # (defensive — covers DBs that pre-date the groups table).
        async with self._conn() as db:
            await db.execute(
                "INSERT OR IGNORE INTO groups (name, enabled, collapsed) "
                "SELECT DISTINCT group_name, 1, 0 FROM hosts"
            )
            await db.commit()
            async with db.execute(
                "SELECT g.name, g.enabled, g.collapsed FROM groups g "
                "ORDER BY g.name"
            ) as cur:
                rows = await cur.fetchall()
        return [Group(name=r["name"], enabled=bool(r["enabled"]),
                      collapsed=bool(r["collapsed"])) for r in rows]

    async def get_group(self, name: str) -> Group | None:
        async with self._conn() as db, db.execute(
            "SELECT name, enabled, collapsed FROM groups WHERE name = ?", (name,),
        ) as cur:
            row = await cur.fetchone()
        if row is None:
            return None
        return Group(name=row["name"], enabled=bool(row["enabled"]),
                     collapsed=bool(row["collapsed"]))

    async def update_group(
        self, name: str, *, enabled: bool | None = None, collapsed: bool | None = None
    ) -> Group | None:
        sets: list[str] = []
        vals: list[Any] = []
        if enabled is not None:
            sets.append("enabled = ?")
            vals.append(int(enabled))
        if collapsed is not None:
            sets.append("collapsed = ?")
            vals.append(int(collapsed))
        if not sets:
            return await self.get_group(name)
        vals.append(name)
        async with self._conn() as db:
            # upsert: if row missing, create it with the provided values.
            await db.execute(
                "INSERT OR IGNORE INTO groups (name, enabled, collapsed) "
                "VALUES (?, 1, 0)", (name,),
            )
            await db.execute(f"UPDATE groups SET {', '.join(sets)} WHERE name = ?", vals)
            await db.commit()
        return await self.get_group(name)

    async def rename_group(self, old_name: str, new_name: str) -> Group | None:
        new_name = new_name.strip()
        if not new_name:
            raise ValueError("group name must not be empty")
        if old_name == new_name:
            return await self.get_group(old_name)
        async with self._conn() as db:
            await db.execute("BEGIN IMMEDIATE")
            async with db.execute(
                "SELECT name, enabled, collapsed FROM groups WHERE name = ?", (old_name,),
            ) as cur:
                old = await cur.fetchone()
            if old is None:
                return None
            async with db.execute(
                "SELECT 1 FROM groups WHERE name = ?", (new_name,),
            ) as cur:
                if await cur.fetchone() is not None:
                    raise ValueError("target group already exists")

            await db.execute(
                "INSERT INTO groups (name, enabled, collapsed) VALUES (?, ?, ?)",
                (new_name, old["enabled"], old["collapsed"]),
            )
            await db.execute(
                "UPDATE hosts SET group_name = ? WHERE group_name = ?",
                (new_name, old_name),
            )
            await db.execute(
                "UPDATE group_cidrs SET group_name = ? WHERE group_name = ?",
                (new_name, old_name),
            )
            await db.execute(
                "UPDATE dismissed_suggestions SET group_name = ? WHERE group_name = ?",
                (new_name, old_name),
            )
            await db.execute("DELETE FROM groups WHERE name = ?", (old_name,))
            await db.commit()
        return await self.get_group(new_name)

    async def delete_group(self, name: str) -> list[int] | None:
        async with self._conn() as db:
            async with db.execute("SELECT 1 FROM groups WHERE name = ?", (name,)) as cur:
                if await cur.fetchone() is None:
                    return None
            async with db.execute("SELECT id FROM hosts WHERE group_name = ?", (name,)) as cur:
                host_ids = [r["id"] for r in await cur.fetchall()]
            await db.execute("DELETE FROM hosts WHERE group_name = ?", (name,))
            await db.execute("DELETE FROM group_cidrs WHERE group_name = ?", (name,))
            await db.execute("DELETE FROM dismissed_suggestions WHERE group_name = ?", (name,))
            await db.execute("DELETE FROM groups WHERE name = ?", (name,))
            await db.commit()
        return host_ids

    async def list_group_cidrs(self, group_name: str) -> list[str]:
        async with (
            self._conn() as db,
            db.execute(
                "SELECT cidr FROM group_cidrs WHERE group_name = ? ORDER BY cidr",
                (group_name,),
            ) as cur,
        ):
            return [r["cidr"] for r in await cur.fetchall()]

    async def add_group_cidr(self, group_name: str, cidr: str) -> None:
        async with self._conn() as db:
            await db.execute(
                "INSERT OR IGNORE INTO groups (name, enabled, collapsed) VALUES (?, 1, 0)",
                (group_name,),
            )
            await db.execute(
                "INSERT OR IGNORE INTO group_cidrs (group_name, cidr) VALUES (?, ?)",
                (group_name, cidr),
            )
            await db.commit()

    async def delete_group_cidr(self, group_name: str, cidr: str) -> bool:
        async with self._conn() as db:
            cur = await db.execute(
                "DELETE FROM group_cidrs WHERE group_name = ? AND cidr = ?",
                (group_name, cidr),
            )
            await db.commit()
            return cur.rowcount > 0

    async def all_group_cidrs(self) -> dict[str, list[str]]:
        """Group-name → list of CIDR strings, for suggestion compute."""
        async with (
            self._conn() as db,
            db.execute(
                "SELECT group_name, cidr FROM group_cidrs ORDER BY group_name, cidr"
            ) as cur,
        ):
            rows = await cur.fetchall()
        out: dict[str, list[str]] = {}
        for r in rows:
            out.setdefault(r["group_name"], []).append(r["cidr"])
        return out

    async def list_dismissed(self) -> set[tuple[int, str]]:
        async with (
            self._conn() as db,
            db.execute("SELECT host_id, group_name FROM dismissed_suggestions") as cur,
        ):
            return {(r["host_id"], r["group_name"]) for r in await cur.fetchall()}

    async def dismiss_suggestion(self, host_id: int, group_name: str) -> None:
        async with self._conn() as db:
            await db.execute(
                "INSERT OR IGNORE INTO dismissed_suggestions (host_id, group_name) VALUES (?, ?)",
                (host_id, group_name),
            )
            await db.commit()

    async def undismiss_suggestion(self, host_id: int, group_name: str) -> bool:
        async with self._conn() as db:
            cur = await db.execute(
                "DELETE FROM dismissed_suggestions WHERE host_id = ? AND group_name = ?",
                (host_id, group_name),
            )
            await db.commit()
            return cur.rowcount > 0

    async def disabled_group_names(self) -> set[str]:
        async with self._conn() as db, db.execute(
            "SELECT name FROM groups WHERE enabled = 0"
        ) as cur:
            rows = await cur.fetchall()
        return {r["name"] for r in rows}

    # ---- hosts (continued) ---------------------------------------------------

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
            params.append(_query_ts(since))
        if until is not None:
            sql += " AND ts <= ?"
            params.append(_query_ts(until))
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
        try:
            async with self._conn() as db:
                if samples:
                    await self._insert_samples(db, samples)
                if events:
                    await self._insert_events(db, events)
                await db.commit()
        except sqlite3.IntegrityError:
            # FK violation: a host was deleted while its rows were still
            # buffered. The batched executemany aborts wholesale, which used
            # to poison the entire batch (other hosts' samples included) and
            # drop it after 2 re-queues — fall back to per-row inserts and
            # skip only the violating rows (audit fix).
            try:
                dropped = await self._insert_skipping_violations(samples, events)
            except Exception:
                # The fallback itself failed transiently → normal retry path.
                await self._on_flush_failure(samples, events)
                return
            if dropped:
                logging.getLogger(__name__).warning(
                    "flush hit FK violations; dropped %d orphaned rows, kept %d",
                    dropped, len(samples) + len(events) - dropped,
                )
        except Exception:
            await self._on_flush_failure(samples, events)
            return
        # success
        self._flush_failures = 0

    async def _on_flush_failure(self, samples: list[Sample], events: list[Event]) -> None:
        # Transient errors (e.g. database locked) → re-queue once. Persistent
        # errors → drop the bad batch with a loud log so the writer cannot be
        # poisoned (Final audit GPT). Must be called from an except block.
        self._flush_failures += 1
        log = logging.getLogger(__name__)
        if self._flush_failures <= 2:
            log.exception("flush failed (attempt %d); re-queueing buffer",
                          self._flush_failures)
            async with self._buf_lock:
                self._sample_buf = samples + self._sample_buf
                self._event_buf = events + self._event_buf
        else:
            log.exception(
                "flush failed %dx in a row; DROPPING %d samples + %d events to "
                "unblock the writer. Investigate immediately.",
                self._flush_failures, len(samples), len(events),
            )
            self._flush_failures = 0

    async def _insert_skipping_violations(
        self, samples: list[Sample], events: list[Event]
    ) -> int:
        """Per-row insert fallback: skip FK-violating rows, keep the rest.

        Returns the number of dropped rows."""
        dropped = 0
        async with self._conn() as db:
            for s in samples:
                try:
                    await db.execute(_SAMPLES_INSERT_SQL, _sample_params(s))
                except sqlite3.IntegrityError:
                    dropped += 1
            for e in events:
                try:
                    await db.execute(_EVENTS_INSERT_SQL, _event_params(e))
                except sqlite3.IntegrityError:
                    dropped += 1
            await db.commit()
        return dropped

    @staticmethod
    async def _insert_samples(db: aiosqlite.Connection, samples: Iterable[Sample]) -> None:
        await db.executemany(_SAMPLES_INSERT_SQL, [_sample_params(s) for s in samples])

    @staticmethod
    async def _insert_events(db: aiosqlite.Connection, events: Iterable[Event]) -> None:
        await db.executemany(_EVENTS_INSERT_SQL, [_event_params(e) for e in events])

    async def purge(self, *, sample_days: int, event_days: int) -> tuple[int, int]:
        """Delete samples older than ``sample_days`` and events older than
        ``event_days``. Returns ``(samples_deleted, events_deleted)``."""
        now = datetime.now(UTC)
        sample_cutoff = (now - timedelta(days=sample_days)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        event_cutoff = (now - timedelta(days=event_days)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        deleted_samples = await self._purge_table("samples", sample_cutoff)
        deleted_events = await self._purge_table("events", event_cutoff)
        return deleted_samples, deleted_events

    async def _purge_table(self, table: str, cutoff: str) -> int:
        """Chunked retention delete.

        A single huge DELETE can hold the write lock past the busy timeout
        and starve the writer into its batch-drop path (audit fix). The
        rowid-subquery form is used because ``DELETE ... LIMIT`` requires
        SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which bundled builds often lack.
        ``table`` is an internal constant, never user input."""
        deleted = 0
        async with self._conn() as db:
            while True:
                cur = await db.execute(
                    f"DELETE FROM {table} WHERE rowid IN "
                    f"(SELECT rowid FROM {table} WHERE ts < ? LIMIT ?)",
                    (cutoff, PURGE_CHUNK_ROWS),
                )
                await db.commit()  # release the write lock between chunks
                deleted += cur.rowcount
                if cur.rowcount < PURGE_CHUNK_ROWS:
                    break
        return deleted
