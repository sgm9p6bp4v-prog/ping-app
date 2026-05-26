# Implementierungsplan v0.3 — NetPing Dashboard

**PT-Definition:** 1 PT = 6h fokussierte Entwicklungsarbeit.  
**Verdikt:** Air-Gap ist kein reines Deploy-Thema. Es ist Querschnitt ab Sprint 1, braucht aber in Sprint 4 einen eigenen, groesseren Build-/Install-Abnahmeblock. Realistisch: **22-30 PT**.

## A. Sprint-Aufteilung

| Sprint | Groesse | Ziel | Deliverables | PT | Voraussetzungen | DoD |
|---|---:|---|---|---:|---|---|
| 1 — Baseline + Testnetz | S | Ist-Zustand absichern, Refactor vorbereiten | `pytest`, `ruff`, `black`; Parser-Golden-Tests; Smoke-Test; `requirements.in/txt`; Grundstruktur | 2-3 | Prototyp/Zip verfuegbar oder Nicht-Lauffaehigkeit dokumentiert | Parser-Tests gruen; Test-DB via tempfile; kein Refactor ohne Baseline |
| 2 — Backend-Core 254 | L | FastAPI, SQLite, Pinger, WS-Hub fuer /24 tragfaehig bauen | `src/netping/{app,api,config,parser,pinger,store,ws}.py`; CRUD; History; WAL; Batch-Insert; Retention; Scheduler mit Semaphore/Jitter | 7-9 | Sprint 1 gruen | API-/Store-/Pinger-Tests gruen; 254 Mock-Hosts 10 min ohne Lock-Errors; Restart erhaelt Hosts/History |
| 3 — Frontend + Vendoring | M | SPA, Design-System, i18n, lokale Assets | `static/index.html`; `static/css/app.css`; `static/js/*`; `static/i18n/{en,it}.json`; `static/vendor/chart.umd.min.js`; `static/vendor/inter/*.woff2`; Asset-Manifest | 5-6 | Backend-API/WS-Vertrag stabil oder Mock-Contract | Keine CDN-Calls; zwei Tabs syncen CRUD live; Theme/Sprache persistieren; 254 Hosts gruppiert bedienbar |
| 4 — Offline Bundle + Linux Deploy | M/L | Air-gapped Install beweisen | `tools/build_bundle.sh`; `deploy/ping-app.service`; `deploy/env.example`; `install.sh`; `ping-app-<version>.tar.gz`; VM-Smoke-Protokoll | 5-7 | Backend lauffaehig; vendored Assets vorhanden; Lockfile stabil | Install in isolierter Ubuntu/Debian-VM ohne Netzwerk; `pip install --no-index --find-links wheels/`; systemd enable+start; DevTools: 0 externe Requests |
| 5 — Hardening + Abnahme | M | v1 abnahmefaehig machen | Input-Validation; CORS/LAN-Konfig; README; Backup/Restore-Doku; Lastprofil; Akzeptanzcheckliste | 3-5 | Sprints 2-4 integriert | 254 Hosts: CPU/RAM/UI-Latenz gemessen; README Setup <10 min; alle v1-AKs geprueft; offene HOLDs dokumentiert |

**Air-Gap-Bewertung:** Querschnitt, weil Dependencies, Fonts, Chart.js, README und Tests davon betroffen sind. Trotzdem wird Sprint 4 groesser: Bundle-Building, systemd, Offline-VM und manylinux-Kompatibilitaet sind echte Implementierung, nicht nur Packaging.

## B. Reihenfolge / Kritischer Pfad

Zwingend sequenziell:

1. **Tests/Locks vor Refactor:** Parser- und Store-Verhalten zuerst absichern.
2. **Backend-Contract vor echter UI:** REST/WS-Eventformat muss stabil sein.
3. **Vendoring vor Bundle:** `static/vendor/` und Manifest muessen vor `tools/build_bundle.sh` stehen.
4. **Bundle vor Abnahme:** Air-Gap-AK ist erst nach isolierter VM-Installation pruefbar.

Parallel moeglich:

