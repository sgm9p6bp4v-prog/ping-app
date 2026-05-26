# NetPing Dashboard

Server-resident LAN ping dashboard. Monitors up to ~254 hosts (one /24 subnet)
in real time, runs **air-gapped** on a Linux server, accessed via HTTP from
anywhere in the LAN.

> **Status:** Sprint 1 (Baseline + Tests). Not yet runnable as a server.
> See `00_infos/prd-plan.md` for the full roadmap.

## Documentation

- [`00_infos/prd.md`](00_infos/prd.md) — Product Requirements (v0.3)
- [`00_infos/prd-questions.md`](00_infos/prd-questions.md) — Clarifying Qs
  (all blockers answered)
- [`00_infos/prd-plan.md`](00_infos/prd-plan.md) — Implementation plan
  (5 sprints, 22-30 PT)
- [`00_infos/prd-plan-audit.md`](00_infos/prd-plan-audit.md) — Plan audit
  (Opus max)
- [`00_infos/untitled.pen`](00_infos/untitled.pen) — Design system
  (Pencil file, Editorial Brutalist)
- [`00_infos/repo-contract.yaml`](00_infos/repo-contract.yaml) — Machine-
  readable repo metadata

## Development

```bash
make venv          # create .venv
make install-dev   # install dev deps from requirements-dev.txt
make test          # run pytest
make lint          # run ruff lint
make format        # auto-format
make check         # lint + test
```

### Layout

```
src/netping/          # Python package
  parser.py           # ping output parser (Sprint 1: golden-tested baseline)
  …                   # app.py, pinger.py, store.py, ws.py — Sprint 2+
tests/                # pytest
  fixtures/           # captured ping outputs (real + hand-crafted)
deploy/               # systemd unit, env.example — Sprint 4
tools/                # build_bundle.sh — Sprint 4
static/               # SPA (HTML/CSS/JS) — Sprint 3
  vendor/             # vendored Chart.js + Inter font (air-gap requirement)
00_infos/             # documentation
```

### Lockfiles

Runtime deps in `requirements.in` → compiled to `requirements.txt` via
`pip-tools`. Same for `requirements-dev.in/.txt`. Update:

```bash
make lock
```

## Deploy (air-gapped Linux server)

Build the offline bundle on an internet-connected machine:

```bash
make install-dev
tools/build_bundle.sh                              # default: manylinux2014_x86_64, py3.11
tools/verify_bundle_offline.sh dist/ping-app-*.tar.gz
```

Result: `dist/ping-app-<version>.tar.gz` (~9 MB) containing wheels, code,
vendored assets, install.sh, and systemd unit.

Transfer (USB stick, SCP, etc.) and install on the target:

```bash
sudo tar -xzf ping-app-<version>.tar.gz -C /tmp/
sudo /tmp/ping-app-<version>/install.sh
```

Defaults:
- App user/group: `ping-app`
- Code:           `/opt/ping-app`
- Data:           `/var/lib/ping-app/ping.db`  (back this up)
- Env:            `/etc/ping-app/env`
- Service:        `ping-app.service` (auto-start on boot, restart on failure)

Inspect / control:

```bash
systemctl status ping-app
journalctl -u ping-app -f
systemctl restart ping-app    # after editing /etc/ping-app/env
```

Open in browser: `http://<server-ip>:8000/`.

## Backup & Restore

All state lives in `/var/lib/ping-app/ping.db` (SQLite). Configuration is in
`/etc/ping-app/env`. There is no separate cache.

**Backup** (online — WAL mode safe):

```bash
sudo sqlite3 /var/lib/ping-app/ping.db ".backup '/srv/backup/ping-$(date +%F).db'"
sudo cp /etc/ping-app/env /srv/backup/env-$(date +%F)
```

A simple cron line:

```cron
0 3 * * * sqlite3 /var/lib/ping-app/ping.db ".backup '/srv/backup/ping-$(date +\%F).db'" && find /srv/backup -name 'ping-*.db' -mtime +14 -delete
```

**Restore** to a fresh server:

```bash
sudo systemctl stop ping-app
sudo install -o ping-app -g ping-app -m 0640 backup.db /var/lib/ping-app/ping.db
sudo install -o root     -g ping-app -m 0640 env      /etc/ping-app/env
sudo systemctl start ping-app
```

`install.sh` is idempotent — re-running it never touches `/var/lib/ping-app/`,
so deploying a new bundle never destroys history. The schema uses
`CREATE … IF NOT EXISTS`, so older DBs from previous versions are compatible.

## License

[MIT](LICENSE). Vendored libraries (Chart.js, Inter) keep their original
licenses (MIT and SIL Open Font License respectively).
