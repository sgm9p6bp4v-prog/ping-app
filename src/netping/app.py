"""FastAPI app factory + lifespan.

Owns the singletons: ``Store``, ``WebSocketHub``, ``PingScheduler``. The
static SPA (built later in Sprint 3) is mounted at ``/`` from
``static/`` if that directory exists; for Sprint 2 the API is the only
public surface.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from .api import router as api_router
from .config import get_settings
from .monitoring import MonitoringController
from .pinger import PingScheduler
from .store import Store
from .ws import WebSocketHub

# Cheap CSRF defence: every browser fetch() sets X-Requested-With
# (the front-end api.js does — see static/js/api.js). A <form> POST from a
# malicious LAN page cannot set custom headers cross-origin, so requiring this
# header on writes blocks the simplest CSRF vector without needing auth.
# Final audit C1.
WRITE_METHODS = {"POST", "PATCH", "PUT", "DELETE"}


class CSRFGuardMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if (
            request.method in WRITE_METHODS
            and request.url.path.startswith("/api/")
            and request.headers.get("x-requested-with") != "fetch"
        ):
            return JSONResponse(
                status_code=403, content={"detail": "missing X-Requested-With: fetch"}
            )
        return await call_next(request)

log = logging.getLogger("netping")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    store = Store(
        settings.db_path,
        flush_interval_s=settings.write_flush_interval_s,
        flush_max_batch=settings.write_flush_max_batch,
    )
    await store.open()
    store.start_writer()
    hub = WebSocketHub()
    scheduler = PingScheduler(
        store,
        max_concurrent=settings.max_concurrent_pings,
        timeout_s=settings.ping_timeout_s,
        broadcaster=hub.broadcast,
    )
    # Pinger is NOT started here — boots PAUSED. Operator presses START in
    # the UI; MonitoringController handles the 30-min auto-stop timer.
    monitoring = MonitoringController(
        scheduler, hub, duration_s=settings.monitoring_duration_s
    )
    app.state.store = store
    app.state.hub = hub
    app.state.scheduler = scheduler
    app.state.monitoring = monitoring
    # Reconcile lock is created here (not lazily in the API handler) so two
    # concurrent first-requests cannot race-create two separate locks.
    app.state.reconcile_lock = asyncio.Lock()
    # background retention purge
    purge_task = asyncio.create_task(
        _purge_loop(store, settings.sample_retention_days, settings.event_retention_days),
        name="retention-purge",
    )
    try:
        yield
    finally:
        purge_task.cancel()
        await monitoring.shutdown()
        await store.close()


async def _purge_loop(store: Store, sample_days: int, event_days: int) -> None:
    while True:
        try:
            await asyncio.sleep(3600)  # once per hour
            await store.purge(sample_days=sample_days, event_days=event_days)
        except asyncio.CancelledError:
            return
        except Exception:
            log.exception("retention purge failed; continuing")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="NetPing Dashboard", version="0.0.1", lifespan=lifespan)
    app.add_middleware(CSRFGuardMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["X-Requested-With", "Content-Type"],
    )
    app.include_router(api_router)

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        hub: WebSocketHub = app.state.hub
        await hub.connect(ws)
        try:
            # send snapshot of current hosts so reconnecting clients get state
            store: Store = app.state.store
            hosts = await store.list_hosts()
            await hub.snapshot_to(ws, [{"type": "snapshot", "hosts": [h.to_dict() for h in hosts]}])
            while True:
                # client → server is currently empty; keep the connection open
                # and ignore any incoming text/ping frames.
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            await hub.disconnect(ws)

    static_dir = Path(__file__).resolve().parent.parent.parent / "static"
    if static_dir.is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

    return app


app = create_app()
