# ping.me Windows 11 USB Install

This bundle runs `ping.me` natively on Windows 11. Native mode is recommended
for Windows testing because the app can inspect the Windows network stack
directly instead of running inside Docker Desktop's Linux VM.

## What Is Included

- App source code and static web UI.
- PowerShell run and install scripts.
- `requirements-windows.txt`, without Unix-only `uvloop`.
- Optional `wheelhouse/` with Windows x64 Python 3.12 wheels for offline
  dependency installation.

## Windows Requirements

- Windows 11 x64.
- Python 3.12 x64 installed.
- During Python installation, enable **Add python.exe to PATH**.

If the target PC has no internet, install Python 3.12 x64 before going offline
or transfer the official Python installer on the same USB drive.

## Copy From USB

1. Copy the `ping-me-windows-usb` folder from the USB drive to:

   ```text
   C:\ping-me
   ```

2. Open PowerShell.

3. Move into the copied folder:

   ```powershell
   cd C:\ping-me\ping-me-windows-usb
   ```

## Start The App

Run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\run-windows.ps1
```

Open:

```text
http://127.0.0.1:8000/
```

The first run creates `.venv` and installs the dependencies. If `wheelhouse/`
exists in the bundle, installation uses those local wheels and does not need
internet.

Stop the app with `Ctrl+C` in PowerShell.

## LAN Access

The script binds to `0.0.0.0:8000` by default, so other clients on the same LAN
can open:

```text
http://<windows-pc-ip>:8000/
```

If Windows Firewall blocks the page from other devices, open PowerShell as
Administrator and run:

```powershell
New-NetFirewallRule -DisplayName "ping.me HTTP 8000" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8000
```

## Start Automatically At Login

From PowerShell in the app folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-windows-task.ps1
```

Remove the scheduled task:

```powershell
.\scripts\uninstall-windows-task.ps1
```

## Data And Backup

The database is stored here by default:

```text
%LOCALAPPDATA%\ping.me\ping.db
```

Back up that file to preserve hosts, groups, settings, and history.

## Interface Notes

The hero interface selector uses Windows `Get-NetIPConfiguration`, so it should
show adapter names such as `Ethernet` and `Wi-Fi`.

Windows `ping.exe` can bind a source address with `-S` only for IPv6. For IPv4
LAN hosts, the app records the selected adapter in the UI, but the actual ping
path follows the Windows routing table.

## Troubleshooting

If PowerShell says scripts are disabled, run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

If Python is not found, install Python 3.12 x64 and reopen PowerShell.

If offline dependency installation fails, confirm that:

- You are using Python 3.12 x64.
- The bundle contains the `wheelhouse/` folder.
- You are running from the extracted folder, not directly inside the ZIP.
