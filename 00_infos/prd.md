# PRD — NetPing Dashboard

> **Status:** v0.3 — Air-Gap + 254-Host-Scale + MIT-Lizenz eingearbeitet (2026-05-25)
> **Vorgaenger:** v0.2 (50 Hosts, internet-fähig angenommen)
> **Autor:** Christoph / Varga (im Auftrag fuer Francesco)
> **Naechster Schritt:** Implementierungsplan v0.3 (siehe `prd-plan.md`).

---

## 1. Vision & Zweck

Ein **Server-residentes Live-Dashboard zur Ueberwachung eines gesamten privaten /24-Subnetzes (bis zu 254 Hosts) per ICMP-Ping**, LAN-weit ueber HTTP zugaenglich. Server **air-gapped** (kein Internet). Status auf einen Blick — ein gemeinsamer Statuswall fuer Studio/Buero/Lokation. Editorial Brutalist Design (siehe §6), keine Konsolen-Aesthetik, monochrom.

**Nicht-Ziel:** kein Ersatz fuer Zabbix/Prometheus/Grafana. Kein Alerting per Push/Email/Webhook. Keine Multi-Tenancy. Keine Trends ueber Monate.

---

## 2. Personas / Nutzer

| Persona | Kontext | Use Case |
|---------|---------|----------|
| **Team-Mitglied im LAN** | Oeffnet Browser auf beliebigem Geraet im Studio-Netz | Status der ueberwachten Hosts auf einen Blick |
| **Operator** | Pflegt Host-Liste, gruppiert, korrigiert | Hosts hinzufuegen/loeschen/gruppieren ueber Web-UI |
| **Admin (Christoph)** | Deployed/wartet die App auf dem Server | systemd-Service starten/stoppen/loggen, DB sichern |

Tool ist als **vertrauenswuerdiges LAN-Tool** modelliert (Q1: Team-LAN-Tool, Q3: LAN-only, Q-Auth: LAN-Trust). Kein Login.

---

## 3. Use Cases

1. **UC-1 Statuswall** — Browser auf `http://<server>:<port>/` zeigt alle Hosts in Gruppen, Status-LEDs auf einen Blick.
2. **UC-2 Drill-Down** — Click auf Host oeffnet Detail mit RTT-Chart (60 s rollend) + Outage-Log.
3. **UC-3 Host-Pflege** — Web-Form zum Hinzufuegen/Loeschen/Verschieben/Gruppieren von Hosts. Aenderungen sind **sofort live** in allen offenen Browser-Tabs.
4. **UC-4 History** — Klick auf "History" auf einem Host zeigt RTT/Loss der letzten Stunden/Tage aus SQLite.
5. **UC-5 LAN-Zugriff** — Server bindet `0.0.0.0:<port>`, Kollegen im LAN erreichen ihn ueber `http://<server-ip>:<port>/`.
6. **UC-6 Server-Restart-Recovery** — Nach systemd-Restart laeuft alles automatisch weiter, Host-Liste + History bleiben erhalten.

---

## 4. Funktionale Anforderungen

### 4.1 Ping-Engine
- ICMP-Echo per Subprocess pro Host. Auf Linux: `ping -c 1 -W 2`. Linux-only.
- **1 Hz default**, pro Host konfigurierbar (z.B. 5 s fuer wenig kritische Hosts).
- **254 Hosts parallel** (gesamtes /24-Subnetz): Concurrency-Limit (asyncio Semaphore, Default 64) + gestaffelter Scheduler damit nicht 254 Subprocesses gleichzeitig starten.
- Bei 254 Hosts × 1 Hz = 254 Subprocesses/s nachhaltig. Lasttest gegen Mock-Subprocess-Wrapper (Sprint 4).
- Pro Ping: `{rtt_ms, success, error, ts, host_id}`.
- **Hosts werden statisch ueber UI gepflegt** (keine Auto-Discovery, kein Subnet-Sweep) — siehe Q-LAN.

