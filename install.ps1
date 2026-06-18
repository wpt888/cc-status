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

# Resolve an ABSOLUTE node.exe path. A bare `node` in the command depends on
# PATH being correct in whatever context Claude Code spawns the status line —
# which is unreliable with nvm-for-windows (the C:\nvm4w\nodejs symlink is only
# present after `nvm use`) and varies between terminals/IDEs. Pinning the
# interpreter makes the status line render from any directory / any launch env.
function Resolve-NodeExe {
  # Prefer a stable, non-nvm system install (always present, immune to nvm state).
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return (Resolve-Path $c).Path }
  }
  # Fall back to whatever `node` resolves to on PATH (e.g. the nvm symlink).
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$nodeExe = Resolve-NodeExe
if (-not $nodeExe) {
  Write-Error "node.exe not found. Install Node.js (>=16) or ensure 'node' is on PATH, then re-run."
  exit 1
}

# Load, patch, save. Use forward slashes in paths (valid on Windows, avoids JSON escaping pain).
$cmdPath  = ($statuslineJs -replace '\\', '/')
$nodePath = ($nodeExe -replace '\\', '/')
$json = Get-Content $settingsPath -Raw | ConvertFrom-Json

$statusLine = [PSCustomObject]@{
  type            = 'command'
  command         = "`"$nodePath`" `"$cmdPath`""
  refreshInterval = 30
}

if ($json.PSObject.Properties.Name -contains 'statusLine') {
  $json.statusLine = $statusLine
} else {
  $json | Add-Member -MemberType NoteProperty -Name 'statusLine' -Value $statusLine
}

$json | ConvertTo-Json -Depth 100 | Set-Content $settingsPath -Encoding utf8
Write-Host "cc-status installed. Start a new Claude Code session to see it."
Write-Host "Command: `"$nodePath`" `"$cmdPath`""
