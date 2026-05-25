# Implementierungsplan v0.2 — NetPing Dashboard

**PT-Definition:** 1 PT = ein Person-Tag mit ca. 6h fokussierter Entwicklungsarbeit.  
**Verdikt:** v0.2 ist kein kleines Desktop-Tool mehr. Realistisch sind 5 Sprints / 18-25 PT, plus Abnahme auf Zielserver.

## A. Sprint-Aufteilung

| Sprint | Größe | Ziel | Deliverables | PT | Voraussetzungen | Definition of Done |
|---|---:|---|---|---:|---|---|
| 1 — Baseline + Tooling | S | Ist-Verhalten absichern, bevor refactored wird | `pytest`, `ruff`, `black`, `pre-commit`; Parser-Charakterisierungstests; Smoke-Test fuer Prototyp; Grundstruktur | 2-3 | Prototyp/Zip lauffaehig oder klar dokumentiert, warum nicht | Parser-Golden-Tests gruen; `pytest` laeuft lokal; keine Refactor-Änderung ohne Testnetz |
| 2 — Backend-Core | L | FastAPI-App, SQLite, Pinger, WS-Hub als tragfähiger Kern | `src/netping/app.py`, `api.py`, `config.py`, `parser.py`, `pinger.py`, `store.py`, `ws.py`; CRUD; History; WAL; Batch-Insert; Retention | 6-8 | Sprint 1 gruen | API-Tests gruen; 50 Mock-Hosts laufen 10 min ohne Lock-Errors; Restart erhaelt Hosts/History |
| 3 — Frontend Dashboard | M | Gruppen-Dashboard, Drill-Down, Editor, Live-Sync | `static/index.html`, `static/css/app.css`, `static/js/{app,dashboard,drilldown,editor,i18n}.js`; Chart.js; WS-Reconnect; EN/IT JSON | 4-5 | Backend-API/WS-Vertrag stabil | Zwei Browser-Tabs syncen CRUD sofort; Reload bewahrt Sprache/Theme; 50 Hosts bleiben bedienbar |
| 4 — Load + Linux Deploy | M | Zielbetrieb unter Linux/systemd beweisen | `deploy/ping-app.service`, Install-Doku, Env-Beispiele, Load-Profil, ICMP-Capability-Test | 3-5 | Linux-Testpfad verfügbar: VM, Zielserver oder Docker-Fallback fuer Mock-Load | systemd startet App; `journalctl` brauchbar; 50 Hz Insert-Test bestanden; ICMP-Rechte dokumentiert/verifiziert |
| 5 — Hardening + Abnahme | M | v1 abnahmefähig machen | Input-Validation, CORS/LAN-Konfig, Fehlerzustände, README, Fixtures, Beispiel-DB, manuelle QA | 3-4 | Sprints 2-4 integriert | Alle Akzeptanzkriterien geprüft; README Setup <10 min; offene HOLDs explizit dokumentiert |

## B. Reihenfolge und kritischer Pfad

Zwingend ist: **Sprint 1 → Sprint 2 → Sprint 3/4 → Sprint 5**.

Der kritische Pfad liegt im Backend: Parser-Tests vor Refactor, danach Store/Pinger/WS-Vertrag. Ohne stabilen Event- und API-Vertrag baut das Frontend auf Sand.

Teilweise frei parallelisierbar:
- Sprint 3 kann starten, sobald Mock-API/WS-Contract aus Sprint 2 steht.
- Sprint 4 kann parallel zu Sprint 3 laufen, wenn Backend-Core lauffähig ist.
- Design-CSS kann parallel zum Backend entstehen, aber nicht die Host-Editor-Logik.

Nicht frei:
- Refactor vor Charakterisierungstests ist gesperrt.
- Load-/Deploy-Abnahme ohne echten oder VM-basierten Linux-Pfad ist blind.
- Sprint 5 erst nach integrierter UI + Backend.

## C. Risiken und Mitigation

| Risiko | Impact | Mitigation |
|---|---|---|
| macOS-Dev, Linux-only-Deploy | systemd/ICMP-Verhalten wird lokal nicht erkannt | Ubuntu/Debian-VM oder Zielserver-Test als Gate in Sprint 4; Docker nur fuer Mock-Load, nicht als Deploy-Beweis |
| 50 Hosts × 1 Hz erzeugen 50 Inserts/s | SQLite-Locks, UI-Lag | Async-Queue, Batch-Insert alle 500ms, WAL, Index `(host_id, ts)`, Load-Test mit synthetischen Samples |
| ICMP-Capabilities unter systemd | Pings schlagen im Service fehl | `AmbientCapabilities=CAP_NET_RAW`, `NoNewPrivileges=false` prüfen; Fallback: system-`ping` mit vorhandenen setuid/cap-Rechten |
| Subprocess-Storm | CPU/FD-Druck | `asyncio.Semaphore`, Timeouts, gestaffelter Scheduler statt exakt gleicher Takt |
| Francesco lehnt Editorial Brutalist ab | Rework im Frontend | Vor Sprint 3 als HOLD klären: Designwechsel schriftlich akzeptiert oder UI-Sprint stoppen |
| Offene Scope-/Lizenz-Rueckspiegelung | Erwartungsbruch | Scope-Sprung und Lizenz vor öffentlichem Release klären; Lizenz kein Sprint-Blocker fuer private v1 |
| WS-Reconnect-Storm | Restart erzeugt Lastspitze | Exponential Backoff + Jitter; Snapshot nach Reconnect |
| LAN-trust ohne Auth | Jeder im LAN kann Hosts ändern | Im README klar markieren; Host-Input strikt validieren; optional Reverse-Proxy-Hinweis, aber nicht v1 bauen |

## D. Cross-Cutting Tasks

Repo-Struktur:

```text
src/netping/
  app.py
  api.py
  config.py
  parser.py
  pinger.py
  store.py
  ws.py
static/
  index.html
  css/app.css
  js/app.js
  js/dashboard.js
  js/drilldown.js
  js/editor.js
  js/i18n.js
  i18n/en.json
  i18n/it.json
tests/
  test_parser.py
  test_api_hosts.py
  test_store.py
  test_pinger_mock.py
  fixtures/ping_outputs/
  fixtures/hosts.json
migrations/
  001_init.sql
deploy/
  ping-app.service
  env.example
data/
  .gitkeep
```

Tooling:
- `pyproject.toml` fuer pytest/ruff/black.
- `pre-commit-config.yaml`.
- Test-DB per tempfile, keine Tests gegen `data/ping.db`.
- Fixtures fuer EN/IT/macOS/Linux-`ping`-Outputs und 50-Host-Szenario.

README:
- lokales Setup
- systemd-Install unter `/opt/ping-app`
- Env-Variablen `PING_*`
- ICMP-Capability-Diagnose
- Backup/Restore von `/var/lib/ping-app/ping.db`
- LAN/Security-Hinweis: keine Auth.

## E. Empfehlung

1. **Sprint 1 sofort starten:** Tests und Tooling sind Voraussetzung fuer jeden Refactor.
2. **Sprint 2 danach als Hauptblock:** Backend-Core entscheidet, ob der Scope technisch hält.
3. **Sprint 3 und Sprint 4 parallelisieren:** UI-Skeleton gegen Mock-WS, Linux-Deploy gegen Backend-Core.

HOLD vor voller UI-Ausarbeitung: Francesco muss den Wechsel von Cyberpunk zu Editorial Brutalist akzeptieren.