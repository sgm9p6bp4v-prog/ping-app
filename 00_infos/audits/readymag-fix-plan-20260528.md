All findings verified against the actual code (63/63 tests green as baseline). Delivering the plan.

> **Revision 2026-05-28 (nach Cross-Model Verify durch GPT-5.5 xhigh, Score 7/10 — GO mit Massgaben):**
> Plan wurde an folgenden Stellen korrigiert/erweitert:
> - **P0-1:** `.replace("{name}", name)` → Replacement-Funktion (sonst `$&`-Token-Expansion bei Gruppennamen mit `$`).
> - **P0-2:** Smoke-Test-Aussage zum Back-Button korrigiert; Bootstrap-Pfad fuer initialen Deep-Link (`#host-N` beim Laden) explizit gemacht.
> - **P0-5:** Folge-Update zielt auf `g.name` (Stripped-Form aus dem Store), nicht auf den rohen `new_name` — verhindert Whitespace-Upsert bei `{name:" lan ",enabled:false}`; Test entsprechend ergaenzt.
> - **Cluster C:** Fix-vs-HOLD-Widerspruch geloest — Persistenz-Entscheid (HOLD-4) muss VOR Implementation fallen; Fix ist von der Entscheidung abhaengig.
> - **§3 neu:** Cluster F (uebersehene i18n-Hardcodes, von Verify gemeldet).
> - **§6:** HOLD-7 (Drilldown-URL-Semantik) ergaenzt.

---

## 1. Fix-Strategie

**Branch:** Ein einziger `fix/varga-readymag-p0` von aktuellem `main`. Begründung: alle Defekte gehören zur selben Regressionswelle (readymag-Redesign), und ein Split backend/frontend/css erzeugt für Francesco (SSOT-Owner) drei Review-Threads statt einem. Atomare Conventional-Commits pro Fix; bei Bedarf Squash-Merge im PR.

**Scope dieses Sprints:** Alle P0 (1–7; P0‑8 ist kein Defekt, nur Verifikation). Dazu die **billigen** P1 mit Test-Abdeckung oder Trivialaufwand: Cluster C (ping-settings Race), Cluster D (rename-Atomarität + Statuscode), Cluster E (drilldown key-type, dead i18n, dup-Validation), sowie aus Cluster B nur das Entfernen der inline-`onclick` Duplikate.

**Follow-up / HOLD:** Cluster A (CSS-Dual-Stylesheet-Debt, 2535+633 Zeilen) und der Wheel-Hijack aus Cluster B sind Design-Entscheidungen → `open-questions.md`, nicht blind fixen.

**Reihenfolge:** Backend zuerst (P0‑3, P0‑5, P1‑D) — durch `pytest` abgesichert, Gate für alles weitere. Dann Frontend (P0‑1, 2, 4, 6, 7) — nur manueller Smoke (kein JS-Runner im Repo). i18n-Keys zuletzt prüfen.

---

## 2. Konkrete Fix-Anleitungen pro P0

### P0-1 — Hardcoded IT im Delete-Confirm
**Datei:** `static/js/dashboard.js:237` + `static/i18n/{en,it}.json`
**Diagnose:** `confirm()`-String fest italienisch, umgeht i18n. Es existiert kein Group-Delete-Key, und `t()` (`i18n.js:22-24`) kann **nicht interpolieren** — also Template + `.replace()`.
**Fix:** Key in beide JSON (vor `"group.collapse"`):
```json
"group.delete_confirm": "Delete group \"{name}\" and all {count} hosts inside it?",
```
it.json: `"Cancellare il gruppo \"{name}\" e tutti i {count} host al suo interno?",`
```js
// VORHER (237):
const ok = confirm(`Cancellare il gruppo "${name}" e tutti i ${section.querySelectorAll("[data-host-id]").length} host al suo interno?`);
// NACHHER (Replacement-Funktion vermeidet $&-Token-Expansion bei Gruppennamen mit $-Zeichen):
const count = section.querySelectorAll("[data-host-id]").length;
const msg = t("group.delete_confirm")
  .replace("{name}", () => name)
  .replace("{count}", () => count);
const ok = confirm(msg);
```
**Test:** kein JS-Runner → manueller Smoke + Key-Parity-Script (§4). Edge-Case-Test: Gruppe `"a$&b"` anlegen und Delete-Dialog pruefen — Name muss literal angezeigt werden.
**Risiko:** Platzhalter-Typo → literales `{name}`; abgesichert durch Parity-Script + Smoke.