- UI-Skelett kann ab Ende Sprint 2 gegen Mock-API/Mock-WS starten.
- `deploy/ping-app.service` und `install.sh` koennen parallel zum Frontend entstehen, sobald App-Entry-Point und Env-Variablen klar sind.
- Lasttests mit Mock-Subprocess koennen parallel zur UI laufen.
- README-Installkapitel kann waehrend Sprint 4 wachsen, finalisiert aber erst nach VM-Smoke.

## C. Risiken und Mitigation

| Risiko | Impact | Mitigation |
|---|---|---|
| 254 statt 50 Hosts kippt Subprocess-Rate | CPU, FD-Druck, unfaire Scheduling-Spikes | Semaphore default 64, jittered scheduler, Timeout hart begrenzen, 254-Host-Lasttest als Gate |
| 254 Hz SQLite-Write-Rate | Locks, UI/API-Lag | Async-Queue, Batch-Insert alle 500ms, WAL, Index `(host_id, ts)`, Writer nicht im Request-Hot-Path |
| WebSocket sendet zu viel | Browser-Lag bei 254 Events/s | Snapshot + Delta-Events, clientseitige Aggregation/throttled render, Subscriptions pro Gruppe |
| Bundle ist nicht wirklich offline | Install scheitert auf Zielserver | Isolierte Linux-VM ohne NIC/ohne DNS als Pflicht-Gate; Install-Log archivieren |
| manylinux/glibc/Python mismatch | Wheels installieren nicht | Zielmatrix festlegen: Debian/Ubuntu + Python 3.11 + x86_64; `pip download --platform manylinux2014_x86_64 --python-version 3.11 --only-binary=:all:` |
| Inter-Font-Lizenz falsch eingebunden | Lizenzrisiko | SIL OFL-Datei unter `static/vendor/inter/OFL.txt`, keine Font-Umbenennung ohne OFL-Pruefung, Manifest dokumentiert Varianten |
| Chart.js Security-Drift | Veraltete vendored Lib | Version pinnen, Lizenzheader behalten, Update-Check als manueller Release-Schritt |
| Bundle-Update-Pfad grob | Operator muss Full Bundle ersetzen | Fuer v1 akzeptieren: Full-Bundle-Replace + DB bleibt in `/var/lib/ping-app/`; `install.sh` idempotent, macht kein DB-Delete |
| ICMP-Rechte unter systemd | Pings schlagen fehl | `AmbientCapabilities=CAP_NET_RAW`; zusaetzlich Diagnose in README und systemd-Logs |
| Design-Akzeptanz offen | UI-Rework | Vor Sprint 3 als HOLD: Editorial Brutalist von Francesco bestaetigen lassen |

## D. Cross-Cutting Tasks

Repo-Struktur ergaenzen:

```text
static/vendor/
  chart.umd.min.js
  chartjs.LICENSE.txt
  inter/*.woff2
  inter/OFL.txt
  vendor-manifest.json
tools/
  build_bundle.sh
  verify_bundle_offline.sh
deploy/
  ping-app.service
  env.example
install.sh
requirements.in
requirements.txt
```

Build-Tool: fuer v1 **Shell-Script + Make-Target** reicht. `tools/build_bundle.sh` bleibt transparent fuer Offline-Operatoren; `make bundle` ruft es nur bequem auf. Python-Modul erst, wenn Release-Logik komplexer wird.

Reproduzierbarkeit: `pip-tools` nutzen: `requirements.in` als Quelle, `requirements.txt` mit Pins/Hashes soweit praktikabel. Bundle-Build nutzt nur `requirements.txt`. Wheelhouse wird in `dist/bundle/wheels/` gesammelt.

Vendored-Asset-Manifest: `static/vendor/vendor-manifest.json` mit Name, Version, Quelle, Lizenz, Datei-Pfad, SHA256. Pflicht fuer Chart.js und Inter-Varianten.

## E. Top-3 Start-Empfehlung

1. **Sprint 1 sofort:** Tests, Lockfile und Struktur sind die Basis fuer alles Weitere.
2. **Sprint 2 als Hauptblock:** Backend-Core entscheidet, ob 254 Hosts technisch halten.
3. **Ab Mitte Sprint 2 parallelisieren:** UI-Skelett gegen Mock-WS starten; Bundle-Build-Tool frueh als leeres Geruest anlegen, final aber erst nach Vendoring und stabilen Dependencies abschliessen.