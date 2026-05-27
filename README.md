# ping.me Dashboard

Server-resident LAN ping dashboard. Monitors up to ~254 hosts (a /24 subnet)
in real time. Runs **air-gapped** on a Linux server, accessed via HTTP from
anywhere in the LAN. Editorial-brutalist UI (Inter, monochrome, hairline
trennlinien — see `00_infos/untitled.pen`).

## Try it in 30 seconds (any Linux/macOS dev box)

```bash
git clone git@github.com:sgm9p6bp4v-prog/ping-app.git
cd ping-app
make install-dev
make run
# → open http://127.0.0.1:8000
```

The server boots **PAUSED**. Click **START** in the header to begin pinging
(it auto-stops after 30 min, countdown is visible). Click **+** bottom-right
to add hosts.

## Features

- **254-host scale**, real workload ~50. asyncio.Semaphore caps concurrent
  pings; jittered scheduler avoids subprocess storms.
- **Start/Stop server lifecycle** with 30-min auto-stop timer (`PING_MONITORING_DURATION_S`)
  — perfect for ephemeral diagnostic runs.
- **Groups** as first-class entities: each has a settings page (gear icon ⚙)
  with editable CIDR rules.
- **Suggestions inbox** — when a host's IP matches another group's CIDR,
  the move is *suggested*. Operator accepts/dismisses individually. Never
  auto-moves. Dismissals persist.
- **Per-group toggle**: PAUSE/RESUME a whole section (e.g. disable
  "external" for air-gapped deploy, keep it listed but collapsed).
- **IP-sorted alternative view** — toggle GROUPS / IP in header.
- **Live sync** — multiple browser tabs stay in sync via WebSocket.
- **EN + IT** UI, theme light/dark, persisted in localStorage.
- **SQLite history** with retention (7 d samples, 30 d events).
- **Outage events** auto-emitted (3 consecutive failures → outage_start,
  recovery → outage_end).
- **Air-gapped install**: offline tar.gz bundle (`tools/build_bundle.sh`)
  with vendored wheels + Chart.js + Inter fonts. No CDN at runtime.

## Documentation

- [`00_infos/prd.md`](00_infos/prd.md) — Product Requirements (v0.3)
- [`00_infos/prd-plan.md`](00_infos/prd-plan.md) — Implementation plan
- [`00_infos/acceptance.md`](00_infos/acceptance.md) — v1 acceptance checklist
- [`00_infos/audits/final-mega-loop.md`](00_infos/audits/final-mega-loop.md) — GPT+Opus audit
- [`00_infos/untitled.pen`](00_infos/untitled.pen) — Design system (Pencil)
- [`00_infos/repo-contract.yaml`](00_infos/repo-contract.yaml) — Machine-readable metadata

## Development

```bash
make venv          # create .venv
make install-dev   # install dev + runtime deps
make run           # start dev server on http://127.0.0.1:8000
make test          # 60+ pytest in ~10 s
make lint          # ruff
make format        # ruff format + black
make check         # lint + test
make lock          # recompile requirements*.txt via pip-tools
```

### Layout

```
src/netping/          # Python package
  app.py              # FastAPI lifespan + factory + WS endpoint
  api.py              # REST CRUD: hosts, groups, group CIDRs, suggestions, monitoring
  config.py           # pydantic Settings (env prefix PING_)
  monitoring.py       # start/stop lifecycle + auto-stop timer
  pinger.py           # asyncio ping engine + scheduler (Semaphore, jitter)
  store.py            # SQLite WAL + batched async writer + retention
  parser.py           # ICMP ping output parser
  ws.py               # WebSocket hub with per-client timeout fan-out
tests/                # 60+ pytest; characterisation fixtures under fixtures/
static/               # Single-page UI (Vanilla JS modules, no build step)
  vendor/             # Vendored Chart.js + Inter font (air-gap requirement)
  i18n/               # en.json + it.json
deploy/               # systemd unit + env template
tools/                # build_bundle.sh + verify_bundle_offline.sh
00_infos/             # PRD, plan, audits, acceptance checklist
```

### UI key actions

| Action                          | How |
|---------------------------------|-----|
| Open host detail (chart, log)   | Click a host card |
| Edit a host                     | Shift+Click a host card |
| Add a host                      | **+** floating button bottom-right |
| Open group settings (CIDR list) | ⚙ gear icon in group header |
| Pause / resume a group          | PAUSE / RESUME button in group header |
| Collapse / expand a group       | ▼ / ▶ caret in group header |
| Accept move suggestion          | ACCEPT in suggestions inbox |
| Dismiss suggestion (persistent) | DISMISS in suggestions inbox |
| Switch group / IP view          | GROUPS / IP toggle (above the host list) |
| Start / stop monitoring         | START / STOP button in header (countdown) |

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
