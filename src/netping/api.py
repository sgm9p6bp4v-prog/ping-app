"""REST CRUD for hosts + history + meta endpoints.

WebSocket broadcasts of CRUD events are emitted via the ``WebSocketHub`` so
all connected browsers stay in sync (PRD §4.5).
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator

from . import __version__
from .store import Host, Store
from .ws import WebSocketHub

# Tasks spawned by _reconcile() must be kept alive (asyncio holds only a weakref).
_BG_TASKS: set[asyncio.Task[None]] = set()

# RFC 1123 hostname (lenient) — labels of 1..63 chars, dots between.
_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)"
    r"(\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$"
)


def _validate_address(value: str) -> str:
    v = value.strip()
    if not v:
        raise ValueError("address must not be empty")
    try:
        ipaddress.ip_address(v)
        return v
    except ValueError:
        pass
    if _HOSTNAME_RE.match(v):
        return v
    raise ValueError(f"address {value!r} is neither a valid IP nor hostname")


class HostIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    address: str = Field(min_length=1, max_length=253)
    group_name: str = Field(default="default", min_length=1, max_length=80)
    interval_s: float = Field(default=1.0, ge=0.2, le=60.0)
    enabled: bool = True

    @field_validator("address")
    @classmethod
    def _addr(cls, v: str) -> str:
        return _validate_address(v)


class HostPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    address: str | None = Field(default=None, min_length=1, max_length=253)
    group_name: str | None = Field(default=None, min_length=1, max_length=80)
    interval_s: float | None = Field(default=None, ge=0.2, le=60.0)
    enabled: bool | None = None

    @field_validator("address")
    @classmethod
    def _addr(cls, v: str | None) -> str | None:
        return None if v is None else _validate_address(v)


def _store(request: Request) -> Store:
    return request.app.state.store


def _hub(request: Request) -> WebSocketHub:
    return request.app.state.hub


router = APIRouter()


@router.get("/info")
async def info(request: Request) -> dict[str, Any]:
    return {
        "version": __version__,
        "ts": datetime.now(UTC).isoformat(timespec="seconds"),
        "ws_clients": len(_hub(request)),
    }


@router.get("/api/hosts")
async def list_hosts(request: Request) -> list[dict[str, Any]]:
    hosts = await _store(request).list_hosts()
    return [h.to_dict() for h in hosts]


@router.post("/api/hosts", status_code=status.HTTP_201_CREATED)
async def create_host(payload: HostIn, request: Request) -> dict[str, Any]:
    h = await _store(request).create_host(**payload.model_dump())
    await _broadcast_host_event(request, "host_created", h)
    _reconcile(request)
    return h.to_dict()


@router.get("/api/hosts/{host_id}")
async def get_host(host_id: int, request: Request) -> dict[str, Any]:
    h = await _store(request).get_host(host_id)
    if h is None:
        raise HTTPException(status_code=404, detail="host not found")
    return h.to_dict()


@router.patch("/api/hosts/{host_id}")
async def patch_host(host_id: int, payload: HostPatch, request: Request) -> dict[str, Any]:
    fields = {k: v for k, v in payload.model_dump().items() if v is not None}
    h = await _store(request).update_host(host_id, **fields)
    if h is None:
        raise HTTPException(status_code=404, detail="host not found")
    await _broadcast_host_event(request, "host_updated", h)
    _reconcile(request)
    return h.to_dict()


@router.delete("/api/hosts/{host_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_host(host_id: int, request: Request) -> None:
    ok = await _store(request).delete_host(host_id)
    if not ok:
        raise HTTPException(status_code=404, detail="host not found")
    await _hub(request).broadcast({"type": "host_deleted", "host_id": host_id})
    _reconcile(request)


@router.get("/api/hosts/{host_id}/history")
async def history(
    host_id: int,
    request: Request,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = 10_000,
) -> dict[str, Any]:
    if await _store(request).get_host(host_id) is None:
        raise HTTPException(status_code=404, detail="host not found")
    rows = await _store(request).history(host_id, since=since, until=until, limit=limit)
    return {"host_id": host_id, "samples": rows, "count": len(rows)}


@router.get("/api/events")
async def events(
    request: Request,
    host_id: int | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    return await _store(request).events(host_id, limit=limit)


# ---- helpers ---------------------------------------------------------------


async def _broadcast_host_event(request: Request, evt_type: str, host: Host) -> None:
    await _hub(request).broadcast({"type": evt_type, "host": host.to_dict()})


def _reconcile(request: Request) -> None:
    scheduler = getattr(request.app.state, "scheduler", None)
    if scheduler is None:
        return

    async def _do() -> None:
        hosts = await _store(request).list_hosts()
        scheduler.reconcile(hosts)

    task = asyncio.create_task(_do(), name="api-reconcile")
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
