# ping.me

`ping.me` is a server-hosted LAN ping monitor with a browser interface. It stores
hosts and groups on the server, runs ping tests from the server network stack,
and shows live results through an animated web UI.

The app is meant for a machine inside the LAN: open it from a browser, add hosts,
choose the ping interval and packet count, start the test, and inspect group,
dashboard, and per-host latency views.

## Quick Start

```bash
git clone git@github.com:sgm9p6bp4v-prog/ping-app.git
cd ping-app
make install-dev
make run
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000).

The development server binds to `127.0.0.1`. For LAN access on a server, bind to
`0.0.0.0` or use the systemd deployment described below.

## How The Test Works

The hero sentence controls the ping run:

```text
ping.me every x seconds and send y packets to the host.
```

- `x` is the interval, in seconds, between ping attempts for each active host.
- `y` is the number of ping attempts per active host before the test stops.
- The default values are `x = 1` and `y = 10`.
- `y` accepts values from `1` to `1000`.
- If `y` is empty, the UI switches it to `∞` and the test runs until the user
  presses `STOP`.

Each sample is one ping attempt. Successful and failed attempts both count
toward `y`. Disabled hosts and paused groups are excluded from the active run.

Example: with 15 active hosts, `x = 1`, and `y = 10`, the app attempts about
`15 * 10 = 150` total pings. The run lasts roughly 10 seconds, but real duration
can be longer when hosts are slow or offline because each ping can wait for the
configured timeout.

## Current Interface

The UI is a horizontal page sequence:

- **Hero**: choose interval, packet count, and the server network interface used
  for pinging. `START` begins the test and moves to the results page.
- **Results**: host groups are shown as animated bubbles. Hosts inside each
  bubble show their live state. Use `GROUPS / ALL` to switch between grouped and
  combined views.
- **Dashboard**: a 2x2 summary with active-host percentage, average response
  time, and sent/returned/lost packet counts.
- **Host detail**: click a host to open its latency history. The view shows the
  last sixty seconds of latency as vertical bars; offline or zero-latency samples
  have zero height.

Common actions:

| Action | How |
| --- | --- |
| Start or stop monitoring | `START` / `STOP` on the hero |
| Add a host | `+` floating button |
| Open host details | Click a host |
| Edit a host | Shift-click a host |
| Pause or resume a group | Right-click the group bubble |
| Delete a group | Use the `x` control inside the group bubble and confirm |
| Switch grouped/all-host view | `GROUPS / ALL` toggle |
| Change ping interface | Click the interface line below the hero sentence |
| Move between pages | Use the large navigation arrows or controlled scroll |

## Features

- Server-side ping scheduler using `asyncio`.
- One ping packet per host sample.
- Concurrent ping limit via `PING_MAX_CONCURRENT_PINGS`.
- Initial jitter so all hosts do not ping at the same millisecond.
- Packet-limited and infinite monitoring runs.
- Network-interface discovery and selection, persisted in SQLite.
- Persistent host, group, settings, samples, events, and suggestion data.
- SQLite WAL storage with sample and event retention.
- WebSocket live sync across browser tabs.
- Group pause/resume and group deletion with confirmation.
- Automatic outage events after repeated failures, with recovery events.
- Italian and English UI strings.
- Light/dark theme persisted in browser storage.
- Offline-friendly deployment bundle with vendored frontend assets.

## Persistence

Host and group data is stored on the server in SQLite.

Development default:

```text
data/ping.db
```

Systemd deployment default:

```text
/var/lib/ping-app/ping.db
```

Restarting the web server does not delete hosts, groups, settings, or history.
Back up the SQLite database if the host list and monitoring history matter.

## Development

```bash
make venv          # create .venv
make install       # install runtime dependencies
make install-dev   # install runtime + test/dev dependencies
make run           # start dev server on http://127.0.0.1:8000
make test          # run pytest
make lint          # run ruff
make format        # run ruff format + black
make check         # lint + test
make lock          # recompile requirements*.txt with pip-tools
```

The current test suite contains 70+ tests.

## Docker Compose (Linux LAN)

For a local Linux server, run the app with Docker Compose:

```bash
docker compose up --build
# open http://<server-ip>:8000/ from any host in the LAN
# or http://127.0.0.1:8000/ on the server itself
```

The Compose setup uses `network_mode: host` on purpose. The dashboard discovers
network interfaces and runs ICMP pings from the server's network namespace; a
normal Docker bridge network would show container interfaces instead of the host
LAN. Because host networking is used, Compose does not publish `ports:`. The app
binds to `0.0.0.0:8000`, so it is reachable from the server and from other LAN
clients if the Linux firewall allows inbound TCP/8000.

SQLite state is stored in the named Docker volume `ping_app_data`, mounted at
`/var/lib/ping-app`. The default database path is
`/var/lib/ping-app/ping.db`. There are no runtime secrets by default; environment
values are plain Compose settings and can be adjusted in `compose.yaml`.

Useful commands:

```bash
docker compose ps
docker compose logs -f
docker compose down
docker volume inspect ping-app_ping_app_data
```

See [`README-docker.md`](README-docker.md) for the full Linux LAN Docker runbook
and the verification commands used for this setup.

## Project Layout

```text
src/netping/
  app.py              FastAPI app factory, lifespan, static UI mount
  api.py              REST API for hosts, groups, monitoring, network interface
  config.py           PING_ environment settings
  monitoring.py       start/stop lifecycle, packet limit tracking
  network.py          interface discovery and ping binding helpers
  parser.py           ping output parsing
  pinger.py           asyncio ping scheduler
  store.py            SQLite persistence and retention
  ws.py               WebSocket fan-out

