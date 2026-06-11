"""REST CRUD for hosts + history + meta endpoints.

WebSocket broadcasts of CRUD events are emitted via the ``WebSocketHub`` so
all connected browsers stay in sync (PRD §4.5).
"""

from __future__ import annotations

import asyncio
import ipaddress
import platform
import re
import socket
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Body, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, field_validator

from . import __version__, network
from .store import Host, Store
from .ws import WebSocketHub

# RFC 1123 hostname (lenient) — labels of 1..63 chars, dots between.
_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)"
    r"(\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$"
)

# Hard caps to prevent DoS via unbounded queries.
HISTORY_MAX_LIMIT = 100_000
EVENTS_MAX_LIMIT = 5_000
# Hard cap on total hosts. PRD §1 sizes for one /24 (254 hosts). Anything more
# would push past designed scheduler/SQLite/WS budgets. Final audit GPT.
HOST_CAP = 254


def _normalize_cidr(value: str) -> str:
    """Normalize a CIDR string to its network form (e.g. "10.0.0.5/24" →
    "10.0.0.0/24"). Shared by the CidrIn validator (add path) and the delete
    endpoint so stored and queried forms always match.

    Raises ValueError on invalid input."""
    try:
        return str(ipaddress.ip_network(value.strip(), strict=False))
    except ValueError as e:
        raise ValueError(f"invalid CIDR {value!r}: {e}") from e


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


class MonitoringStartIn(BaseModel):
    packet_limit: int | None = Field(default=None, ge=1, le=1000)


MONITORING_START_BODY = Body()


class NetworkInterfacePatch(BaseModel):
    name: str = Field(min_length=1, max_length=80)


def _store(request: Request) -> Store:
    return request.app.state.store


def _hub(request: Request) -> WebSocketHub:
    return request.app.state.hub


