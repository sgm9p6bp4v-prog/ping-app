# Native macOS And Windows Deployment

Use native deployment when `ping.me` must inspect the physical network stack of
the machine running the app. This is the recommended path for macOS and Windows
because Docker Desktop runs containers inside a Linux VM and cannot expose the
host's physical interfaces in the same way a native process can.

## macOS

### One-shot test run

```bash
scripts/run-macos.sh
```

Open:

```text
http://127.0.0.1:8000/
```

The script creates or reuses `.venv`, installs `requirements-windows.txt` when
present, and stores SQLite data in:

```text
~/Library/Application Support/ping.me/ping.db
```

By default the server binds to `0.0.0.0:8000`, so other LAN clients can reach it
through:

```text
http://<mac-ip>:8000/
```

macOS may ask for firewall permission the first time the server accepts LAN
traffic.

### Start automatically at login

```bash
scripts/install-macos-launchd.sh
```

Inspect logs:

```bash
tail -f "$HOME/Library/Logs/ping.me/ping-me.out.log"
tail -f "$HOME/Library/Logs/ping.me/ping-me.err.log"
```

Stop and remove the LaunchAgent:

```bash
scripts/uninstall-macos-launchd.sh
```

The LaunchAgent does not delete the database.

### macOS configuration

Override defaults with environment variables:

```bash
PING_BIND_HOST=127.0.0.1 PING_PORT=8003 scripts/run-macos.sh
PING_DATA_DIR="$HOME/ping-me-data" scripts/run-macos.sh
```

Native macOS interface discovery uses `route`, `ipconfig`, and `ifconfig`.
Selected IPv4 interfaces are applied to ping by passing the interface source
address to macOS `ping`.

### macOS `http://pingme.local/` without port

Keep the native app running on port `8000`, then install the local URL helper:

```bash
scripts/install-macos-local-url.sh
```

This sets the Mac Bonjour name to `pingme.local` and installs a macOS `pf` rule
that forwards HTTP port `80` on this Mac to the app on `127.0.0.1:8000`.

Open:

```text
http://pingme.local/
```

Remove the helper:

```bash
scripts/uninstall-macos-local-url.sh
```

The helper does not stop the app and does not delete the SQLite database.

## Windows

### Requirements

- Windows 10/11 or Windows Server with PowerShell.
- Python 3.11 or newer available as `py -3` or `python`.

### One-shot test run

From PowerShell in the repo root:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\run-windows.ps1
```

Open:

```text
http://127.0.0.1:8000/
```

The script creates or reuses `.venv`, installs `requirements.txt`, and stores
SQLite data in:

```text
%LOCALAPPDATA%\ping.me\ping.db
```

By default the server binds to `0.0.0.0:8000`, so other LAN clients can reach it
through:

```text
http://<windows-ip>:8000/
```

If Windows Firewall blocks inbound access, allow TCP port `8000` for the
network profile you are using.

### Start automatically at user login

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-windows-task.ps1
```

Remove the scheduled task:

```powershell
.\scripts\uninstall-windows-task.ps1
```

The scheduled task starts the app when the current user logs in. It is intended
for realistic testing, not a locked-down production Windows service.

### Windows configuration

Override defaults with script parameters:

```powershell
.\scripts\run-windows.ps1 -BindHost 127.0.0.1 -Port 8003
.\scripts\run-windows.ps1 -DataDir "$env:USERPROFILE\ping-me-data"
.\scripts\install-windows-task.ps1 -BindHost 0.0.0.0 -Port 8000
```

Native Windows interface discovery uses `Get-NetIPConfiguration`, so the hero
selector can show real adapter aliases such as `Ethernet` and `Wi-Fi`.

Windows `ping.exe` can bind a source address with `-S` only for IPv6. For IPv4
LAN targets, ping.me therefore shows the selected adapter and persists the
choice, but the actual IPv4 ping path follows the Windows routing table. If
strict per-interface IPv4 ping is required on Windows, the next step is a small
native ping agent or a raw-ICMP implementation with the necessary privileges.

For USB transfer to a Windows 11 machine, build the ZIP bundle from macOS or
Linux with:

```bash
tools/build_windows_usb_bundle.sh
```

Then follow [`README-windows-usb.md`](README-windows-usb.md) inside the bundle.

## Docker Desktop Comparison

Docker Desktop remains useful on macOS/Windows for checking:

- image build
- UI behavior
- SQLite persistence
- WebSockets
- Linux ping subprocess behavior

It is not the right tool for validating physical macOS/Windows network
interfaces. Use `README-docker-macos.md` only when you specifically want to test
the Linux container path on a Mac.
