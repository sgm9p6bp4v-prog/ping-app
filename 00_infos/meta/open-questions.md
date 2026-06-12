# Open Questions (HOLD)

## Aktive HOLDs

- [HOLD-VM] Thema: Air-Gap Bundle-Verifikation in isolierter Linux-VM — Grund: Wir haben keine bereit-stehende offline-Linux-VM bei uns. `tools/verify_bundle_offline.sh` prueft Struktur, kann aber kein echtes Offline-Install beweisen — Besitzer: Christoph — Naechster Schritt: Ubuntu/Debian-VM bauen, NIC down, `install.sh` durchlaufen lassen, smoke testen — Datum: 20260526
  - verify_command: `multipass launch --name pingvm 24.04 && multipass exec pingvm -- sudo ip link set ens3 down && multipass transfer dist/ping-app-*.tar.gz pingvm: && multipass exec pingvm -- bash -c "sudo tar -xzf /home/ubuntu/ping-app-*.tar.gz && sudo /home/ubuntu/ping-app-*/install.sh && systemctl status ping-app"`
## Geloeste HOLDs

- [HOLD-001] **OBSOLETE 20260611** | Thema: Initial-Commit fehlt
  - Grund Admin-Close: Francesco hat laengst gepusht (HEAD ad51e98, 2026-06-11); `repo-contract.yaml` ist seit Contract v2 (650c2f9) befuellt. HOLD war seit Wochen ueberholt.
  - Verified-Via: `git log --oneline origin/main` zeigt Commits bis ad51e98; repo-contract.yaml contract_version "2.0" mit befuelltem Stack-Block.

- [HOLD-002] Thema: Push-Rechte — Geloest am: 20260525 — Loesung: User hat ausdruecklich autorisiert direkt nach `origin` zu pushen. Push nur auf expliziten Befehl, kein autonomer Push. Tatsaechliche Collaborator-Rechte werden beim ersten Push-Versuch sichtbar.