def _detect_lan_ip() -> str:
    """UDP-probe trick to find the routable LAN IP without sending traffic."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "unavailable"
    finally:
        s.close()


router = APIRouter()


def _monitoring(request: Request):
    return request.app.state.monitoring


@router.get("/api/monitoring")
async def monitoring_status(request: Request) -> dict[str, Any]:
    return _monitoring(request).status()


@router.post("/api/monitoring/start")
async def monitoring_start(
    request: Request,
    payload: Annotated[MonitoringStartIn | None, MONITORING_START_BODY] = None,
) -> dict[str, Any]:
    if payload is None:
        return await _monitoring(request).start()
    return await _monitoring(request).start(packet_limit=payload.packet_limit)


@router.post("/api/monitoring/stop")
async def monitoring_stop(request: Request) -> dict[str, Any]:
    return await _monitoring(request).stop()


@router.get("/api/info")
async def info(request: Request) -> dict[str, Any]:
    selected_interface = await _store(request).get_setting("ping_interface", "auto")
    return {
        "version": __version__,
        "ts": datetime.now(UTC).isoformat(timespec="seconds"),
        "hostname": socket.gethostname(),
        "lan_ip": _detect_lan_ip(),
        "os": platform.system(),
        "ws_clients": len(_hub(request)),
        "ping_interface": await network.interface_snapshot_async(selected_interface),
    }


# Backward-compat: keep /info for now, alias to /api/info.
@router.get("/info", include_in_schema=False)
async def info_alias(request: Request) -> dict[str, Any]:
    return await info(request)


@router.get("/api/hosts")
async def list_hosts(request: Request) -> list[dict[str, Any]]:
    hosts = await _store(request).list_hosts()
    return [h.to_dict() for h in hosts]


@router.get("/api/network/interfaces")
async def network_interfaces(request: Request) -> dict[str, Any]:
    selected = await _store(request).get_setting("ping_interface", "auto")
    return await network.interface_snapshot_async(selected)


@router.patch("/api/network/interface")
async def patch_network_interface(
    payload: NetworkInterfacePatch, request: Request
) -> dict[str, Any]:
    selected = network.normalize_interface_selection(payload.name)
    interfaces = await network.list_network_interfaces_async()
    available = {iface.name for iface in interfaces}
    if selected != network.AUTO_INTERFACE and selected not in available:
        raise HTTPException(status_code=422, detail="network interface not available")
    await _store(request).set_setting("ping_interface", selected)
    ping_interface, ping_source = await network.ping_binding_for_selection_async(selected)
    scheduler = getattr(request.app.state, "scheduler", None)
    if scheduler is not None:
        scheduler.set_ping_interface(ping_interface, source_address=ping_source)
        await _reconcile(request)
    return await network.interface_snapshot_async(selected)


@router.post("/api/hosts", status_code=status.HTTP_201_CREATED)
async def create_host(payload: HostIn, request: Request) -> dict[str, Any]:
    existing = await _store(request).list_hosts()
    if len(existing) >= HOST_CAP:
        raise HTTPException(
            status_code=409,
            detail=f"host cap reached ({HOST_CAP}); delete an existing host or raise the cap",
        )
    h = await _store(request).create_host(**payload.model_dump())
    await _broadcast_host_event(request, "host_created", h)
    await _reconcile(request)
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
    await _reconcile(request)
    return h.to_dict()


@router.delete("/api/hosts/{host_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_host(host_id: int, request: Request) -> None:
    ok = await _store(request).delete_host(host_id)
    if not ok:
        raise HTTPException(status_code=404, detail="host not found")
    await _hub(request).broadcast({"type": "host_deleted", "host_id": host_id})
    await _reconcile(request)


@router.get("/api/hosts/{host_id}/history")
async def history(
    host_id: int,
    request: Request,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = Query(default=10_000, ge=1, le=HISTORY_MAX_LIMIT),
) -> dict[str, Any]:
    if await _store(request).get_host(host_id) is None:
        raise HTTPException(status_code=404, detail="host not found")
    rows = await _store(request).history(host_id, since=since, until=until, limit=limit)
    return {"host_id": host_id, "samples": rows, "count": len(rows)}


class GroupPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    enabled: bool | None = None
    collapsed: bool | None = None


class CidrIn(BaseModel):
    cidr: str = Field(min_length=1, max_length=64)

    @field_validator("cidr")
    @classmethod
    def _validate(cls, v: str) -> str:
        return _normalize_cidr(v)


class SuggestionAction(BaseModel):
    host_id: int = Field(ge=1)
    group_name: str = Field(min_length=1, max_length=80)


async def _compute_suggestions(store: Store) -> list[dict[str, Any]]:
    """For each host whose IP falls in some other group's CIDR, surface a
    move-suggestion unless the operator has dismissed it.

    Hostname addresses (non-IP) are skipped — we don't resolve at runtime.
    """
    hosts = await store.list_hosts()
    cidrs_per_group = await store.all_group_cidrs()
    dismissed = await store.list_dismissed()
    if not cidrs_per_group:
        return []
    # Pre-parse CIDR networks.
    nets_per_group = {
        g: [ipaddress.ip_network(c, strict=False) for c in cs]
        for g, cs in cidrs_per_group.items()
    }
    out: list[dict[str, Any]] = []
    for h in hosts:
        try:
            ip = ipaddress.ip_address(h.address)
        except ValueError:
            continue  # hostname → skip
        for group_name, nets in nets_per_group.items():
            if group_name == h.group_name:
                continue
            if (h.id, group_name) in dismissed:
                continue
            if any(ip in n for n in nets):
                out.append({
                    "host": h.to_dict(),
                    "suggested_group": group_name,
                })
                break  # one suggestion per host is enough
    return out


@router.get("/api/groups")
async def list_groups(request: Request) -> list[dict[str, Any]]:
    return [g.to_dict() for g in await _store(request).list_groups()]


@router.patch("/api/groups/{name}")
async def patch_group(name: str, payload: GroupPatch, request: Request) -> dict[str, Any]:
    fields = {k: v for k, v in payload.model_dump().items() if v is not None}
    new_name = fields.pop("name", None)
    g = None
    if new_name is not None:
        try:
            g = await _store(request).rename_group(name, new_name)
        except ValueError as exc:
            code = 409 if "exists" in str(exc) else 422
            raise HTTPException(status_code=code, detail=str(exc)) from exc
        if g is None:
            raise HTTPException(status_code=404, detail="group not found")
        await _hub(request).broadcast({
            "type": "group_renamed", "old_name": name, "group": g.to_dict(),
        })
        await _reconcile(request)
        name = g.name
    if fields:
        g = await _store(request).update_group(name, **fields)
    elif new_name is None:
        g = await _store(request).update_group(name)
    if g is None:
        raise HTTPException(status_code=404, detail="group not found")
    await _hub(request).broadcast({"type": "group_updated", "group": g.to_dict()})
    # If `enabled` flipped, scheduler must reconcile to start/stop the loops.
    if "enabled" in fields:
        await _reconcile(request)
    return g.to_dict()


@router.delete("/api/groups/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(name: str, request: Request) -> None:
    host_ids = await _store(request).delete_group(name)
    if host_ids is None:
        raise HTTPException(status_code=404, detail="group not found")
    await _hub(request).broadcast({"type": "group_deleted", "name": name})
    for host_id in host_ids:
        await _hub(request).broadcast({"type": "host_deleted", "host_id": host_id})
    await _reconcile(request)


@router.get("/api/groups/{name}/cidrs")
async def list_group_cidrs(name: str, request: Request) -> list[str]:
    return await _store(request).list_group_cidrs(name)


@router.post("/api/groups/{name}/cidrs", status_code=status.HTTP_201_CREATED)
async def add_group_cidr(name: str, payload: CidrIn, request: Request) -> dict[str, Any]:
    await _store(request).add_group_cidr(name, payload.cidr)
    await _hub(request).broadcast({
        "type": "group_cidrs_changed", "group_name": name,
        "cidrs": await _store(request).list_group_cidrs(name),
    })
    return {"group_name": name, "cidr": payload.cidr}


@router.delete("/api/groups/{name}/cidrs", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group_cidr(
    name: str, request: Request, cidr: str = Query(min_length=1, max_length=64)
) -> None:
    # add stores the normalized form (CidrIn validator) — normalize the query
    # param the same way so e.g. "10.0.0.5/24" matches "10.0.0.0/24" (audit fix).
    try:
        cidr = _normalize_cidr(cidr)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    ok = await _store(request).delete_group_cidr(name, cidr)
    if not ok:
        raise HTTPException(status_code=404, detail="cidr not in group")
    await _hub(request).broadcast({
        "type": "group_cidrs_changed", "group_name": name,
        "cidrs": await _store(request).list_group_cidrs(name),
    })


@router.get("/api/suggestions")
async def list_suggestions(request: Request) -> list[dict[str, Any]]:
    return await _compute_suggestions(_store(request))


@router.post("/api/suggestions/accept")
async def accept_suggestion(payload: SuggestionAction, request: Request) -> dict[str, Any]:
    store = _store(request)
    host = await store.get_host(payload.host_id)
    if host is None:
        raise HTTPException(status_code=404, detail="host not found")
    if await store.get_group(payload.group_name) is None:
        raise HTTPException(status_code=404, detail="group not found")
    updated = await store.update_host(payload.host_id, group_name=payload.group_name)
    if updated is None:
        # Host deleted between the existence check above and the update —
        # report 404 instead of crashing with an AssertionError (audit fix).
        raise HTTPException(status_code=404, detail="host not found")
    await _hub(request).broadcast({"type": "host_updated", "host": updated.to_dict()})
    await _reconcile(request)
    return updated.to_dict()


@router.post("/api/suggestions/dismiss", status_code=status.HTTP_204_NO_CONTENT)
async def dismiss_suggestion(payload: SuggestionAction, request: Request) -> None:
    store = _store(request)
    # Validate referents first: inserting an unknown host/group would hit the
    # FK constraint and surface as a 500 instead of a 404 (audit fix).
    if await store.get_host(payload.host_id) is None:
        raise HTTPException(status_code=404, detail="host not found")
    if await store.get_group(payload.group_name) is None:
        raise HTTPException(status_code=404, detail="group not found")
    await store.dismiss_suggestion(payload.host_id, payload.group_name)


@router.get("/api/events")
async def events(
    request: Request,
    host_id: int | None = None,
    limit: int = Query(default=200, ge=1, le=EVENTS_MAX_LIMIT),
) -> list[dict[str, Any]]:
    return await _store(request).events(host_id, limit=limit)


# ---- helpers ---------------------------------------------------------------


async def _broadcast_host_event(request: Request, evt_type: str, host: Host) -> None:
    await _hub(request).broadcast({"type": evt_type, "host": host.to_dict()})


async def _reconcile(request: Request) -> None:
    """Synchronous in-handler reconcile.

    Synchronous because parallel reconciles caused state races (Grumpy audit
    Sprint 2). The lock is created in :func:`netping.app.lifespan` to avoid
    a race when two concurrent first-requests would each lazy-init their own
    lock (Final audit A1).
    """
    scheduler = getattr(request.app.state, "scheduler", None)
    if scheduler is None:
        return
    lock: asyncio.Lock = request.app.state.reconcile_lock
    async with lock:
        store = _store(request)
        hosts = await store.list_hosts()
        disabled = await store.disabled_group_names()
        scheduler.reconcile(hosts, disabled_groups=disabled)
        monitoring = getattr(request.app.state, "monitoring", None)
        if monitoring is not None:
            await monitoring.reconcile_packet_targets(hosts, disabled_groups=disabled)
