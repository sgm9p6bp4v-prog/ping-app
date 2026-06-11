"""API tests for the group-CIDR + move-suggestion feature.

Covers /api/groups/{name}/cidrs (GET/POST/DELETE), /api/suggestions,
/api/suggestions/accept and /api/suggestions/dismiss.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from netping.api import router
from netping.app import CSRFGuardMiddleware
from netping.store import Store
from netping.ws import WebSocketHub


@pytest.fixture
async def app(tmp_path: Path) -> AsyncIterator[FastAPI]:
    a = FastAPI()
    a.add_middleware(CSRFGuardMiddleware)
    store = Store(tmp_path / "ping.db", flush_interval_s=0.05)
    await store.open()
    store.start_writer()
    a.state.store = store
    a.state.hub = WebSocketHub()
    a.state.reconcile_lock = asyncio.Lock()
    a.include_router(router)
    yield a
    await store.close()


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"X-Requested-With": "fetch"},
    ) as c:
        yield c


async def _create_host(
    client: AsyncClient, name: str, address: str, group: str = "default"
) -> dict:
    r = await client.post(
        "/api/hosts", json={"name": name, "address": address, "group_name": group}
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _add_cidr(client: AsyncClient, group: str, cidr: str) -> dict:
    r = await client.post(f"/api/groups/{group}/cidrs", json={"cidr": cidr})
    assert r.status_code == 201, r.text
    return r.json()


# --- CIDR CRUD ----------------------------------------------------------------


async def test_cidrs_empty_for_new_group(client: AsyncClient) -> None:
    await _create_host(client, "x", "10.0.0.1", group="lan")
    r = await client.get("/api/groups/lan/cidrs")
    assert r.status_code == 200
    assert r.json() == []


async def test_add_and_list_cidrs(client: AsyncClient) -> None:
    await _add_cidr(client, "lan", "10.0.0.0/24")
    await _add_cidr(client, "lan", "192.168.1.0/24")
    r = await client.get("/api/groups/lan/cidrs")
    assert r.status_code == 200
    assert r.json() == ["10.0.0.0/24", "192.168.1.0/24"]


async def test_add_cidr_normalizes_host_bits(client: AsyncClient) -> None:
    body = await _add_cidr(client, "lan", "10.0.0.5/24")
    assert body["cidr"] == "10.0.0.0/24"
    r = await client.get("/api/groups/lan/cidrs")
    assert r.json() == ["10.0.0.0/24"]


async def test_add_invalid_cidr_422(client: AsyncClient) -> None:
    r = await client.post("/api/groups/lan/cidrs", json={"cidr": "not-a-cidr"})
    assert r.status_code == 422
    r = await client.post("/api/groups/lan/cidrs", json={"cidr": "10.0.0.0/99"})
    assert r.status_code == 422


async def test_add_duplicate_cidr_is_idempotent(client: AsyncClient) -> None:
    await _add_cidr(client, "lan", "10.0.0.0/24")
    await _add_cidr(client, "lan", "10.0.0.0/24")
    assert (await client.get("/api/groups/lan/cidrs")).json() == ["10.0.0.0/24"]


async def test_delete_existing_cidr(client: AsyncClient) -> None:
    await _add_cidr(client, "lan", "10.0.0.0/24")
    r = await client.delete("/api/groups/lan/cidrs", params={"cidr": "10.0.0.0/24"})
    assert r.status_code == 204
    assert (await client.get("/api/groups/lan/cidrs")).json() == []


async def test_delete_unknown_cidr_404(client: AsyncClient) -> None:
    await _add_cidr(client, "lan", "10.0.0.0/24")
    r = await client.delete("/api/groups/lan/cidrs", params={"cidr": "172.16.0.0/12"})
    assert r.status_code == 404
    # original untouched
    assert (await client.get("/api/groups/lan/cidrs")).json() == ["10.0.0.0/24"]


# --- suggestions: compute -------------------------------------------------------


async def test_no_suggestions_without_cidrs(client: AsyncClient) -> None:
    await _create_host(client, "a", "10.0.0.5", group="misc")
    r = await client.get("/api/suggestions")
    assert r.status_code == 200
    assert r.json() == []


async def test_host_matching_foreign_cidr_yields_suggestion(client: AsyncClient) -> None:
    await _add_cidr(client, "lan", "10.0.0.0/24")
    await _add_cidr(client, "dmz", "192.168.50.0/24")
    host = await _create_host(client, "printer", "10.0.0.42", group="misc")

    suggestions = (await client.get("/api/suggestions")).json()
    assert len(suggestions) == 1
    s = suggestions[0]
    assert s["suggested_group"] == "lan"
    assert s["host"]["id"] == host["id"]
    assert s["host"]["address"] == "10.0.0.42"


async def test_host_already_in_matching_group_not_suggested(client: AsyncClient) -> None:
    await _add_cidr(client, "lan", "10.0.0.0/24")
    await _create_host(client, "printer", "10.0.0.42", group="lan")
    assert (await client.get("/api/suggestions")).json() == []


async def test_hostname_addresses_skipped(client: AsyncClient) -> None:
    await _add_cidr(client, "lan", "10.0.0.0/24")
    await _create_host(client, "nas", "nas.local", group="misc")
    assert (await client.get("/api/suggestions")).json() == []


async def test_host_not_in_any_cidr_not_suggested(client: AsyncClient) -> None:
    await _add_cidr(client, "lan", "10.0.0.0/24")
    await _create_host(client, "ext", "203.0.113.7", group="misc")
    assert (await client.get("/api/suggestions")).json() == []


async def test_one_suggestion_per_host_even_with_two_matching_groups(
    client: AsyncClient,
) -> None:
    # both foreign groups' CIDRs contain 10.0.0.42
    await _add_cidr(client, "lan", "10.0.0.0/24")
    await _add_cidr(client, "wide", "10.0.0.0/16")
    await _create_host(client, "printer", "10.0.0.42", group="misc")

    suggestions = (await client.get("/api/suggestions")).json()
    assert len(suggestions) == 1
    assert suggestions[0]["suggested_group"] in {"lan", "wide"}


async def test_suggestions_for_multiple_hosts(client: AsyncClient) -> None:
    await _add_cidr(client, "lan", "10.0.0.0/24")
    await _create_host(client, "a", "10.0.0.1", group="misc")
    await _create_host(client, "b", "10.0.0.2", group="misc")
    await _create_host(client, "c", "203.0.113.1", group="misc")

    suggestions = (await client.get("/api/suggestions")).json()
    assert len(suggestions) == 2
    assert all(s["suggested_group"] == "lan" for s in suggestions)


# --- suggestions: dismiss -------------------------------------------------------


async def test_dismiss_removes_suggestion(client: AsyncClient) -> None:
    await _add_cidr(client, "lan", "10.0.0.0/24")
    host = await _create_host(client, "printer", "10.0.0.42", group="misc")
    assert len((await client.get("/api/suggestions")).json()) == 1

    r = await client.post(
        "/api/suggestions/dismiss",
        json={"host_id": host["id"], "group_name": "lan"},
    )
    assert r.status_code == 204
    assert (await client.get("/api/suggestions")).json() == []


async def test_dismiss_is_scoped_to_one_group(client: AsyncClient) -> None:
    """Dismissing the (host, lan) pair must not swallow a later suggestion for
    a different group."""
    await _add_cidr(client, "lan", "10.0.0.0/24")
    await _add_cidr(client, "wide", "10.0.0.0/16")
    host = await _create_host(client, "printer", "10.0.0.42", group="misc")

    # dismiss both candidate groups one by one → suggestions drain to empty
    await client.post(
        "/api/suggestions/dismiss", json={"host_id": host["id"], "group_name": "lan"}
    )
    remaining = (await client.get("/api/suggestions")).json()
    assert [s["suggested_group"] for s in remaining] == ["wide"]
    await client.post(
        "/api/suggestions/dismiss", json={"host_id": host["id"], "group_name": "wide"}
    )
    assert (await client.get("/api/suggestions")).json() == []


# --- suggestions: accept --------------------------------------------------------


async def test_accept_moves_host_and_clears_suggestion(client: AsyncClient) -> None:
    await _add_cidr(client, "lan", "10.0.0.0/24")
    host = await _create_host(client, "printer", "10.0.0.42", group="misc")

    r = await client.post(
        "/api/suggestions/accept",
        json={"host_id": host["id"], "group_name": "lan"},
    )
    assert r.status_code == 200
    assert r.json()["group_name"] == "lan"

    moved = (await client.get(f"/api/hosts/{host['id']}")).json()
    assert moved["group_name"] == "lan"
    assert (await client.get("/api/suggestions")).json() == []


async def test_accept_unknown_host_404(client: AsyncClient) -> None:
    await _add_cidr(client, "lan", "10.0.0.0/24")
    r = await client.post(
        "/api/suggestions/accept", json={"host_id": 9999, "group_name": "lan"}
    )
    assert r.status_code == 404


async def test_accept_unknown_group_404(client: AsyncClient) -> None:
    host = await _create_host(client, "printer", "10.0.0.42", group="misc")
    r = await client.post(
        "/api/suggestions/accept",
        json={"host_id": host["id"], "group_name": "no-such-group"},
    )
    assert r.status_code == 404


async def test_group_delete_drops_its_cidrs(client: AsyncClient) -> None:
    await _add_cidr(client, "lan", "10.0.0.0/24")
    await _create_host(client, "keeper", "10.0.0.42", group="misc")
    assert len((await client.get("/api/suggestions")).json()) == 1

    r = await client.delete("/api/groups/lan")
    assert r.status_code == 204
    # CIDRs went with the group → no suggestions left
    assert (await client.get("/api/suggestions")).json() == []
