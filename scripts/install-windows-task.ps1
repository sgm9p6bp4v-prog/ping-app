[CmdletBinding()]
param(
    [string]$TaskName = "ping.me",
    [string]$BindHost = "0.0.0.0",
    [int]$Port = 8000,
    [string]$DataDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunScript = Join-Path $PSScriptRoot "run-windows.ps1"
if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = if ($env:LOCALAPPDATA) {
        Join-Path $env:LOCALAPPDATA "ping.me"
    } else {
        Join-Path $Root "data"
    }
}

$Arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$RunScript`"",
    "-BindHost", "`"$BindHost`"",
    "-Port", $Port,
    "-DataDir", "`"$DataDir`""
) -join " "

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument $Arguments `
    -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Starts the ping.me LAN ping dashboard at user logon." `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed scheduled task '$TaskName'"
Write-Host "URL: http://$BindHost`:$Port/"
Write-Host "Database directory: $DataDir"