### P0-2 — Drilldown öffnet doppelt
**Datei:** `static/js/dashboard.js:35-39, 49-52, 295-306, 315-316`
**Diagnose:** `onHostClickHandler` wird **nie** verdrahtet (grep: `app.js` importiert kein `onHostClick`) → `openHostCard` fällt auf `openDrill(id)`. Normaler Klick macht kein `preventDefault` → `<a href="#host-N">` navigiert → `hashchange` → `openDrill` ein zweites Mal.
**Fix:** Default-Navigation immer unterbinden; `hashchange` bleibt nur für Deep-Links beim Laden.
```js
function openHostCard(card, ev) {
  const id = Number(card.dataset.hostId);
  if (!Number.isFinite(id)) return;
  ev.preventDefault();                       // wir steuern Navigation → kein hashchange
  if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
    if (onHostEditHandler) onHostEditHandler(id);
  } else if (onHostClickHandler) {
    onHostClickHandler(id);
  } else {
    openDrill(id);
  }
}
```
Behebt nebenbei P1 `dashboard.js:317` (History-Spam — kein Hash-Push mehr). [Annahme] kein Shareable-URL-nach-Klick-Feature heute (→ HOLD-7).

**Bootstrap-Deep-Link:** Da `preventDefault` jeden Klick-getriebenen Hash-Push verhindert, bleibt der `hashchange`-Listener ausschliesslich fuer initial geladene URLs zustaendig (`/...#host-N`). Damit das funktioniert, muss `app.js` nach `loadHosts()` (~Zeile 187-193) einmalig den initialen Hash auswerten:
```js
// app.js nach erfolgreichem loadHosts():
const initialHash = window.location.hash.match(/^#host-(\d+)$/);
if (initialHash) openDrill(Number(initialHash[1]));
```
Bei Modal-Close (`drilldown.close()` via Button/Escape, `drilldown.js:74-76`) zusaetzlich `history.replaceState(null, "", window.location.pathname)` ausfuehren, damit ein Reload den Drill nicht wieder oeffnet.

**Test:** Smoke (1) ein Drilldown pro Klick, (2) Reload mit `/#host-3` oeffnet Host 3 einmal, (3) Close → Hash leer → Reload oeffnet keinen Drill mehr. **Korrektur gegenueber v1:** "Back-Button kehrt einmalig zurueck" galt nur wenn der Klick einen History-Eintrag pusht — das tut er nach diesem Fix nicht mehr; Smoke entsprechend angepasst.
**Risiko:** Falls Francesco Shareable Deep-Links via Klick will → HOLD-7 entscheiden, dann statt `preventDefault` `history.replaceState` (kein Push, kein Doppel-Open).

