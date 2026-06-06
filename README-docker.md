# Docker Compose Deployment

This app is prepared for Docker Compose on a local Linux server in a trusted
private LAN.

## Runtime Model

- Compose service: `ping-app`
- Image name: `ping-app:local`
- Container name: `ping-app`
- HTTP bind: `0.0.0.0:8000`
- LAN URL: `http://<linux-host-ip>:8000/`
- Local host URL: `http://127.0.0.1:8000/`
- Network mode: `host`
- Database path in container: `/var/lib/ping-app/ping.db`
- Docker volume: `ping-app_ping_app_data`

`network_mode: host` is intentional. The dashboard discovers network
interfaces and runs ICMP pings from the Linux host network namespace. A normal
Docker bridge network would expose container interfaces instead of the host LAN
interfaces and would make network diagnostics misleading.

Because host networking is used, `compose.yaml` does not define `ports:`. Open
TCP/8000 on the Linux firewall if other LAN clients cannot reach the dashboard.

## Start

```bash
docker compose up --build
```

Run in the background:

```bash
docker compose up -d --build
```

Inspect:

```bash
docker compose ps
docker compose logs -f
docker volume inspect ping-app_ping_app_data
```

Stop without deleting persisted SQLite data:

```bash
docker compose down
```

## Persistence

All app state is SQLite and lives in the named Docker volume:

```text
ping-app_ping_app_data:/var/lib/ping-app
```

The app creates:

```text
/var/lib/ping-app/ping.db
```

Do not delete the volume unless host/group/history data can be discarded.

## Secrets

There are no runtime secrets by default. Environment values in `compose.yaml`
are plain app settings for bind address, port, retention, ping concurrency, and
database path.

## Verification Performed

The Docker setup was verified from commit `9ed4d63` on `main`:

```bash
make lint
make test
docker compose config
docker compose build
docker compose up -d
docker compose ps
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/info
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/
docker compose exec -T ping-app ping -c 1 -W 1 127.0.0.1
docker compose exec -T ping-app test -f /var/lib/ping-app/ping.db
```

Observed results:

- `make lint`: passed
- `make test`: 74 tests passed
- Docker image build: passed
- Compose service: `healthy`
- `/api/info`: HTTP 200
- `/`: HTTP 200
- ICMP ping inside container: passed
- SQLite database in the Docker volume: present

The local verification host used Docker's Linux environment. On a real Linux LAN
server, the same host-network Compose setup is the intended deployment path.
