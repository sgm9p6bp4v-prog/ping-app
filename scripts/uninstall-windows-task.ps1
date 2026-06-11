[CmdletBinding()]
param(
    [string]$TaskName = "ping.me"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Uninstalled scheduled task '$TaskName'"
