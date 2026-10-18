# LumenDock laptop service controller for Windows (the counterpart of phone-monitor.sh).
# Runs the desktop hub and the ADB reverse supervisor as hidden background processes.
# Nothing here registers anything to run at boot or sign-in: services run only while started
# from this script, the tray or the desktop shortcut.
#
#   lumendock.ps1 start [SERIAL] | stop | restart [SERIAL] | status | logs | pair | tray | shortcut [-Remove]
param(
  [Parameter(Position = 0)][string]$Command = '',
  [Parameter(Position = 1)][string]$Serial = '',
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'

$script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:ConfigDir = Join-Path $(if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME '.config' }) 'phone-monitor'
$script:PidFile = Join-Path $script:ConfigDir 'lumendock-windows.pid'
$script:SerialFile = Join-Path $script:ConfigDir 'usb-serial'
$script:StoppedFile = Join-Path $script:ConfigDir 'lumendock-stopped'
$script:PairingFile = Join-Path $script:ConfigDir 'lumendock-pairing.pid'
$script:TokenFile = Join-Path $script:ConfigDir 'phone-token'
$script:HubLog = Join-Path $script:ConfigDir 'hub.log'
$script:ConnectLog = Join-Path $script:ConfigDir 'connect.log'
$script:HubScript = Join-Path $script:Root 'desktop\dist\main.js'
$script:ConnectScript = Join-Path $script:Root 'scripts\connect.mjs'

function Initialize-ConfigDir { if (-not (Test-Path $script:ConfigDir)) { New-Item -ItemType Directory -Force $script:ConfigDir | Out-Null } }

function Find-Node {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) { throw 'Node.js 24 was not found on PATH. Install Node 24 (see .nvmrc).' }
  $node.Source
}