### 4.2 Backend (FastAPI + Python 3.11+)
- **Module:** `app.py` (FastAPI-Setup), `pinger.py` (Ping-Engine + Concurrency), `parser.py` (ping-Output-Parsing), `store.py` (SQLite-Layer), `ws.py` (WebSocket-Hub), `api.py` (REST-CRUD), `config.py` (Settings via env + defaults).
- **Endpoints:**
  - `GET /` → SPA-Index
  - `GET /api/hosts` → Host-Liste
  - `POST /api/hosts` → Host anlegen
  - `PATCH /api/hosts/{id}` → Host editieren
  - `DELETE /api/hosts/{id}` → Host loeschen
  - `GET /api/hosts/{id}/history?from=&to=` → RTT/Loss-History aus SQLite
  - `GET /api/info` → Server-Hostname, LAN-IP, OS, Version (korrekte LAN-IP-Detection via UDP-Probe)
  - `WS /ws` → bidi Live-Stream: Ping-Events (server→client), Host-CRUD-Events (server→client für Multi-Tab-Sync)

### 4.3 Frontend (Single-Page-App, Vanilla JS + Chart.js)
- **Module:** `index.html`, `static/css/app.css`, `static/js/app.js` (+ optionale Sub-Module `dashboard.js`, `drilldown.js`, `editor.js`).
- **Air-Gap-Zwingend: alle Assets vendored, NICHTS vom CDN.** Chart.js als minified Build unter `static/vendor/chart.umd.min.js`, Inter-Font als WOFF2-Dateien unter `static/vendor/inter/`. Keine `<link href="https://fonts.googleapis.com/...">`-Eintraege. Lizenz-Header der vendored Libraries beibehalten.
- **Layouts:**
  - **Gruppen-Dashboard (Default):** Gruppen-Kacheln mit aggregiertem Status (alle gruen / einige gelb / mind. eines rot). Per Gruppe Liste der Host-Cards (Status-LED, Hostname, RTT-aktuell, Loss%).
  - **Drill-Down:** Vollbild-Detail fuer einen Host mit 60-s-Chart, History-Toggle (1h/24h/7d), Outage-Log.
  - **Editor:** Modal/Sidepanel fuer Host-Pflege (Name, IP/DNS, Gruppe, Interval, aktiviert ja/nein).
- **i18n:** Englisch als Default, Italienisch als zweite Sprache. Strings in `static/i18n/en.json` + `it.json`. Sprach-Switch im UI, Persistenz via `localStorage`.

### 4.4 Persistenz (SQLite)
- Datei: `data/ping.db` (Pfad konfigurierbar).
- Tabellen:
  - `hosts (id, name, address, group_name, interval_s, enabled, created_at)`
  - `samples (host_id, ts, rtt_ms, success, error)` — append-only, indexiert auf `(host_id, ts)`.
  - `events (host_id, ts, type, message)` — fuer Outage-Eintraege.
- **Retention:** `samples` rolling 7 Tage (Default, konfigurierbar). `events` rolling 30 Tage. Hintergrund-Task `purge_loop` einmal pro Stunde.
- WAL-Modus aktivieren fuer parallele Reads + Writes.

### 4.5 WebSocket-Hub
- EIN Server-seitiger Hub multiplexed alle Ping-Ergebnisse + CRUD-Events an alle verbundenen Clients.
- Pro Client Subscriptions (z.B. nur Gruppe X) — Bandbreite sparen.
- **Reconnect-Strategie:** Client retry mit exponentiellem Backoff, beim Reconnect Snapshot des aktuellen Zustands.

### 4.6 Konfiguration
- Single `config.py` + Env-Override (`PING_*`-Prefix). Werte: `PORT`, `BIND_HOST`, `DB_PATH`, `MAX_CONCURRENT_PINGS`, `SAMPLE_RETENTION_DAYS`, `EVENT_RETENTION_DAYS`, `SLOW_THRESHOLD_MS`, `LANGUAGE_DEFAULT`.

---

## 5. Nicht-funktionale Anforderungen

