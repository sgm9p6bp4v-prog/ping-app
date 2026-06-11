[CmdletBinding()]
param(
    [string]$BindHost = "",
    [int]$Port = 0,
    [string]$DataDir = "",
    [string]$DbPath = "",
    [string]$Python = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Venv = if ($env:PING_VENV_PATH) { $env:PING_VENV_PATH } else { Join-Path $Root ".venv" }
$WindowsRequirements = Join-Path $Root "requirements-windows.txt"
$Requirements = if (Test-Path $WindowsRequirements) {
    $WindowsRequirements
} else {
    Join-Path $Root "requirements.txt"
}
$Wheelhouse = Join-Path $Root "wheelhouse"
$InstallMarker = Join-Path $Venv ".pingme-requirements-installed"

if ([string]::IsNullOrWhiteSpace($BindHost)) {
    $BindHost = if ($env:PING_BIND_HOST) { $env:PING_BIND_HOST } else { "0.0.0.0" }
}
if ($Port -le 0) {
    $Port = if ($env:PING_PORT) { [int]$env:PING_PORT } else { 8000 }
}
if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = if ($env:PING_DATA_DIR) {
        $env:PING_DATA_DIR
    } elseif ($env:LOCALAPPDATA) {
        Join-Path $env:LOCALAPPDATA "ping.me"
    } else {
        Join-Path $Root "data"
    }
}
if ([string]::IsNullOrWhiteSpace($DbPath)) {
    $DbPath = if ($env:PING_DB_PATH) { $env:PING_DB_PATH } else { Join-Path $DataDir "ping.db" }
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$PythonCommand = $Python
$PythonArgs = @()
if ([string]::IsNullOrWhiteSpace($PythonCommand)) {
    if ($env:PING_PYTHON) {
        $PythonCommand = $env:PING_PYTHON
    } elseif (Get-Command py -ErrorAction SilentlyContinue) {
        $PythonCommand = "py"
        $PythonArgs = @("-3")
    } else {
        $PythonCommand = "python"
    }
}

$PyExe = Join-Path $Venv "Scripts\python.exe"
if (-not (Test-Path $PyExe)) {
    & $PythonCommand @PythonArgs -m venv $Venv
}

$ShouldInstall = -not (Test-Path $InstallMarker)
if (-not $ShouldInstall) {
    $ShouldInstall = (Get-Item $Requirements).LastWriteTimeUtc -gt `
        (Get-Item $InstallMarker).LastWriteTimeUtc
}
if ($ShouldInstall) {
    $WheelFiles = @()
    if (Test-Path $Wheelhouse) {
        $WheelFiles = @(Get-ChildItem -Path $Wheelhouse -Filter "*.whl" -File)
    }
    if ($WheelFiles.Count -gt 0) {
        & $PyExe -m pip install --no-index --find-links $Wheelhouse -r $Requirements
    } else {
        & $PyExe -m pip install -r $Requirements
    }
    New-Item -ItemType File -Force -Path $InstallMarker | Out-Null
}

$env:PYTHONPATH = Join-Path $Root "src"
$env:PING_BIND_HOST = $BindHost
$env:PING_PORT = [string]$Port
$env:PING_DB_PATH = $DbPath

Write-Host "ping.me native Windows server"
Write-Host "URL: http://$BindHost`:$Port/"
Write-Host "Database: $DbPath"

& $PyExe -m uvicorn netping.app:app `
    --app-dir (Join-Path $Root "src") `
    --host $BindHost `
    --port $Port
