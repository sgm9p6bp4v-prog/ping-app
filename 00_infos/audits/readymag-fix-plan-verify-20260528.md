## 1. Verdikt

**GO mit Massgaben.** Der Plan deckt die wesentlichen P0/P1-Findings ab, ist aber nicht 1:1 ausfuehrbar: P0-5 hat einen echten Edge-Case-Bug, P0-2 behauptet Deep-Link/Back-Button-Verhalten, das der Code nicht hat, und Cluster C widerspricht HOLD-4. **Score: 7/10.**

## 2. Plan-Coverage-Check

| Audit-ID | Im Plan | Status | Kommentar |
|----------|---------|--------|-----------|
| P0-1 i18n confirm | ja | Fix | OK, real bei `static/js/dashboard.js:237`; `t()` interpoliert nicht, `static/js/i18n.js:22-24`. |
| P0-2 Drilldown doppelt | ja | Fix, aber Test falsch | Ursache real: Anchor `dashboard.js:315-316` plus `hashchange` `dashboard.js:49-52`; Back/initial deep-link ist nicht geloest. |
| P0-3 START active wipe | ja | Fix/HOLD | Defekt real: `_configure_packet_limit()` vor Guard, `monitoring.py:67-75`, Clear bei `monitoring.py:137-158`. |
| P0-4 stale Stop-% | ja | Fix | OK, Lock real `dashboard.js:136-146`, Monitoring-State real `monitoring.js:29-53`. |
| P0-5 PATCH groups verwirft Felder | ja | Fix, aber fehlerhaft | Defekt real `api.py:274-297`; Plan muss `name = g.name` statt raw `new_name` setzen wegen Strip in `store.py:328-331`. |
| P0-6 PAUSE/RESUME | ja | Fix | OK, hardcoded `dashboard.js:207`; Keys existieren `en.json:14-15`, `it.json:14-15`. |
| P0-7 `?v=` Module | ja | Fix | OK, Queries real `app.js:13-20`, `dashboard.js:7`, `monitoring.js:9`, `index.html:7-8,129`. |
| P0-8 unknown group 404 | ja | Non-defect | OK, `update_group()` ohne Sets returned `get_group()`, `store.py:315-316`; 404 in `api.py:291-292`. |
| P1-A CSS Dual Debt | ja | HOLD | Richtig verschoben; Umfang real `app.css` 2535 Z., `readymag-overrides.css` 633 Z.; Kollisionen z.B. `app.css:87`, `readymag-overrides.css:8`. |
| P1-B inline onclick | ja | Fix | OK, vier Inline-Handler `index.html:45,49,50,67`; JS-Handler existieren `design-examples.js:13-16`. |
| P1-B wheel hijack | ja | HOLD | Richtig, real `design-examples.js:24-30`. |
| P1-C ping-settings race | ja | Fix/HOLD-Konflikt | Race real `ping-settings.js:72-82`; Persistenzfrage kollidiert mit HOLD-4. |
| P1-C getPingDefaults | ja | Korrektur | OK, nicht tot: `editor.js:7,25`; Defaults aktuell ignoriert `ping-settings.js:27-31`. |
| P1-D rename atomar | ja | Fix | Richtig, aktueller Rename hat Read-before-write ohne `BEGIN IMMEDIATE`, `store.py:334-364`. |
| P1-D empty rename status | ja | Fix | OK, heute alles `409`, `api.py:281-282`; Empty entsteht nach Strip `store.py:328-331`. |
| P1-D group delete event order | ja | Fix/P2 | OK als kleiner Fix; aktuelle Reihenfolge `host_deleted` vor `group_deleted`, `api.py:305-307`. |
| P1-E drilldown key-type | ja | Fix | OK, defensive Mischtypen `drilldown.js:87,103`; Store nutzt numerische IDs `store.js:16-20,62-67`. |
| P1-E tote i18n keys | ja | Fix/HOLD-5 | OK: `drill.chart_title` etc. nur in JSON `en.json:49-55`, `it.json:49-55`; `drill.close` bleibt benutzt `drilldown.js:45`. |
| P1-E duplicate packet validation | ja | Dokumentieren | OK, Edge-Check `api.py:78-80`, Defense-in-depth `monitoring.py:145-146`. |
| Sek. i18n-Hardcodes | nein | **UEBERSEHEN** | Weitere sichtbare Hardcodes bleiben: `dashboard.js:202,210-211,318`, KPI-Texte `index.html:92-103`. Nicht P0, aber i18n nicht “fertig”. |

## 3. Fix-Korrektheits-Check

**P0-1:** Grundfix ist OK, weil `t()` nur Lookup macht (`i18n.js:22-24`). Kleine Korrektur: bei Gruppennamen mit `$&` kann JS-`replace()` Replacement-Tokens expandieren; sicherer ist `.replace("{name}", () => name)` bei `dashboard.js:237`.