| Bereich | Anforderung |
|---------|-------------|
| **Plattform Server** | Linux (Ubuntu/Debian) auf dem bestehenden Zabbix-Host (Co-Location, **keine** Zabbix-Integration). Python 3.11+. **Air-gapped** — kein Internet-Zugriff im Betrieb noch bei Install. |
| **Install-Mode** | **Offline-Bundle** als `ping-app-<version>.tar.gz` (~50-100 MB) mit allen Python-Wheels + vendored Assets + systemd-Unit + Install-Skript. Uebertragung per USB-Stick oder SCP. Entpacken nach `/opt/ping-app/`, `install.sh` legt venv (`pip install --no-index --find-links wheels/`), Daten-Dir `/var/lib/ping-app/`, systemd-Unit `ping-app.service`. Docker-Compose nur fuer Dev/Test-Setup bei uns. |
| **Updates** | Neues Bundle bauen, alten ersetzen, `systemctl restart ping-app`. Keine Live-Update-Mechanik in v1. |
| **Performance** | 254 Hosts × 1 Hz = 254 Pings/s nachhaltig, CPU < 15 % auf modernem Server-Hardware. UI-Update-Latenz < 200 ms. |
| **Robustheit** | Ein toter/missgebildet konfigurierter Host stoppt nicht die anderen. SQLite-Writes nicht im Request-Hot-Path (async-Queue + Batch-Insert alle 500ms). Server-Restart < 5 s, dann automatischer Pinger-Resume. Subprocess-Storm-Schutz: Semaphore + jittered Scheduler. |
| **Security** | LAN-only. Bind default `0.0.0.0`, CORS-Allowlist konfigurierbar (Default = LAN-CIDR aus Env). **Keine Auth** (Q-Auth: LAN-Trust). Host-Input validiert (FQDN-Regex + IPv4/IPv6). |
| **Browser-Support** | Aktueller Chrome/Firefox/Safari (kein IE/Edge-Legacy). |
| **Footprint** | < 250 MB Disk inkl. venv + vendored Assets. < 150 MB RAM idle, < 400 MB RAM unter Volllast (254 Hosts). |
| **Lizenz** | MIT (siehe `LICENSE` im Repo-Root). |
| **Logs** | `journalctl -u ping-app` (stdout via systemd). Strukturierte Log-Lines (JSON optional via Env). |

---

## 6. Design-System (verbindlich)

Quelle: `00_infos/untitled.pen` — "Editorial Dashboard"-Stil. **Francescos Cyberpunk-Look wird verworfen.**

### Variablen (aus Pencil-File)
| Token | Wert | Verwendung |
|-------|------|------------|
| `--bg` | `#FFFFFF` (light) / `#000000` (dark) | Background |
| `--fg` | `#000000` (light) / `#FFFFFF` (dark) | Vordergrund-Text |
| `--hairline` | `#EBEBEB` (light) / `#1C1C1C` (dark) | Trennlinien (1px) |
| `--muted` | `#9A9A9A` / `#6A6A6A` | Sekundaer-Text |
| `--selection` | invertiert | Auswahl/Hover |
| `--font-primary` | Inter | Komplette Typografie |
| Sizes | xs 10, sm 11, base 14, lg 18, xl 24, 2xl 36, 3xl 56, hero 120 | |
| Weights | medium 500, bold 700, black 900 | |
| Spacing | xs 4, sm 8, md 16, lg 24, xl 32, 2xl 48, 3xl 64 | |

### Stil-Prinzipien
- **Brutalist-Editorial**: massive Zahlen (`hero`/`3xl` fuer KPIs), grosszuegiger Whitespace, scharfe Trennlinien.
- **Monochrom B/W** mit Hairline-Grays. Keine Akzentfarben — Status wird ueber Text/Pattern/Position kommuniziert, nicht Farbe (Accessibility-positiv).
- **Status-Indikatoren**: Text-Tags ("ONLINE" / "SLOW" / "OFFLINE") + Position/Block-Inversion statt LED-Punkte.
- **Theme**: System-Default + manueller Toggle. Persistenz in `localStorage`.

### Layout-Referenz (aus Screenshot Frame `fQ6P8`)
- Header: Logo + Datum/Uhr + Hauptstatus-Badge oben rechts
- Hero-Block: grosse Zahl mit Bruchanzeige (z.B. `24 / 192`), Stil `font-size: hero`
- KPI-Row: Sent / Lost / Avg / Loss% in 4 Spalten
- Chart: "Sixty seconds of latency" — minimaler Line-Chart, kein Grid, hairline Achsen
- Activity/Events: "Recent events." als Tabelle ohne Bordering, nur Hairlines
- Footer: Branding + Meta

Implementierung: CSS-Custom-Properties pro Token, Theme-Switch via `data-theme="dark"` Attribut.

---

## 7. Out of Scope (v1)

