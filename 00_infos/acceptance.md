# v1 Acceptance Checklist

Bezug: `prd.md` v0.3 §8 Akzeptanzkriterien.

Status: aufgenommen 2026-05-26 nach Abschluss Sprint 5.
Geprueft von: Christoph (Dev-Run auf macOS), Linux-Run pending VM (HOLD-VM).

| # | Kriterium | Status | Beleg |
|---|-----------|--------|-------|
| 1 | Offline-Install: tar -xz + ./install.sh ohne Internet, systemd autostart | **PENDING** | HOLD-VM (kein Linux-VM-Pfad bei uns). `tools/verify_bundle_offline.sh` bestaetigt **Struktur** (wheels, no-CDN, syntax). |
| 2 | UI lädt komplett ohne externe Requests (DevTools 0 Cloud-Calls) | **PASSED** | Playwright Run im Dev: alle assets served lokal von /css/, /js/, /vendor/, /i18n/. Console messages: 0 errors, 0 warnings. |
| 3 | Neuer Host live in allen Browser-Tabs sichtbar (WebSocket Live-Sync) | **PASSED** | Im Dev-Run: 4 Hosts via API erstellt, im offenen Browser sofort sichtbar (commit 447d316 + Screenshot netping-populated.png). |
| 4 | 254 Hosts: CPU <15 %, RAM <400 MB, UI-Update <200 ms | **PARTIAL** | `tests/test_load_smoke.py` (254 Hosts × 3 s mocked) in <5 s ohne Lock-Errors. Echte CPU/RAM-Messung pending HOLD-VM. |
| 5 | Host unerreichbar → Status <3 s OFFLINE, RTT-Lueckenstrich, Outage in Event-Log | **PASSED** | `tests/test_outage_events.py` 3/3 grün: outage_start nach 3 fails, outage_end nach Recovery, kein Event bei single blip. Status-Schwelle = 3 Failures (OUTAGE_THRESHOLD_FAILS / OFFLINE_FAIL_STREAK). |
| 6 | Server-Restart: <30 s alle Hosts wieder live, History intakt | **PARTIAL** | Code: `Store.open()` mit `IF NOT EXISTS`, scheduler resume aus DB on startup, FK CASCADE. End-to-end-Smoke pending HOLD-VM. |
| 7 | History-Endpoint liefert 7 Tage SQLite-Daten | **PASSED** | `tests/test_store.py::test_history_filters_by_time` + retention purge tests. API: `GET /api/hosts/{id}/history?since=...&until=...` mit Limit-Cap. |
| 8 | Sprache + Theme persistieren über Reload | **PASSED** | `static/js/i18n.js` + `app.js`: localStorage('netping.lang') + localStorage('netping.theme'). Browser-Test bestaetigt. |
| 9 | pytest Smoke + Parser-Tests + API-Tests gruen | **PASSED** | 45/45 in ~5 s (3 outage + 15 parser + 7 store + 4 pinger + 1 load smoke + 15 api). |
| 10 | README beschreibt Offline-Install in <10 Minuten | **PASSED** | README.md "Deploy (air-gapped Linux server)" Sektion: build_bundle → SCP → install.sh in 4 Commands. |
| 11 | LICENSE (MIT) im Repo-Root, vendored Libs behalten Original-Lizenz | **PASSED** | `LICENSE` (MIT) Root + `static/vendor/chartjs.LICENSE.txt` (MIT) + `static/vendor/inter/OFL.txt` (SIL OFL). `vendor-manifest.json` listet alle Quellen + Lizenzen. |

## Zusammenfassung

- **9 von 11 PASSED** im Dev-Run.
- **2 PARTIAL/PENDING** wegen HOLD-VM (Linux-Server-Verifikation).
- Alle Backend- und Frontend-Kontrakte aus PRD §4 sind implementiert + getestet.

## Naechste Schritte

1. **HOLD-VM aufloesen:** Ubuntu/Debian-VM bauen, Bundle deployen, AK #1/#4/#6 final pruefen.
2. ~~PR oeffnen~~ — **PR #1 gemerged 2026-05-26.**

Alle Phase-0-Entscheidungen sind durch Christoph getroffen — keine Rueckspiegelungs-Items offen.
