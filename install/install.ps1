# Motion Reel Kit installer for Windows (PowerShell 5.1+ or 7+). Makes /motion-reel available in EVERY Claude Code project.
# (macOS/Linux: install/install.sh. Or just run `make install`, which picks the right one.)
#
#   powershell -ExecutionPolicy Bypass -File install\install.ps1                  install for your user (~\.claude\skills\motion-reel)
#   powershell -ExecutionPolicy Bypass -File install\install.ps1 -Project <dir>   install into one project only (<dir>\.claude\skills\motion-reel)
#
# It copies the skill + presets, installs Playwright + Chromium next to the skill, and installs the Python audio
# libraries. Safe to re-run: an existing install is moved to a backup OUTSIDE the skills folder (a backup inside it
# would load as a second, duplicate skill).
param([string]$Project = '')
$ErrorActionPreference = 'Stop'
$Kit = Split-Path -Parent $PSScriptRoot
if ($Project) {
  if (-not (Test-Path $Project -PathType Container)) { Write-Host "no such folder: $Project"; exit 1 }
  $Base = Join-Path (Resolve-Path $Project).Path '.claude'
} else {
  $Base = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
}
$Dest = Join-Path $Base 'skills\motion-reel'

function Say($m)  { Write-Host ""; Write-Host $m -ForegroundColor White }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host $m -ForegroundColor Red; exit 1 }
function Has($c)  { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
# Run a native command quietly and return its exit code. Windows PowerShell 5.1 turns any stderr output of a native
# command into a terminating error under $ErrorActionPreference='Stop' (pip, npm and the python3 Store stub all write
# to stderr), so errors are relaxed inside and the exit code is checked instead.
function Native([scriptblock]$Sb) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $Sb *> $null } finally { $ErrorActionPreference = $old }
  return $LASTEXITCODE
}

Say '1/4  Checking tools'
# node managed by fnm is only on PATH after `fnm env`: load it if needed
if (-not (Has 'node') -and (Has 'fnm')) {
  fnm env --use-on-cd --shell power-shell | Out-String | Invoke-Expression
  Native { fnm use } | Out-Null
}
if (-not (Has 'node')) { Die 'Node is missing. Install Node 22+ (winget install OpenJS.NodeJS.LTS) and re-run.' }
if (-not (Has 'npm'))  { Die 'npm is missing. It ships with Node: reinstall Node 22+ and re-run.' }
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -ge 20) { Ok "node $(node -v)" } else { Warn "node $(node -v) is old; Node 22+ is recommended" }
if (-not (Has 'ffmpeg')) { Die 'ffmpeg is missing. Install it (winget install Gyan.FFmpeg), open a NEW terminal and re-run.' }
Ok 'ffmpeg'
# a working Python 3.9+. The Microsoft Store "python3" stub exists on PATH but fails to run, so test each candidate.
$Py = $null
foreach ($c in 'python', 'python3', 'py') {
  if (Has $c) {
    if ((Native { & $c -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' }) -eq 0) { $Py = $c; break }
  }
}
if (-not $Py) { Die 'Python 3.9+ is missing. Install it (winget install Python.Python.3.12) and re-run.' }
Ok "$Py $(& $Py -c 'import sys;print(sys.version.split()[0])')"

Say "2/4  Installing the skill -> $Dest"
New-Item -ItemType Directory -Force (Join-Path $Base 'skills') | Out-Null
if (Test-Path $Dest) {
  $backupRoot = Join-Path $Base 'skills-backup'
  New-Item -ItemType Directory -Force $backupRoot | Out-Null
  $bk = Join-Path $backupRoot ("motion-reel-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Move-Item $Dest $bk; Ok "previous install moved to $bk"
}
Copy-Item (Join-Path $Kit '.claude\skills\motion-reel') $Dest -Recurse
Copy-Item (Join-Path $Kit 'presets') (Join-Path $Dest 'presets') -Recurse
Copy-Item (Join-Path $Kit 'package.json') (Join-Path $Dest 'package.json')
Ok 'skill, engine, scripts, templates and presets copied'

Say '3/4  Installing Playwright + Chromium (for rendering)'
Push-Location $Dest
try {
  if ((Native { npm install --silent --no-audit --no-fund }) -ne 0) { Die "npm install failed in $Dest" }
  if ((Native { npx --yes playwright install chromium }) -ne 0) { Die "playwright install failed in $Dest" }
  if ((Native { node -e "require('playwright').chromium.launch().then(b => b.close())" }) -ne 0) { Die 'Chromium was installed but does not launch. Re-run, or run: npx playwright install chromium' }
} finally { Pop-Location }
Ok 'playwright + chromium ready (launch tested)'

Say '4/4  Installing Python audio libraries (numpy, scipy, soundfile, librosa, pillow)'
$req = Join-Path $Kit 'requirements.txt'
if ((Native { & $Py -c 'import numpy, scipy, soundfile, librosa, PIL' }) -eq 0) { Ok 'already installed' }
else {
  $rc = Native { & $Py -m pip install --user -q -r $req }
  if ($rc -ne 0) { $rc = Native { & $Py -m pip install -q -r $req } }
  if ($rc -eq 0) { Ok 'installed' }
  else { Warn 'pip could not install them. Music, beat grid and mix need them.'; Write-Host "    Fix: run  $Py -m pip install -r requirements.txt  and read 'Troubleshooting' in $Kit\README.md." }
}

Say 'Done.'
Write-Host '  Start a NEW Claude Code session (skills load when a session starts), open any project, and type:'
Write-Host ''
Write-Host '    /motion-reel a 15-second launch reel for https://yoursite.com'
Write-Host ''
if (-not $Project) { Write-Host '  Tip: copy CLAUDE.md from this kit into a project root to make the motion rules apply to everything there.' }