### P0-3 — Stiller State-Wipe bei START-während-aktiv
**Datei:** `src/netping/monitoring.py:67-75`
**Diagnose:** `_run_id++` und `_configure_packet_limit` (→ `_clear_packet_limit()`, wischt `_packet_counts`) laufen **vor** dem `if not self._active`-Guard. Zweiter `start()` bei laufendem Run nukt In-Flight-Counts; UI sendet das nie (START↔STOP-Toggle), API ist aber unsicher.
**Fix:** Doppel-Start früh abweisen.
```python
async with self._lock:
    if self._active:
        # START bei laufendem Run würde In-Flight-Packet-Counts wipen.
        # UI zeigt im aktiven Zustand nur STOP → Re-Start ist No-op.
        log.info("monitoring start ignored; already active")
        return self.status()
    self._cancel_auto_stop()
    self._run_id += 1
    await self._configure_packet_limit(packet_limit)
    await self.scheduler.start()
    self._active = True
```
Docstring (Zeile 12: „re-arms the timer from zero") entsprechend korrigieren.
**Test:** neu `test_monitoring_start_while_active_is_noop` in `tests/test_monitoring_and_groups.py` — start, dann start, assert `active is True` + Status unverändert.
**Risiko:** Entfernt dokumentiertes Duration-Re-arm → **HOLD-1** (Produktentscheid). UI unberührt, 63 Tests bleiben grün.

### P0-4 — Stale Stop-% nach Neustart
**Datei:** `static/js/dashboard.js:136, 142-146` + `static/js/monitoring.js:29-36, 46-53`
**Diagnose:** `metric-stop-percent` `dataset.locked` wird bei `pingme:monitoring-stopped` gesetzt (`dashboard.js:144`), aber bei START nie zurückgesetzt.
**Fix:** Symmetrisches `pingme:monitoring-started`-Event (spiegelt das Stopped-Pattern).
```js
// monitoring.js — neuer Helper + Emit bei inactive→active:
function emitMonitoringStarted() { window.dispatchEvent(new CustomEvent("pingme:monitoring-started")); }
// in onWsState (nach Zeile 35):
if (!wasActive && state.active) emitMonitoringStarted();
// in onToggle, Start-Zweig (nach startTicker(), ~Zeile 47):
if (!wasActive) emitMonitoringStarted();
```
```js
// dashboard.js — Listener neben Zeile 142:
window.addEventListener("pingme:monitoring-started", () => {
  if (metricStopPercentEl) delete metricStopPercentEl.dataset.locked;
});
```
**Test:** Smoke — START→STOP (% einfrieren), START → % läuft wieder live.
**Risiko:** Doppel-Emit (Toggle + WS-Echo) harmlos (`delete` idempotent).

### P0-5 — PATCH /api/groups verwirft Felder bei kombiniertem Payload
**Datei:** `src/netping/api.py:274-297`
**Diagnose:** Bei `{name + enabled/collapsed}` greift der Rename-Branch; `enabled/collapsed` bleiben in `fields`, werden aber nie an `update_group` übergeben → stumm verworfen. (Frontend sendet heute getrennt → latent.)
**Fix:** Nach Rename verbleibende Felder anwenden; faltet P1‑D (Statuscode) ein.
```python
new_name = fields.pop("name", None)
if new_name is not None:
    try:
        g = await _store(request).rename_group(name, new_name)
    except ValueError as exc:
        code = 409 if "exists" in str(exc) else 422   # "empty name" → 422, nicht 409
        raise HTTPException(status_code=code, detail=str(exc)) from exc
    if g is None:
        raise HTTPException(status_code=404, detail="group not found")
    await _hub(request).broadcast({"type": "group_renamed", "old_name": name, "group": g.to_dict()})
    await _reconcile(request)
    name = g.name                         # Stripped/normalisierte Form aus dem Store, NICHT raw new_name
                                          # (rename_group strippt new_name in store.py:328-331 — sonst
                                          # wuerde {name:" lan ",enabled:false} per upsert " lan " schreiben).
if fields:
    g = await _store(request).update_group(name, **fields)
```
**Test:** neu `test_patch_group_rename_and_disable_together` (assert `name=="lan"` **und** `enabled is False`) + `test_patch_group_whitespace_name_422` + **neu** `test_patch_group_rename_with_whitespace_and_disable` (PATCH `{name:" lan ", enabled:false}` → 200; Folge-`GET /api/groups/lan` liefert `enabled:false`; **kein** Row mit Name `" lan "` in DB).
**Risiko:** Reihenfolge rename→update auf neuem (gestripptem) Namen; `update_group` upsertet existierende Row sauber. Gering.

### P0-6 — Hardcoded PAUSE/RESUME
**Datei:** `static/js/dashboard.js:207`
**Diagnose:** String-Literale statt i18n. Keys `group.disable`/`group.enable` existieren bereits in beiden JSON (verifiziert).
```js
// VORHER: ${gstate.enabled ? "PAUSE" : "RESUME"}
// NACHHER:
${gstate.enabled ? t("group.disable") : t("group.enable")}
```
**Test:** Smoke EN/IT-Toggle.
**Risiko:** keiner — Keys vorhanden.

### P0-7 — Cache-Bust `?v=` in ES-Modul-Specifiers
**Datei:** `dashboard.js:7`, `app.js:13-20`, `monitoring.js:9`, `index.html:7-8,129`; **Beleg:** `ping-settings.js` wird als `?v=packet-limit-1` (app.js:19, monitoring.js:9) **und** ohne Query (`editor.js:7`) importiert → **zwei Modul-Instanzen**, zwei Kopien des modul-globalen `applyingInterval`.
**Diagnose:** Jede Query-Variante ist ein eigenes Modul-Exemplar. `StaticFiles(html=True)` (`app.py:139`) ignoriert Query-Strings und liefert per Pfad + ETag/Last-Modified — `?v` bustet nur den Browser-Cache.
**Fix:** Alle `?v=...` aus Import-Specifiers **und** `index.html` `<link>`/`<script>` entfernen; ETag-Revalidation von StaticFiles übernimmt das Caching. [Verifikation nötig] Falls Francescos Deploy hartes Cache-Busting braucht → gehashte Dateinamen/Manifest im Asset-Layer (außerhalb dieses Sprints).
**Test:** DevTools-Network — jedes Modul einmal; `Store`-Identität stabil.
**Risiko:** Clients mit stalem Cache brauchen einen Refresh (ETag fängt es). ~8 Zeilen über 5 Dateien.

### P0-8 — `test_patch_unknown_group_404` ([suspect])
**Datei:** `tests/test_monitoring_and_groups.py:233-237`
**Diagnose:** **Kein Defekt.** Leerer Body → `fields={}`, `new_name=None` → `update_group(name)` ohne kwargs → `store.py:315-316` `if not sets: return get_group(name)` → `None` bei fehlender Gruppe → 404. Verifiziert: **63 passed** schließt diesen Test ein.
**Fix:** keiner. Optional Kommentar (234-235) präzisieren („no fields → returns get_group, kein Upsert").
**Risiko:** keiner.

---

## 3. P1-Cluster

**Cluster A — CSS-Dual-Stylesheet-Debt.** `app.css` (2535 Z, +1295), `readymag-overrides.css` (633 Z, neu), 11× `!important`, **23+ identische Selektoren in beiden Files** (`.hero`, `.drill`, `.deck-main`, `.metric-card--*`, `.page-*`…). → **Follow-up + HOLD-2.** Zu groß/risikoreich für diesen Sprint, braucht Design-Entscheid (mergen vs. Override-Layer behalten). Verstößt zudem gegen <300-Zeilen-Regel.

**Cluster B — design-examples.js als Production.** Wheel-Hijack `preventDefault` mit `{passive:false}` (`design-examples.js:24-30`) killt nativen Scroll; inline `onclick` (`index.html:45,49,50,67`) dupliziert die JS-Handler (13-16) → CSP-Risiko. → **Teilfix jetzt:** inline `onclick` entfernen (JS-Handler bleiben). **HOLD-3:** Wheel-Deck-Navigation als Default behalten oder hinter `prefers-reduced-motion` gaten?

**Cluster C — ping-settings Race + Persistenz-Frage.** `setTimeout(…,250)` (`ping-settings.js:73-82`) überschreibt User-Eingabe; `initPingSettings` (27-31) hardcodet Defaults und ignoriert `localStorage`. Korrektur zur Audit-Aussage: `getPingDefaults` ist **nicht** tot — `editor.js:25` nutzt es. → **Bedingter Fix:** Der `setTimeout`-Reset wird in jedem Fall gestrichen (echte Race, kein Produktentscheid). Was beim Init passiert haengt aber von HOLD-4 ab — **nicht gleichzeitig als Fix UND HOLD fuehren** (Verify-Mangel v1). Konkret:
> - **HOLD-4 = "ja, Persistenz gewollt":** `initPingSettings` aus `getPingDefaults()`/`localStorage` seeden, `PACKETS_KEY`/`INTERVAL_KEY` behalten.
> - **HOLD-4 = "nein":** `localStorage.removeItem(PACKETS_KEY)` + `removeItem(INTERVAL_KEY)`, `getPingDefaults` durch Modul-Defaults ersetzen, `editor.js:25` anpassen.
>
> Bis HOLD-4 entschieden ist: **nur** `setTimeout` streichen, Persistenz-Code unberuehrt lassen. Verhindert, dass spaeter Daten beim Reload still veraendert werden.

**Cluster D — Backend-Korrektheit.** `rename_group` nicht atomar (`store.py:334`, `BEGIN IMMEDIATE` ergänzen); `ValueError("empty")` → 422 (in P0‑5 erledigt); `host_deleted` vor `group_deleted` (`api.py:305-307`, Reihenfolge tauschen, P2). → **Fix jetzt** (atomarität + reorder, klein, getestet).

**Cluster E — Cleanup.** drilldown key-type-Inkonsistenz (real bei `drilldown.js:87` auf `Store.samples` **und** `:103` `findHost` auf `Store.hosts` — die genannte Zeile 118 existiert nicht; Datei endet bei 112) → auf `Number(id)` normalisieren. Tote i18n-Keys (`drill.chart_title`, `drill.events_title`, `drill.history*`, `drill.no_events` — grep bestätigt 0 Referenzen) entfernen, **abhaengig von HOLD-5**. `packet_limit`-Range doppelt (`api.py:79` Pydantic + `monitoring.py:145`) — Pydantic am Edge behalten, monitoring-Check als Defense-in-Depth dokumentieren. → **Fix jetzt** (trivial, ausser i18n-Keys → HOLD-5).

**Cluster F — Uebersehene i18n-Hardcodes (von Verify ergaenzt).** Audit-Findings adressieren nur die zwei prominentesten i18n-Verletzungen (P0-1 Delete-Confirm, P0-6 PAUSE/RESUME). Verify meldet weitere Hardcodes ohne `t()`:
> - `static/js/dashboard.js:202` — Gruppen-Heading-Konstrukt (Label/Placeholder pruefen).
> - `static/js/dashboard.js:210-211` — Text um den PAUSE/RESUME-Button.
> - `static/js/dashboard.js:318` — Host-Karten-Label-String.
> - `static/index.html:92-103` — KPI-Texte im Dashboard-Bereich.
>
> → **Follow-up, nicht in diesem Sprint** (P1, nicht P0 — bricht keine Funktionalitaet, nur EN/IT-Konsistenz). Im Sprint-PR als bekannte Restschuld erwaehnen + Folge-Issue `feat/varga-i18n-cleanup` anlegen. Verify-Score 7/10 haengt nicht daran.

---

## 4. Verifikations-Plan

**Baseline (bereits gemessen):** `.venv/bin/python -m pytest -q` → **63 passed**. Muss grün bleiben.

**Neue Tests** (`tests/test_monitoring_and_groups.py`):
- `test_monitoring_start_while_active_is_noop` (P0‑3)
- `test_patch_group_rename_and_disable_together` (P0‑5)
- `test_patch_group_whitespace_name_422` (P0‑5/P1‑D)
- `test_patch_group_rename_with_whitespace_and_disable` (P0‑5, neu nach Verify) — `{name:" lan ",enabled:false}` darf weder `" lan "` als Row schreiben noch `enabled` verlieren.
- rename-Atomarität: schwer deterministisch zu testen → [Annahme] Code-Review genügt, keine Concurrency-Test-Pflicht.

**Manueller Smoke** (`make run` / uvicorn, UI öffnen):
1. EN wählen, Gruppe anlegen → PAUSE-Button zeigt „PAUSE" (P0‑6); Delete (`-`) → Dialog englisch (P0‑1); IT-Toggle → italienisch.
2. Host-Karte klicken → Drilldown öffnet **einmal**, kein neuer History-Eintrag; Reload mit `/#host-N` oeffnet Drill genau einmal; Close → Hash leer → Reload oeffnet keinen Drill (P0‑2).
3. START → STOP (Stop-% merken) → START → Stop-% wieder live (P0‑4).
4. Hard-Reload, DevTools-Network: jedes Modul einmal geladen, keine `?v`-Dubletten (P0‑7).

**i18n-Parität:**
```bash
.venv/bin/python -c "import json; a=set(json.load(open('static/i18n/en.json'))); b=set(json.load(open('static/i18n/it.json'))); print('OK' if a==b else ('DIFF', a^b))"
```
Zusätzlich `grep -oE 't\(\"[^\"]+\"' static/js/*.js` gegen die Keysets prüfen (alle referenzierten Keys vorhanden, neue `group.delete_confirm` in beiden).

---

## 5. Rollout

- **Branch:** `fix/varga-readymag-p0` von aktuellem `main`. Atomare Conventional-Commits: `fix(monitoring): reject start while active`, `fix(api): apply enabled/collapsed alongside group rename`, `fix(i18n): localize group delete confirm + pause/resume`, `fix(dashboard): open drilldown once per click`, `fix(assets): drop ?v query from module imports`, `chore(cleanup): remove dead drill i18n keys`.
- **PR an Francescos `main`** — gemäß `CLAUDE.md` nur via PR, Push nach `origin` nur auf ausdrücklichen Befehl.
- **13 Mikro-Commits:** Sie sind lokal-only (`main` wurde ersetzt, nie nach `origin` gepusht; Backup `backup/main-pre-readymag-20260528`). Empfehlung: **Squash-Merge im PR** → Francesco sieht einen sauberen Commit „feat: readymag-inspired redesign". Alternative (lokal sauber, rewrites History): `git reset --soft backup/main-pre-readymag-20260528` + 1–2 Re-Commits, dann Fixes obendrauf. ⚠️ `git rebase -i` ist in dieser Umgebung nicht verfügbar → kein interaktives Squash.
- **Konvention:** Conventional Commits (`<type>(<scope>): <subject>`), konsistent mit `61a7f17 docs: …`.

---

## 6. Offene Fragen (HOLD-Kandidaten → `00_infos/meta/open-questions.md`)

- **HOLD-1 (P0‑3):** Soll START-während-aktiv No-op (empfohlen), sauberer Neustart oder Duration-Re-arm sein? Ändert dokumentierte Semantik. → Francesco.
- **HOLD-2 (Cluster A):** CSS-Strategie — `readymag-overrides.css` in `app.css` mergen, Override-Layer formalisieren, oder Redesign zurückrollen? 23+ kollidierende Selektoren + `!important`-Eskalation. → Francesco.
- **HOLD-3 (Cluster B):** Wheel-Hijack-Deck-Navigation als Production-Verhalten behalten? Wenn ja, hinter `prefers-reduced-motion` gaten (Barrierefreiheit/Scroll).
- **HOLD-4 (Cluster C):** Sollen Interval/Packet-Settings über Reload persistieren? Entscheidet, ob `localStorage`-Code repariert oder gelöscht wird.
- **HOLD-5:** Drilldown-Redesign final (keine Rückkehr von History/Events-Tabs)? Voraussetzung fürs Löschen der toten `drill.*`-Keys.
- **HOLD-6:** Squash der 13 Commits vor PR an Francesco gewünscht, oder readymag-Historie erhalten? → Francescos Präferenz als SSOT-Owner.
- **HOLD-7 (P0‑2, nach Verify):** Drilldown-URL-Semantik — soll Host-Klick eine sharebare URL erzeugen (Hash bleibt nach Klick) und Back-Button den Drill schliessen, oder ist Drilldown rein modal ohne History? Entscheidet, ob P0‑2 mit `preventDefault` (modal) oder `history.replaceState` (sharebar ohne Push) implementiert wird.