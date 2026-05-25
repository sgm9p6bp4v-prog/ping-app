# Audit — NetPing Dashboard Plan

**Verdikt:** Struktur akzeptabel, aber massiv ueberdimensioniert. Sechs Sprints fuer ~250 LoC ist Enterprise-Theater. Drei PRs reichen.

## A. Was fehlt

- **Charakterisierungs-Tests VOR Refactor.** Sprint 1 splittet `main.py` ohne Ist-Zustand-Baseline. Wenn etwas bricht, gibt es keinen Vergleichspunkt. Vor jedem Split: Golden-Output-Tests fuer `parse_ping_output` mit IT- und EN-Sample-Outputs, Smoke gegen laufenden Prototyp.
- **Windows-Verifikations-Pfad.** Plan setzt voraus dass wir Windows testen koennen. Haben wir eine Box? Falls nein: HOLD oder Francesco testet. Sprint 4 ist sonst blind.
- **PyInstaller-Realitaet.** Sprint 4 erwaehnt PyInstaller, aber nicht: macOS Code-Signing/Notarization (sonst Gatekeeper-Block), Windows-Defender-False-Positive, ICMP-Permissions in der gepackten Binary.
- **Prototyp-Baseline-Probe.** Niemand hat dokumentiert, dass der Prototyp im Ist-Zustand laeuft. Sprint 1 setzt das voraus — Quelle?
- **Risiko Q5=Nein.** Wenn Francesco Refactor ablehnt, bricht der ganze Plan. Plan erwaehnt das, restrukturiert sich aber nicht. Was waere die additive-only-Variante?

## B. Was falsch / zu optimistisch ist

- **Sprint 2 (3-4 PT) dupliziert Prototyp-Features.** Live-Monitor, Stats, Chart, Status-Indikator, Event-Log existieren bereits. Sprint 2 ist nicht "MVP bauen" sondern "Edge-Cases haerten + WS-Reconnect". Realistisch 1-2 PT.
- **Sprint 0 ist kein Sprint.** Q1-Q5 beantworten ist Wartezeit auf Francesco, nicht unsere PT. Gate, nicht Sprint.
- **"Refactor senkt Risiko" (Sprint 1) — falsch herum.** Refactor OHNE Tests erhoeht Risiko. Tests zuerst, dann Split.
- **Multi-Host +3-5 PT.** Wenn Q4=Multi-Host, aendern sich Datenmodell, WS-Protokoll, UI-Layout, State-Machine. 5-8 PT realistischer.
- **Sprint 4: 2-5 PT Spannweite.** Entweder Scripts (0.5 PT) oder PyInstaller (3-5 PT). Eine Schaetzung zu beidem ist Aufgabenmischung.
- **PT-Definition fehlt.** Was ist 1 PT — Wall-Clock-Tag, Person-Tag, Effort-Punkt? Unklare Einheit macht alle Zahlen wertlos.

## C. Was Overengineering ist

- **6 Sprints fuer ~250 LoC Tool.** Das sind 2-3 PRs.
- **Sprint 5 als "Optional"-Bucket.** Sprints sind keine Wunschzettel. Unsicheres gehoert in HOLDs.
- **i18n-Framework-Diskussion.** Default sollte "IT-only, bis Francesco anders sagt" sein. Drei i18n-Pfade reservieren ist verfrueht.
- **DoD-Tabellen pro Sprint.** Fuer 1-2 PT Sprints Bullshit-Bingo. Eine Gesamt-DoD reicht.
- **Q9 (Push-Workflow) im Plan.** CLAUDE.md sagt schon: `feat/varga-*` + PR. Aus Q-Liste raus, aus Sprint 0 raus.

## D. Konkrete Aenderungen

1. **Sprint 0 streichen.** Q1-Q5 sind Vorbedingung. Eintrag in `open-questions.md`, fertig.
2. **Sprint 1 + 2 + 3 zusammenlegen** zu einem "Stabilize+Harden"-PR (5-7 PT). Sequenz: Charakterisierungs-Tests → Backend-Split → Frontend-Split → LAN-IP-Fix → Host-Validation → CORS-Entscheid.
3. **Sprint 4 splitten:** "Verify Start-Scripts" (0.5 PT, jetzt) vs. "PyInstaller" (3-5 PT, nur wenn Q6=PyInstaller).
4. **Sprint 5 loeschen.** i18n/Export/CI/License = je ein eigener Mini-PR nach v1, jeweils 0.5-2 PT.
5. **Risk-Eintrag ergaenzen:** "Kein Windows-Test-Pfad bei uns" — Mitigation: Francesco testet, oder VM, oder HOLD-XX.
6. **PT-Einheit explizit definieren** (Person-Tag, ~6h fokussiert) in Plan-Header.

## E. Empfehlung: Akzeptiert mit Top-3-Aenderungen

Plan ist nicht fundamental falsch, aber strukturell aufgeblasen. Drei Aenderungen:

1. **Sprints 0 + 5 streichen.** Reduziert auf 4 reale Arbeitsblocks (eigentlich 3 PRs).
2. **Sprints 1-3 zusammenlegen** zu einem Stabilize+Harden-PR. Sequenz: Tests zuerst, dann Refactor, dann Hardening — diese Reihenfolge ist nicht verhandelbar.
3. **PT-Schaetzungen halbieren** auf 5-7 PT gesamt fuer v1 (statt 9-15). Tool ist 250 LoC, nicht 2500. Wenn Multi-Host (Q4) kommt, +5-8 PT — nicht 3-5.