- Alerting (Email/Slack/Webhook) — Q-Alert: nein, visuell rot reicht
- Auth/Login — Q-Auth: LAN-Trust, komplett offen
- Windows-Server-Support (Linux-only Deploy)
- Zabbix-API-Integration (Q4a: Co-Location ohne Integration)
- Mobile-App-Wrapper
- HTTPS/TLS (LAN-only, hinter Reverse-Proxy falls noetig)
- Multi-User-Berechtigungen
- Trend-Analyse > 7 Tage (Retention-Cap)
- Docker als primaerer Deploy-Pfad (nur Dev-Fallback)
- **Auto-Discovery** / Subnet-Sweep (Q-LAN: statische UI-Pflege)
- **Internet-Zugriff** im Betrieb (Q-Offline: air-gapped) — keine externen Telemetrie/Update-Calls, keine CDN-Loads
- Live-Update-Mechanik (Update = neues Bundle deployen)

---

## 8. Akzeptanzkriterien v1

1. **Offline-Install:** `ping-app-<version>.tar.gz` per USB-Stick auf air-gapped Server kopiert, `./install.sh` laeuft ohne Internet-Zugriff durch, systemd-Service startet, autostart on boot.
2. UI auf `http://<server>:<port>/` zeigt Gruppen-Dashboard. Browser laedt UI komplett ohne externe Requests (DevTools-Check: 0 Calls zu Cloud-Hosts).
3. Neuer Host wird in der UI angelegt → erscheint **sofort** in allen offenen Browser-Tabs (Live-Sync).
4. **254 Hosts gleichzeitig:** CPU < 15 %, RAM < 400 MB, UI-Update < 200 ms.
5. Ein Host wird unerreichbar → Status-Tag wechselt < 3 s auf OFFLINE, RTT-Chart zeigt Lueckenstrich, Outage in Event-Log.
6. Server-Restart: nach < 30 s sind alle Hosts wieder live, History intakt.
7. History-Endpoint liefert SQLite-Daten der letzten 7 Tage fuer einen Host.
8. Browser-Reload: Sprache (EN/IT) und Theme (light/dark) persistieren.
9. `pytest` Smoke + Parser-Tests + API-Tests gruen.
10. README beschreibt Offline-Install in < 10 Minuten (Bundle bauen + transferieren + entpacken + starten).
11. `LICENSE` (MIT) im Repo-Root, vendored Libraries behalten ihre Original-Lizenz-Header.

---

## 9. Risiken & Mitigation

| Risiko | Impact | Mitigation |
|--------|--------|------------|
| 254 parallele Subprocess-Pings ueberlasten OS | Tool wirkt unreliable | Concurrency-Limit (Semaphore=64), jittered Scheduler, Tests mit 254-Host-Mock |
| SQLite Write-Contention bei 254 Hz Inserts | Latency-Spikes, Lock-Errors | Async-Queue + Batch-Insert (z.B. 1× pro 500ms), WAL-Mode, Index (host_id, ts) |
| Offline-Bundle veraltete Wheels oder fehlende Plattform-Wheels (manylinux vs musllinux) | Install scheitert auf Zielserver | Bundle-Build mit exakt der Ziel-Python/glibc-Version (`pip download --platform manylinux2014_x86_64 --python-version 3.11`); Bundle-Smoke-Test in Linux-VM vor Auslieferung |
| Vendored Chart.js wird nicht aktualisiert → Security-Drift | Bekannte Lib-Bugs bleiben | Build-Skript pinnt Chart.js-Version, Doku weist auf manuelle Update-Pflicht hin |
| ICMP-Permissions auf Linux (`ping` needs CAP_NET_RAW oder setuid) | Tool faellt aus | systemd-Unit setzt `AmbientCapabilities=CAP_NET_RAW` |
| WebSocket-Reconnect-Storm bei Server-Restart | Server overload | Exponential Backoff client-side, jittered |
| UI mit 50 Hosts wird unuebersichtlich | UX leidet | Gruppen-Dashboard mit Drill-Down (UC-1+2), max ~12 Hosts pro Gruppe-Empfehlung |
| Design-Drift von Francescos urspruenglicher Cyberpunk-Aesthetik | Konflikt mit Francesco | PRD §6 dokumentiert Wechsel; falls Francesco ablehnt → HOLD |

---

## 10. Quellen

- `00_infos/ping-dashboard.zip` — Originalprototyp Francesco (v0)
- `00_infos/untitled.pen` — Design-System (Pencil-File)
- `00_infos/prd-questions.md` — beantwortete Klaerungsfragen
- `00_infos/prd-plan.md` — Implementierungsplan
- `00_infos/prd-plan-audit.md` — Opus-max-Verifikation des urspruenglichen Plans
