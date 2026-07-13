# Kundenbetrieb von ping.me

> Review: 2026-07-13. Die Live-Instanz liegt außerhalb der Varga-Fleet.

## Bundle freigeben

1. Quellcommit, Python-Zielversion und Lockfiles festhalten.
2. `make test` und `make lint` in der vorhandenen Dev-Umgebung ausführen.
3. Bundle nur mit freigegebenem Download-/Netzzugriff über
   `tools/build_bundle.sh` erzeugen.
4. `tools/verify_bundle_offline.sh <bundle.tar.gz>` ausführen und Prüfsumme
   getrennt vom Bundle übermitteln.
5. HOLD-VM bleibt offen, bis eine echte Installation mit deaktiviertem Netzwerk in
   einer unterstützten Linux-VM belegt ist.

## Installation und Prüfung

Auf dem kundenseitigen Ziel wird das entpackte `install.sh` als root ausgeführt.
Vorbedingungen: unterstütztes Python 3.11+, `venv`/`ensurepip`, passendes Wheel-
Bundle und dokumentierte Zielpfade. Danach:

```bash
systemctl status ping-app
curl -fsS http://127.0.0.1:8000/api/info
```

UI, Host-Erfassung, kontrollierten Monitoring-Start/-Stop und WebSocket-Updates im
LAN prüfen. Keine Firewall-Freigabe ins öffentliche Internet vornehmen.

## Daten und Upgrade

Die SQLite-Datenbank liegt standardmäßig unter `/var/lib/ping-app`. Vor jedem
Upgrade Service stoppen oder ein konsistentes SQLite-Backup erstellen. Installer
und Bundle dürfen App-Code aktualisieren, aber den Datenpfad nicht löschen.

## Rollback

Vorheriges verifiziertes Bundle und Datenbank-Backup aufbewahren. Bei einem Fehler
Service stoppen, vorherigen App-Stand wiederherstellen, nur bei Schema-/Datenbedarf
das passende DB-Backup zurückspielen und danach `systemctl status`, `/api/info`
sowie einen kurzen Monitoring-Lauf erneut prüfen. Ergebnis und Bundle-Prüfsumme
dokumentieren.
