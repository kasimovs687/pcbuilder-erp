# =============================================================================
#  PCBuilder ERP - server launcher.
#  Finds Node.js 22.5+, starts server.js and lets the browser opener follow the
#  real port from data\port.txt.
#
#  NOTE: this file is intentionally pure ASCII. Windows PowerShell 5.1 reads
#  .ps1 files using the ANSI code page, so non-ASCII text here would break the
#  parser. All Russian messages are printed by start.bat instead.
# =============================================================================
[CmdletBinding()]
param(
  [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Line { param([string]$t = '') Write-Host $t }

# --- 1. Locate Node.js -------------------------------------------------------
$candidates = @()
if ($NodeExe) { $candidates += $NodeExe }
$candidates += @(
  (Join-Path $root 'runtime\node.exe'),
  (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
  (Join-Path $env:LocalAppData 'Programs\nodejs\node.exe'),
  (Join-Path $env:APPDATA 'nvm\node.exe'),
  (Join-Path $env:USERPROFILE '.workbuddy-ai\binaries\node\versions\current\node.exe')
)

$node = $null
foreach ($c in $candidates) {
  if ($c -and (Test-Path -LiteralPath $c)) { $node = $c; break }
}
if (-not $node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}

if (-not $node) {
  Line 'NODE_NOT_FOUND'
  exit 2
}

$ver = (& $node -v) 2>&1
Line ('NODE_OK ' + $ver + ' ' + $node)

$major = 0
$minor = 0
if ($ver -match 'v(\d+)\.(\d+)') {
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
}
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
  Line ('NODE_OLD ' + $ver)
}

# --- 2. Data folder ----------------------------------------------------------
$dataDir = Join-Path $root 'data'
if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
$portFile = Join-Path $dataDir 'port.txt'
if (Test-Path -LiteralPath $portFile) { Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue }

# --- 3. Browser opener -------------------------------------------------------
$opener = Join-Path $PSScriptRoot 'open-browser.cmd'
if (Test-Path -LiteralPath $opener) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $opener + '"') -WindowStyle Minimized | Out-Null
}

# --- 4. Run the server -------------------------------------------------------
#  Node 22.x needs --experimental-sqlite; Node 23.4+ ships node:sqlite by default.
$sqliteFlag = @()
if ($major -lt 24) { $sqliteFlag = @('--experimental-sqlite') }
if (-not $env:NODE_NO_WARNINGS) { $env:NODE_NO_WARNINGS = '1' }

Line 'SERVER_START'
& $node @sqliteFlag 'server.js'
$code = $LASTEXITCODE

if ($code -ne 0 -and $sqliteFlag.Count -gt 0) {
  Line 'SERVER_RETRY'
  & $node 'server.js'
  $code = $LASTEXITCODE
}

Line ('SERVER_STOPPED ' + $code)
exit $code
