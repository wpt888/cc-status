<#
.SYNOPSIS
  Install cc-status as the Claude Code status line.
.DESCRIPTION
  Backs up ~/.claude/settings.json, then sets the `statusLine` block to run
  this folder's statusline.js with a 30s refresh interval. Idempotent — safe
  to re-run.
#>

$ErrorActionPreference = 'Stop'

$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$statuslineJs = Join-Path $scriptDir 'statusline.js'
if (-not (Test-Path $statuslineJs)) {
  Write-Error "statusline.js not found next to install.ps1 ($statuslineJs)"
  exit 1
}

$settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
if (-not (Test-Path $settingsPath)) {
  Write-Error "Claude Code settings not found at $settingsPath"
  exit 1
}

# Back up first.
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$settingsPath.cc-status-backup-$stamp"
Copy-Item $settingsPath $backup
Write-Host "Backed up settings to $backup"

# Load, patch, save. Use forward slashes in the command (valid on Windows, avoids JSON escaping pain).
$cmdPath = ($statuslineJs -replace '\\', '/')
$json = Get-Content $settingsPath -Raw | ConvertFrom-Json

$statusLine = [PSCustomObject]@{
  type            = 'command'
  command         = "node `"$cmdPath`""
  refreshInterval = 30
}

if ($json.PSObject.Properties.Name -contains 'statusLine') {
  $json.statusLine = $statusLine
} else {
  $json | Add-Member -MemberType NoteProperty -Name 'statusLine' -Value $statusLine
}

$json | ConvertTo-Json -Depth 100 | Set-Content $settingsPath -Encoding utf8
Write-Host "cc-status installed. Start a new Claude Code session to see it."
Write-Host "Command: node `"$cmdPath`""