static/
  index.html          single-page browser UI
  css/                app styling and ping.me visual overrides
  js/                 vanilla JS modules
  i18n/               English and Italian strings
  vendor/             vendored frontend assets

tests/                pytest suite and ping-output fixtures
deploy/               systemd unit and environment template
tools/                offline bundle build and verification scripts
00_infos/             product notes, acceptance notes, and audits
```

## Configuration

Settings are loaded from environment variables with the `PING_` prefix.

Useful values:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PING_BIND_HOST` | `0.0.0.0` | Host/interface for the HTTP server |
| `PING_PORT` | `8000` | HTTP port |
| `PING_DB_PATH` | `data/ping.db` | SQLite database path |
| `PING_MAX_CONCURRENT_PINGS` | `64` | Max simultaneous ping subprocesses |
| `PING_DEFAULT_INTERVAL_S` | `1.0` | Default host interval for new hosts |
| `PING_PING_TIMEOUT_S` | `2.0` | Ping timeout per attempt |
| `PING_SAMPLE_RETENTION_DAYS` | `7` | Sample retention |
| `PING_EVENT_RETENTION_DAYS` | `30` | Event retention |
| `PING_MONITORING_DURATION_S` | `1800` | Legacy API auto-stop duration |

The current web UI sends a packet limit when starting monitoring. The legacy
duration setting is still used by API clients that start monitoring without a
packet-limit payload.

## Deploy On A LAN Server

Build an offline bundle on a machine with internet access:

```bash
make install-dev
tools/build_bundle.sh
tools/verify_bundle_offline.sh dist/ping-app-*.tar.gz
```

Transfer the bundle to the server and install:

```bash
sudo tar -xzf ping-app-<version>.tar.gz -C /tmp/
sudo /tmp/ping-app-<version>/install.sh
```

Defaults:

| Item | Path |
| --- | --- |
| App user/group | `ping-app` |
| Code | `/opt/ping-app` |
| Data | `/var/lib/ping-app/ping.db` |
| Environment | `/etc/ping-app/env` |
| Service | `ping-app.service` |

Inspect and control the service:

```bash
systemctl status ping-app
journalctl -u ping-app -f
systemctl restart ping-app
```

Open the app from another LAN browser:

```text
http://<server-ip>:8000/
```

## Backup And Restore

All application state lives in SQLite. In production, back up:

```text
/var/lib/ping-app/ping.db
/etc/ping-app/env
```

Online backup:

```bash
sudo sqlite3 /var/lib/ping-app/ping.db ".backup '/srv/backup/ping-$(date +%F).db'"
sudo cp /etc/ping-app/env /srv/backup/env-$(date +%F)
```

Restore:

```bash
sudo systemctl stop ping-app
sudo install -o ping-app -g ping-app -m 0640 backup.db /var/lib/ping-app/ping.db
sudo install -o root -g ping-app -m 0640 env /etc/ping-app/env
sudo systemctl start ping-app
```

`install.sh` is idempotent and does not wipe `/var/lib/ping-app`.

## License

[MIT](LICENSE). Vendored libraries keep their original licenses.