function Find-Adb {
  $candidates = @($env:LUMENDOCK_ADB)
  $onPath = Get-Command adb.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($onPath) { $candidates += $onPath.Source }
  $candidates += (Join-Path $env:LOCALAPPDATA 'Android\platform-tools\adb.exe'), (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe')
  foreach ($path in $candidates) { if ($path -and (Test-Path $path -PathType Leaf)) { return $path } }
  $null
}

function Hide-Serial([string]$value) { if ($value.Length -le 4) { '****' } else { $value.Substring(0, 4) + '****' } }

# Authorized and unauthorized USB phones as reported by `adb devices` (emulators and Wi-Fi debugging excluded).
function Get-UsbDevices {
  $adb = Find-Adb
  if (-not $adb) { return @() }
  $lines = & $adb devices 2>$null
  foreach ($line in $lines | Select-Object -Skip 1) {
    $parts = $line.Trim() -split '\s+'
    if ($parts.Count -lt 2 -or $parts[0] -match ':|^emulator-|_adb|^adb-') { continue }
    [pscustomobject]@{ Serial = $parts[0]; State = $parts[1] }
  }
}

function Read-Pids {
  try { Get-Content $script:PidFile -Raw | ConvertFrom-Json } catch { $null }
}
function Save-Pids($hub, $connect) {
  Initialize-ConfigDir
  [pscustomobject]@{ hub = $hub; connect = $connect } | ConvertTo-Json -Compress | Set-Content -Encoding ascii $script:PidFile
}
# A recorded process counts only if that exact process (same id and start time) is still alive.
function Test-Recorded($entry) {
  if (-not $entry -or -not $entry.pid) { return $false }
  $process = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
  $process -and $process.StartTime.ToUniversalTime().ToString('o') -eq $entry.start
}

# Runs `node <script> <args>` with no window, output appended to a log file. cmd.exe does the
# redirection, so the processes keep running when the tray or this console goes away.
function Start-Hidden([string]$script, [string[]]$arguments, [string]$log) {
  $node = Find-Node
  $quoted = (@($node, $script) + $arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $info.Arguments = '/d /s /c "' + $quoted + ' >> "' + $log + '" 2>&1"'
  $info.WorkingDirectory = $script:Root
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::Start($info)
  [pscustomobject]@{ pid = $process.Id; start = $process.StartTime.ToUniversalTime().ToString('o') }
}

# Processes from this checkout that a lost PID file no longer names.
function Get-StrayProcesses {
  $hub = [regex]::Escape($script:HubScript); $connect = [regex]::Escape($script:ConnectScript)
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $hub -or $_.CommandLine -match $connect }
}

function Get-LumenStatus {
  $pids = Read-Pids
  $hub = Test-Recorded $pids.hub
  $connect = Test-Recorded $pids.connect
  $reverse = $null
  $adb = Find-Adb
  if ($adb) { $reverse = (& $adb reverse --list 2>$null) -join ' ' }
  [pscustomobject]@{ Hub = [bool]$hub; Connect = [bool]$connect; Reverse = $reverse; Devices = @(Get-UsbDevices) }
}

function Show-Status {
  $s = Get-LumenStatus
  'LumenDock background status:'
  if ($s.Hub) { '  [RUNNING] Desktop Hub on 127.0.0.1:8765' } else { '  [STOPPED] Desktop Hub' }
  if ($s.Connect) { '  [RUNNING] ADB Reverse Supervisor' } else { '  [STOPPED] ADB Reverse Supervisor' }
  foreach ($d in $s.Devices) { "  USB phone $(Hide-Serial $d.Serial): $($d.State)" }
  if ($s.Reverse) { "  Active ADB reverse mappings: $($s.Reverse)" }
  if (-not $s.Hub -or -not $s.Connect) { $global:LASTEXITCODE = 1 } else { $global:LASTEXITCODE = 0 }
}

function Resolve-Serial([string]$explicit) {
  if ($explicit) { return $explicit }
  $ready = @(Get-UsbDevices | Where-Object { $_.State -eq 'device' })
  if ($ready.Count -eq 1) { return $ready[0].Serial }
  if ($ready.Count -gt 1) { throw 'More than one phone is connected. Pass its serial: lumendock.ps1 start SERIAL' }
  # A phone that is unplugged or not yet authorized: reuse the one from last time, connect waits for it.
  $any = @(Get-UsbDevices)
  if ($any.Count -eq 1) { return $any[0].Serial }
  if (Test-Path $script:SerialFile) { return (Get-Content $script:SerialFile -Raw).Trim() }
  $null
}

function Initialize-Build {
  $protocol = Join-Path $script:Root 'packages\protocol\dist\index.js'
  if ((Test-Path $script:HubScript) -and (Test-Path $protocol)) { return }
  'Building the desktop hub...'
  Push-Location $script:Root
  try {
    if (-not (Test-Path (Join-Path $script:Root 'node_modules'))) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' } }
    & npm.cmd run build --workspace '@phone-monitor/desktop'; if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
  } finally { Pop-Location }
}

# Starts the ADB supervisor when the hub runs without it and a phone is known. Returns a message.
function Start-Connect([string]$explicit = '') {
  $pids = Read-Pids
  if (Test-Recorded $pids.connect) { return 'ADB supervisor already running.' }
  $adb = Find-Adb
  if (-not $adb) { return 'adb was not found. Install Android platform-tools (see docs/WINDOWS.md).' }
  $serial = Resolve-Serial $explicit
  if (-not $serial) { return 'No phone found. Connect it by USB with USB debugging on.' }
  if ($serial -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { return 'That serial is not a valid USB serial.' }
  Initialize-ConfigDir
  [System.IO.File]::WriteAllText($script:SerialFile, $serial)
  $connect = Start-Hidden $script:ConnectScript @('--serial', $serial, '--adb', $adb) $script:ConnectLog
  Save-Pids $pids.hub $connect
  "ADB supervisor watching phone $(Hide-Serial $serial)."
}

function Start-Lumen([string]$explicit = '') {
  Remove-Item $script:StoppedFile -ErrorAction SilentlyContinue
  $pids = Read-Pids
  if ((Test-Recorded $pids.hub) -and (Test-Recorded $pids.connect)) { 'LumenDock is already running.'; return }
  Initialize-ConfigDir
  Initialize-Build
  if (-not (Test-Recorded $pids.hub)) {
    foreach ($stray in Get-StrayProcesses | Where-Object { $_.CommandLine -match [regex]::Escape($script:HubScript) }) { Stop-Process -Id $stray.ProcessId -Force -ErrorAction SilentlyContinue }
    $hub = Start-Hidden $script:HubScript @() $script:HubLog
    Save-Pids $hub $pids.connect
    Start-Sleep -Milliseconds 1500
    if (-not (Test-Recorded $hub)) { Get-Content $script:HubLog -Tail 20 -ErrorAction SilentlyContinue; throw 'The hub stopped right after starting; see the log above.' }
    "Hub running on 127.0.0.1:8765 (log: $script:HubLog)"
  }
  Start-Connect $explicit
}

# Ends a process and everything it started (node, its PowerShell helper, codex), children first.
function Stop-Tree([int]$id) {
  foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $id" -ErrorAction SilentlyContinue)) { Stop-Tree $child.ProcessId }
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}
# -Hold records that the user stopped LumenDock, so a running tray does not start it again.
function Stop-Lumen([switch]$Hold) {
  if ($Hold) { Initialize-ConfigDir; [System.IO.File]::WriteAllText($script:StoppedFile, 'stopped') }
  $pids = Read-Pids
  $any = $false
  foreach ($entry in @($pids.hub, $pids.connect)) { if (Test-Recorded $entry) { Stop-Tree $entry.pid; $any = $true } }
  foreach ($stray in Get-StrayProcesses) { Stop-Tree $stray.ProcessId; $any = $true }
  Remove-Item $script:PidFile -ErrorAction SilentlyContinue
  if ($any) { 'LumenDock stopped.' } else { 'LumenDock is not running.' }
}
function Stop-Hub {
  $pids = Read-Pids
  if (Test-Recorded $pids.hub) { Stop-Tree $pids.hub.pid }
  foreach ($stray in Get-StrayProcesses | Where-Object { $_.CommandLine -match [regex]::Escape($script:HubScript) }) { Stop-Tree $stray.ProcessId }
  Save-Pids $null $pids.connect
}

function Test-PairingActive {
  try { [bool](Get-Process -Id ([int](Get-Content $script:PairingFile -Raw)) -ErrorAction SilentlyContinue) } catch { $false }
}

# Pairing prints a one-time code, so it runs in this visible console rather than into a log.
# The hub writes a new phone-token the moment the phone pairs; this window then hands over to
# the background hub and closes by itself.
function Invoke-Pair {
  Initialize-Build
  Initialize-ConfigDir
  [System.IO.File]::WriteAllText($script:PairingFile, "$PID")
  $before = $(if (Test-Path $script:TokenFile) { (Get-Item $script:TokenFile).LastWriteTimeUtc } else { [datetime]::MinValue })
  $hub = $null
  try {
    Stop-Hub
    $null = Start-Connect
    ''
    'Type the eight-digit code below on the phone (LumenDock > Pair laptop). It is valid for 120 seconds.'
    'This window closes by itself once the phone is paired.'
    ''
    $hub = Start-Process -FilePath (Find-Node) -ArgumentList @('"' + $script:HubScript + '"', '--pair') -WorkingDirectory $script:Root -NoNewWindow -PassThru
    $deadline = (Get-Date).AddSeconds(125)
    $paired = $false
    while (-not $hub.HasExited -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
      if ((Test-Path $script:TokenFile) -and (Get-Item $script:TokenFile).LastWriteTimeUtc -gt $before) { $paired = $true; break }
    }
    ''
    if ($paired) { 'Paired.'; Start-Sleep -Seconds 2 } else { 'No phone paired in time. Choose Pair phone again for a new code.' }
  } finally {
    if ($hub -and -not $hub.HasExited) { Stop-Tree $hub.Id }
    Remove-Item $script:PairingFile -ErrorAction SilentlyContinue
    $null = Start-Lumen
  }
  'LumenDock is running in the background.'
  Start-Sleep -Seconds 4
}

function Show-Logs {
  Initialize-ConfigDir
  foreach ($log in $script:HubLog, $script:ConnectLog) { if (-not (Test-Path $log)) { New-Item -ItemType File $log | Out-Null } }
  "Last lines of $script:ConnectLog"; Get-Content $script:ConnectLog -Tail 15
  ''; "Following $script:HubLog (Ctrl+C to exit)"; Get-Content $script:HubLog -Tail 30 -Wait
}

# Desktop shortcut that opens the tray app with no console window. It is never placed in the
# Startup folder, so LumenDock does not start at sign-in.
function Set-Shortcut([switch]$remove) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $link = Join-Path $desktop 'LumenDock.lnk'
  if ($remove) { Remove-Item $link -ErrorAction SilentlyContinue; "Removed $link"; return }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($link)
  $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\conhost.exe'
  $shortcut.Arguments = '--headless powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'lumendock-tray.ps1') + '"'
  $shortcut.WorkingDirectory = $script:Root
  $shortcut.IconLocation = (Join-Path $PSScriptRoot 'lumendock.ico') + ',0'
  $shortcut.Description = 'Start LumenDock (phone desk display) with its tray icon'
  $shortcut.Save()
  "Created $link"
}

if ($MyInvocation.InvocationName -ne '.') {
  switch ($Command) {
    'start' { Start-Lumen $Serial }
    'stop' { Stop-Lumen -Hold }
    'restart' { Stop-Lumen; Start-Sleep -Seconds 1; Start-Lumen $Serial }
    'status' { Show-Status; exit $LASTEXITCODE }
    'logs' { Show-Logs }
    'pair' { Invoke-Pair }
    'tray' { & (Join-Path $PSScriptRoot 'lumendock-tray.ps1') }
    'shortcut' { Set-Shortcut -remove:$Remove }
    default { Write-Error 'Usage: lumendock.ps1 {start [SERIAL]|stop|restart [SERIAL]|status|logs|pair|tray|shortcut [-Remove]}'; exit 1 }
  }
}
