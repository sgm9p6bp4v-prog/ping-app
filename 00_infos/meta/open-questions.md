# Open Questions (HOLD)

## Aktive HOLDs

- [HOLD-VM] Thema: Air-Gap Bundle-Verifikation in isolierter Linux-VM — Grund: Wir haben keine bereit-stehende offline-Linux-VM bei uns. `tools/verify_bundle_offline.sh` prueft Struktur, kann aber kein echtes Offline-Install beweisen — Besitzer: Christoph — Naechster Schritt: Ubuntu/Debian-VM bauen, NIC down, `install.sh` durchlaufen lassen, smoke testen — Datum: 20260526
  - verify_command: `multipass launch --name pingvm 24.04 && multipass exec pingvm -- sudo ip link set ens3 down && multipass transfer dist/ping-app-*.tar.gz pingvm: && multipass exec pingvm -- bash -c "sudo tar -xzf /home/ubuntu/ping-app-*.tar.gz && sudo /home/ubuntu/ping-app-*/install.sh && systemctl status ping-app"`
- [HOLD-001] Thema: Initial-Commit fehlt — Grund: Repo ist leer, Francesco hat noch nicht gepusht — Besitzer: Francesco — Naechster Schritt: Auf seinen Push warten, dann `repo-contract.yaml` Tech-Stack-Felder befuellen — Datum: 20260525

## Geloeste HOLDs

- [HOLD-002] Thema: Push-Rechte — Geloest am: 20260525 — Loesung: User hat ausdruecklich autorisiert direkt nach `origin` zu pushen. Push nur auf expliziten Befehl, kein autonomer Push. Tatsaechliche Collaborator-Rechte werden beim ersten Push-Versuch sichtbar.