**P0-2:** `preventDefault()` loest den Doppeloeffner durch `href="#host-N"` (`dashboard.js:315-316`) und `hashchange` (`dashboard.js:49-52`). **SUSPECT:** Initiale Deep-Links werden aktuell nirgends beim Bootstrap verarbeitet (`app.js:173-193`), und Back schliesst den Drill nicht; `drilldown.close()` haengt nur an Button/Escape (`drilldown.js:74-76`).

**P0-3:** Frueher Active-Guard loest den State-Wipe, weil `_run_id++` und `_clear_packet_limit()` dann nicht laufen (`monitoring.py:67-75,137-158`). Semantik-Aenderung gegen Docstring `monitoring.py:12`, daher HOLD-1 vor Merge klaeren.

**P0-4:** Started-Event ist korrekt und idempotent; es entfernt nur `dataset.locked` auf `metric-stop-percent` (`dashboard.js:136-146`). Doppel-Emit aus Toggle und WS ist harmlos, weil `delete` idempotent ist (`monitoring.js:29-53`).

**P0-5:** Fix-Idee korrekt, aber Plan-Code falsch fuer kombinierte Payloads mit Whitespace: `rename_group()` strippt `new_name` (`store.py:328-331`), danach wuerde `name = new_name` bei `{name:" lan ", enabled:false}` auf `" lan "` updaten/upserten. Muss `name = g.name` setzen und dazu einen Test ergaenzen.

**P0-6:** OK; Labels koennen direkt `t("group.disable")` / `t("group.enable")` nutzen (`dashboard.js:207`, `en.json:14-15`, `it.json:14-15`).

**P0-7:** OK; Query-Specifier erzeugen getrennte Module, belegt durch `ping-settings.js` mit und ohne Query (`monitoring.js:9`, `editor.js:7`). StaticFiles liefert per Pfad; ETag/Last-Modified kommen von Starlette `responses.py:331-339`.

**P0-8:** Non-defect stimmt. Leerer Body fuehrt ueber `api.py:276-290` zu `update_group(name)` ohne Sets, und `store.py:315-316` gibt `None` statt Upsert zurueck.

## 4. Uebersehene Risiken / Test-Luecken

- **P0-2 Test-Luecke:** Smoke “Back-Button kehrt einmalig zurueck” ist falsch spezifiziert; ohne History-Push gibt es nichts zu poppen, und ohne Close-on-hash-empty bleibt der Drill offen (`dashboard.js:49-52`, `drilldown.js:34-39`).
- **P0-5 Test-Luecke:** Neuer Test muss Whitespace plus Zusatzfeld abdecken: `PATCH /api/groups/external {"name":" lan ","enabled":false}`; sonst faellt der Plan-Bug nicht auf (`store.py:328-331`).
- **Cluster C Produkt-Risiko:** Plan will Persistenz reparieren, HOLD-4 fragt aber, ob Persistenz gewollt ist. `initPingSettings()` mass-updatet Hosts sofort (`ping-settings.js:72,85-98`); falsche Entscheidung veraendert Daten auf Reload.
- **Security:** Kein neuer Blocker gesehen. CSRF-Guard existiert `app.py:37-47`, Fetch setzt Header `api.js:4-8`; Ping nutzt `create_subprocess_exec` ohne Shell `pinger.py:62-67`, Adresse wird validiert `api.py:38-49`.
- **i18n:** Key-Paritaet EN/IT ist aktuell OK, aber Hardcodes bleiben sichtbar (`dashboard.js:202,210-211,318`, `index.html:92-103`).
- **pytest:** In dieser read-only Session nicht verifizierbar; Pytest bricht vor Collection ab, weil kein beschreibbares Temp-Verzeichnis vorhanden ist. Plan-Baseline `63 passed` bleibt daher extern uebernommen.

## 5. Konkrete Aenderungen am Plan

- P0-5 Code aendern: nach Rename `name = g.name`, nicht `name = new_name`; Test fuer `" lan "` plus `enabled:false` ergaenzen.
- P0-2 Plan korrigieren: entweder Back/Deep-Link explizit implementieren oder Smoke-Test entfernen. Initial-Hash braucht eigene Bootstrap-Pruefung nach `loadHosts()` in `app.js:187-193`.
- P0-1 Interpolation robust machen: Replacement-Funktion fuer `{name}` nutzen.
- Cluster C vor Implementation entscheiden: Persistenz reparieren oder localStorage entfernen; nicht gleichzeitig als Fix und HOLD fuehren.
- i18n-Paritaetscheck um “referenzierte Keys vorhanden” plus “bekannte Hardcodes bleiben” ergaenzen.
- Pytest-Anweisung um `-p no:cacheprovider` optional ergaenzen, aber final in normaler beschreibbarer Umgebung laufen lassen.

## 6. Offene Fragen / HOLDs zusaetzlich

HOLD-1 bis HOLD-6 sind sinnvoll priorisiert. Zusaetzlich aufnehmen: **HOLD-7 Drilldown URL-Semantik**: Soll Host-Klick eine sharebare URL und Back-to-close haben, oder ist Drilldown rein modal ohne History? Das entscheidet P0-2 sauber.