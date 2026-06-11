# Docker Desktop On macOS

This Compose profile is for testing `ping.me` on macOS with Docker Desktop.
It runs the same Linux application image as the Linux deployment, but uses a
macOS-friendly networking model.

## Why This File Exists

The production `compose.yaml` uses:

```yaml
network_mode: host
```

That is the right choice on a real Linux LAN server, where the container can use
the host network namespace and discover Linux host interfaces.

On Docker Desktop for macOS, containers run inside a Linux VM. Docker Desktop
supports host networking in recent versions, but it is not equivalent to Linux
host networking for this app: the container still has no direct access to the
Mac's physical interfaces, and protocols below TCP/UDP are not supported by the
Docker Desktop host-network feature. `ping.me` uses ICMP ping, so the most useful
macOS test setup is a normal Docker Desktop bridge network with explicit port
publishing and ICMP capability.

## Start On macOS

```bash
docker compose -f compose.macos.yaml up --build
```

Run in the background:

```bash
docker compose -f compose.macos.yaml up -d --build
```

Open:

```text
http://127.0.0.1:8000/
```

If port `8000` is already in use on the Mac:

```bash
PING_MACOS_HTTP_PORT=8003 docker compose -f compose.macos.yaml up --build
# open http://127.0.0.1:8003/
```

Inspect:

```bash
docker compose -f compose.macos.yaml ps
docker compose -f compose.macos.yaml logs -f
docker volume inspect ping-app-macos_ping_app_macos_data
```

Stop without deleting persisted SQLite data:

```bash
docker compose -f compose.macos.yaml down
```

Delete persisted macOS test data:

```bash
docker compose -f compose.macos.yaml down -v
```

## What This Tests Well

- The production Linux container image build.
- The FastAPI server and static web interface.
- SQLite persistence in a Docker volume.
- WebSocket live updates.
- The ping subprocess inside the Linux container.
- LAN reachability from Docker Desktop's Linux VM/NAT path.

## Known Limits

- The interface selector in the hero reports interfaces from the Linux
  container/VM network namespace, not the Mac's physical `en0`, `en1`, etc.
- ICMP packets originate from Docker Desktop's Linux networking path, not from a
  native macOS process.
- If the goal is validating exact Mac LAN-interface behavior, use the native
  macOS runbook in [`README-native.md`](README-native.md). A real Linux host or
  bridged Linux VM remains the best match for Linux production deployment.

## Quick Verification

```bash
docker compose -f compose.macos.yaml config
docker compose -f compose.macos.yaml up -d --build
curl -fsS http://127.0.0.1:8000/api/info
docker compose -f compose.macos.yaml exec -T ping-app ping -c 1 -W 1 127.0.0.1
docker compose -f compose.macos.yaml exec -T ping-app test -f /var/lib/ping-app/ping.db
docker compose -f compose.macos.yaml down
```
