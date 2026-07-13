# LLM Context — client--francesco-ping-app

> Version: 2.0.2 — Dokumentationsreview 2026-07-13

## Purpose / Was ist das?
Fremd-Repo eines Kollegen (Francesco): **ping.me** — server-residentes LAN-Ping-Dashboard
(bis /24, air-gapped Zielumgebung). Wir wurden eingeladen Code zuzuliefern.
Unser Repo ist ein Arbeits-Clone — Francescos `origin` bleibt Single Source of Truth.

## Was ist es NICHT?
- Kein Kundenprojekt im klassischen Sinne (kein Vertrag, kein Deploy bei uns).
- Keine Edge-Integration, keine Woodpecker-Pipeline, kein eigener Health-Endpoint.
- Kein Cross-Repo-Coupling mit unserer Fleet — depends_on bewusst leer.

## Architektur (Stand 2026-06-11)
- **Backend** `src/netping/`: FastAPI + aiosqlite (WAL, gepufferter Sample-Writer),
  `pinger.py` (asyncio-Scheduler, ein Loop pro Host, Semaphor-Limit),
  `ws.py` (WebSocketHub mit Per-Client-Send-Timeout + Origin-Check),
  `monitoring.py` (Start/Stop, Duration-/Packet-Limits), `network.py` (Interface-Discovery,
  via `asyncio.to_thread` von async-Handlern entkoppelt).
- **Frontend** `static/`: Vanilla-ES-Module, Store/Subscriber mit rAF-koaleszierten Renders,
  `bubble-physics.js` (RAF-Engine, aus dashboard.js extrahiert), shared `util.js` (escapeHtml).
  Cache-Busting NUR am Entry-Point (`/js/app.js?v=N`) — nie an Inter-Modul-Imports
  (sonst doppelte Modul-Instanziierung!).
- **Deployment**: Offline-Bundle (`tools/build_bundle.sh` → tar mit Wheels + `--require-hashes`),
  `install.sh` + systemd-Unit (gehärtet, AmbientCapabilities=CAP_NET_RAW), Docker/Compose,
  seit ad51e98 auch native macOS-(launchd)- und Windows-(USB)-Pfade von Francesco.
- **Tests** `tests/`: pytest, asyncio_mode=auto, filterwarnings=error. 139 Tests.
  Sync via Poll-until-Condition, nicht fixe Sleeps.

## Setup

- Entwicklung erfolgt in einer Repo-lokalen `.venv`; `make install-dev` installiert
  den gesperrten Dev-Stand, `make test` und `make lint` prüfen ihn.
- Die Zielumgebung ist ein kundenseitiger, air-gapped Linux-Server. Das Bundle wird
  auf einem freigegebenen Online-Buildhost erzeugt, anschließend mit
  `tools/verify_bundle_offline.sh` strukturell geprüft und offline übertragen.
- `install.sh` benötigt root, Python 3.11+ samt `venv`/`ensurepip` sowie ein zum
  Bundle passendes Python-Minor-Release.
- Bundle-Erzeugung lädt Wheels und ist deshalb kein still auszuführender
  Standardcheck; dafür gilt ein explizites Download-/Freigabe-Gate.

## Betrieb

- Varga betreibt keine Live-Instanz. Installation, systemd-Service und Daten liegen
  in Francescos Zielumgebung; `origin` bleibt die externe Code-SSOT.
- Standardpfade sind `/opt/ping-app`, `/var/lib/ping-app` und `/etc/ping-app`.
  SQLite-Daten unter `/var/lib/ping-app` müssen kundenseitig gesichert werden.
- Der Dienst startet Monitoring bewusst pausiert. Start/Stop erfolgt über UI/API,
  nicht durch unkontrollierten Dauer-Ping.
- Kanonische Installation, Health-Prüfung und Rollback stehen in
  `00_infos/runbooks/customer-operations.md`.

## Schnittstellen

- HTTP-UI und REST-API am konfigurierten `PING_BIND_HOST:PING_PORT`.
- `GET /api/info` für Laufzeitinformationen; Monitoring-/Host-/Gruppen-Endpunkte
  liegen unter `/api/`.
- WebSocket `/ws` liefert Live-Status an Browser desselben Origins; zusätzliche
  Origins müssen explizit über `PING_CORS_ORIGINS` erlaubt werden.
- ICMP benötigt auf Linux die im systemd-Unit dokumentierte `CAP_NET_RAW`-Fähigkeit.

## Rework 2026-06-11 (Branch feat/varga-fable-rework-christoph)
Umfassender Review + Fixpack auf Basis ad51e98. Highlights:
- **install.sh kritisch:** Wheel-Tag-Sentinel (`cp311` → fälschlich „3.111") gefixt —
  vorher brach JEDE Offline-Installation ab.
- systemd-Unit Ubuntu-22.04-kompatibel (`${VAR:-}` erst ab systemd 250), venv/ensurepip-Precheck,
  Lockfile mit Hashes, deterministisches Bundle ohne `__pycache__`.
- Backend: Flush-Batch-Vergiftung bei Host-Delete, start/reconcile-Race (doppelte Ping-Loops),
  Outage-State überlebt Task-Restarts, gechunkte Purges, WS-Origin-Check.
- Frontend: Gruppen-Collapse funktioniert (Structure-Render bei collapsed-Änderung),
  `?v=`-Import-Doppelinstanziierung beseitigt, WS-Reconnect-Resync (Groups/Suggestions/Monitoring),
  Offline erst ab 3 Fail-Streak, totes Chart.js entfernt (~200 KB).
- Tests: +65 (WS/Lifespan, Config, Suggestions/CIDR, Flush-Failures, Outage-State, WS-Origin).

## Arbeitsmodus
- Branches: `feat/varga-*`, `fix/varga-*` (klar als externer Beitrag markiert).
- Push auf `main`: NUR via PR und nach Francescos Freigabe.
- Lokales LLM-Tooling (AGENTS.md, .gemini/, .opencode/) ist gitignored — nie committen.

## Offene Punkte
Siehe `meta/open-questions.md` — insbesondere HOLD-VM (echter Offline-Install-Test in Linux-VM
steht aus; testet jetzt auch `--require-hashes`).
