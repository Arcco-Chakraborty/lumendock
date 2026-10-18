# One-time setup for LumenDock on Windows (a release package or a source checkout).
# Installs the hub's dependencies, offers to fetch Android platform-tools (adb) from Google,
# and puts a LumenDock icon on the desktop. Nothing is set to start with Windows.
#
#   install.ps1 [-Yes] [-NoShortcut]
param([switch]$Yes, [switch]$NoShortcut)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lumendock.ps1')

'LumenDock setup'
''
$node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'Node.js 24 is required. Install it from https://nodejs.org (the 24.x LTS), then run Install again.' }
$version = (& $node.Source --version).Trim()
if ($version -notmatch '^v24\.') { throw "Node.js 24 is required; found $version. Install the 24.x LTS from https://nodejs.org, then run Install again." }
"Node.js $version"

Initialize-Build
'Hub ready.'

if (Find-Adb) { "adb: $(Find-Adb)" }
else {
  $answer = $(if ($Yes) { 'y' } else { Read-Host 'adb (Android platform-tools) was not found. Download it from Google now? [Y/n]' })
  if ($answer -eq '' -or $answer -match '^[yY]') {
    $target = Join-Path $env:LOCALAPPDATA 'Android'
    $zip = Join-Path $env:TEMP "platform-tools-$([guid]::NewGuid().ToString('n')).zip"
    try {
      Invoke-WebRequest -UseBasicParsing 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile $zip
      New-Item -ItemType Directory -Force $target | Out-Null
      Expand-Archive -Force $zip $target
    } finally { Remove-Item $zip -ErrorAction SilentlyContinue }
    $adb = Join-Path $target 'platform-tools\adb.exe'
    $signer = (Get-AuthenticodeSignature $adb).SignerCertificate.Subject
    if ($signer -notmatch 'O=Google LLC') { Remove-Item -Recurse -Force (Join-Path $target 'platform-tools'); throw 'The downloaded adb is not signed by Google; it was removed.' }
    "adb: $adb"
  } else { 'Skipped. Put adb on PATH or in %LOCALAPPDATA%\Android\platform-tools before connecting the phone.' }
}

if (-not $NoShortcut) { Set-Shortcut }

''
'Done. Next:'
'  1. Plug the phone in by USB and tap "Allow USB debugging" on it.'
'  2. Double-click LumenDock on the desktop. Its tray icon (under ^ if hidden) starts the hub.'
'  3. In the tray menu choose "Pair phone..." and type the code on the phone.'
'Optional: Claude usage (npm run claude-usage -- on) and notifications: see docs\WINDOWS.md.'
