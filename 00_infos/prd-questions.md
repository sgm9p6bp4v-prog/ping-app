# Klaerungsfragen an Francesco

> Bezug: `prd.md` v0.3
> Status: **alle Blocker + Air-Gap-/Scale-Folgefragen beantwortet (2026-05-25, Christoph)**, Rueckspiegelung an Francesco offen.
> Antworten in Klammern.

---

## Blocker — BEANTWORTET

### Q1 — Zielnutzer & Einsatz-Szenario → **(b) Team-LAN-Tool**
Laeuft auf Server, Kollegen oeffnen im Browser. LAN-IP/CORS/Doku werden v1-Themen.

### Q2 — Sprache(n) der UI → **EN als Default + IT als zweite Sprache (i18n)**
Strings ausgelagert in `static/i18n/{en,it}.json`. Switch im UI. Persistenz via `localStorage`.

### Q3 — Sicherheits-Modell → **Strikt LAN-only**
Bind `0.0.0.0`, CORS auf LAN-CIDR (Env-konfigurierbar), Host-Input validiert. Keine Auth.

### Q4 — Single vs Multi-Host → **Gesamtes privates /24-Subnetz (bis zu 254 Hosts) parallel, Server-Deploy, LAN-weit HTTP-Zugriff**
*Game-Changer.* Architektur signifikant groesser: Server-Process, SQLite, Gruppen-Dashboard, WebSocket-Hub mit Multiplexing. Concurrency-Limit (Semaphore=64) statt 254 gleichzeitiger Subprocesses.

### Q5 — Refactor von Francescos Prototyp → **Ja, Tests + Refactor zuerst**
Sprint 1 = Charakterisierungs-Tests fuer Parser → Backend-Split → Frontend-Split.

---

## Folgefragen aus Q4 — BEANTWORTET

### Q4a — Server-Kontext → **Co-Location mit Zabbix, KEINE Integration**
Server heisst "Zabbix-Server" weil Zabbix dort eh laeuft. Unsere App ist eigener Process, kein Zabbix-API-Aufruf, kein Push in Zabbix-Items.

### Q4b — Persistenz → **SQLite-History (Stunden/Tage zurueck)**
WAL-Mode, Retention 7 Tage `samples`, 30 Tage `events`. Async-Queue + Batch-Insert.

### Q4c — Host-Pflege → **UI-editierbar (Web-Form)**
CRUD via REST-API, Aenderungen via WebSocket-Hub live an alle Tabs gepusht.

---

## Wichtige Folgefragen — BEANTWORTET

### Q6 — Install-Mode → **systemd + venv (Docker als Fallback)**
- Primaer: systemd-Unit `ping-app.service`, venv `/opt/ping-app/.venv`, Daten `/var/lib/ping-app/`.
- Begruendung: Zabbix-Server klassisch Linux-nativ, Docker-Daemon waere Overhead ohne Mehrwert.
- Fallback: `docker-compose.yml` fuer lokales Entwickeln + Mock-Hosts.

### Q-UI — Dashboard-Layout fuer 50 Hosts → **Gruppen-Dashboard mit Drill-Down**
Hosts in Gruppen organisiert (z.B. nach Standort/Kategorie). Overview zeigt Gruppen-Health, Click → Host-Detail mit Chart.

### Q7 — UI-Aesthetik → **Editorial via Pencil-File (`00_infos/untitled.pen`)**
Das `.pen`-File enthaelt **genau eine** Design-Vorgabe (Frame `fQ6P8` "01 — Editorial Dashboard" + Komponenten-Library). Inter-Font, B/W monochrom, Hairline-Trennlinien, massive Zahlen. Design-Tokens siehe PRD §6. Die Cyberpunk-Aesthetik aus dem urspruenglichen Prototyp-CSS ist eine fruehere Iteration und wird ersetzt.

### Q-Alert — Alerting → **Nein, nur Live-Dashboard**
Visuell rot reicht (UC-1). Kein Webhook/Email/Push v1.

### Q-Auth — Schreibzugriff absichern → **Komplett offen, LAN-Trust**
Jeder im LAN darf Hosts editieren. Kein Login.

### Q-Sync — Multi-User Live-Sync → **Ja, via WebSocket**
CRUD-Events werden ueber denselben WebSocket-Hub gepusht der auch Ping-Ergebnisse liefert.

### Q-Arch — Architektur-Pfad → **Option 1: Python + FastAPI behalten, Refactor zuerst**
Stack-Wahl bleibt wie Francesco. Docker-Sorge wird durch systemd-Default adressiert (s. Q6).

---

## Air-Gap- und Scale-Folgefragen — BEANTWORTET

### Q-LAN — Statische Liste oder Auto-Discovery → **Statische Liste (Operator pflegt ueber UI)**
Keine ARP/ICMP-Sweeps, keine Auto-Discovery. UI-CRUD ist Single Source of Truth fuer Host-Liste.

### Q-Subnet — Subnet-Groesse → **/24 (max ~254 Hosts)**
Architektur scaled fuer 254 Hosts × 1 Hz. Concurrency-Limit Default 64.

### Q-Offline — Software-Distribution → **USB-Stick / SCP (Offline-Bundle)**
- Bundle: `ping-app-<version>.tar.gz` mit Python-Wheels + vendored Assets + systemd-Unit + `install.sh`.
- Bauen auf Internet-faehigem Geraet via `pip download --platform manylinux2014_x86_64 --python-version 3.11`.
- Transfer per USB-Stick oder SCP von einem Internet-Geraet im selben LAN.
- Install: `tar -xzf ...`, `./install.sh` → venv + systemd-Unit + Start.

### Q12 — Lizenz → **MIT**
`LICENSE` im Repo-Root, vendored Libraries behalten ihre Original-Lizenz-Header (Chart.js MIT, Inter SIL Open Font License).

---

## Nice-to-have — VERSCHOBEN nach v1

### Q8 — Export (CSV/PNG)
Nicht in v1. SQLite ist persistent, Export-Endpoints koennen v1.x ergaenzt werden.

### Q9 — Push-Workflow
Vorgegeben durch `CLAUDE.md`: `feat/varga-*`-Branches, PR an Francesco. Direct-Push autorisiert auf expliziten Befehl.

### Q10 — Repo-Struktur
Vorschlag in Plan v0.2: `src/`-Layout (Python), `static/` (UI), `tests/` (pytest), Standard-Konventionen.

### Q11 — CI (GitHub Actions)
Nicht v1. Lokal `pytest` + `ruff` + `black` reichen vorerst. CI ergaenzbar.

### Q12 — Lizenz → **MIT (bestaetigt 2026-05-25)** — verschoben in Air-Gap-Sektion oben.

---

## Offene Rueckspiegelung an Francesco

Phase-0-Antworten kommen von Christoph. Klaerstand mit Francesco:

- **Q7 Design**: `.pen` enthaelt **eine** Design-Vorgabe (Editorial Dashboard). Die wird umgesetzt — kein Wechsel-Entscheid noetig.
- **Q4 Scope**: Architektur fuer 254 Hosts (volles /24); real laufen ~50 Hosts im IP-Bereich. **Akzeptiert Francesco diesen Scope?**
- **Q12 Lizenz**: MIT — **bestaetigt von Christoph 2026-05-26**.

Verbleibend offen mit Francesco: nur **Q4 Scope-Bestaetigung**.
