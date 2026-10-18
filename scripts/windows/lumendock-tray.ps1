# LumenDock tray icon for Windows (the counterpart of phone-monitor-tray.py on Ubuntu).
# Starting it starts the hub and the ADB supervisor; "Quit & stop" ends both. It is launched
# by the desktop shortcut only and never registers itself to run at sign-in.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lumendock.ps1')
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\LumenDockTray', [ref]$created)
if (-not $created) {
  [System.Windows.Forms.MessageBox]::Show('LumenDock is already running. Look for its icon in the taskbar tray (^).', 'LumenDock') | Out-Null
  exit 0
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = New-Object System.Drawing.Icon((Join-Path $PSScriptRoot 'lumendock.ico'), 32, 32)
$icon.Text = 'LumenDock: starting'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add('LumenDock: starting...'); $statusItem.Enabled = $false
$detailItem = $menu.Items.Add('Hub: 127.0.0.1:8765'); $detailItem.Enabled = $false
$null = $menu.Items.Add('-')
$restartItem = $menu.Items.Add('Restart services')
$pairItem = $menu.Items.Add('Pair phone...')
$logsItem = $menu.Items.Add('Open log folder')
$null = $menu.Items.Add('-')
$quitItem = $menu.Items.Add('Quit && stop LumenDock')
$icon.ContextMenuStrip = $menu
$icon.Visible = $true

function Set-TrayState([string]$status, [string]$detail) {
  $statusItem.Text = $status; $detailItem.Text = $detail
  $text = "LumenDock: $detail"; if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
  $icon.Text = $text
}
function Notify([string]$text, [System.Windows.Forms.ToolTipIcon]$kind = 'Info') { $icon.ShowBalloonTip(4000, 'LumenDock', $text, $kind) }

$script:lastAutoStart = [datetime]::MinValue
function Update-Tray {
  try {
    if (Test-PairingActive) { Set-TrayState '... LumenDock: pairing' 'enter the code on the phone'; return }
    $s = Get-LumenStatus
    # While the tray runs, the hub should run: restart it if it stopped on its own (not after
    # `lumendock.ps1 stop`), at most every 30 seconds.
    if (-not $s.Hub -and -not (Test-Path $script:StoppedFile) -and ((Get-Date) - $script:lastAutoStart).TotalSeconds -ge 30) {
      $script:lastAutoStart = Get-Date
      try { $null = Start-Lumen } catch { Notify $_.Exception.Message 'Error' }
      $s = Get-LumenStatus
    }
    # Bring the USB link up as soon as a phone appears while the hub runs.
    if ($s.Hub -and -not $s.Connect -and @($s.Devices).Count -gt 0) { $null = Start-Connect; $s = Get-LumenStatus }
    $unauthorized = @($s.Devices | Where-Object { $_.State -eq 'unauthorized' }).Count -gt 0
    if (-not $s.Hub) { Set-TrayState 'o LumenDock: stopped' 'services stopped (use Restart)' }
    elseif ($unauthorized) { Set-TrayState '! LumenDock: phone not authorized' 'tap "Allow USB debugging" on the phone' }
    elseif (-not @($s.Devices).Count) { Set-TrayState '* LumenDock: hub running' 'waiting for the phone on USB' }
    elseif ($s.Connect -and $s.Reverse -match 'tcp:8765') { Set-TrayState '* LumenDock: connected' 'phone linked over USB' }
    else { Set-TrayState '* LumenDock: hub running' 'linking the phone...' }
  } catch { Set-TrayState 'o LumenDock: status unavailable' $_.Exception.Message }
}

$restartItem.add_Click({
  Set-TrayState '... LumenDock: restarting' 'restarting services'
  try { $null = Stop-Lumen; Start-Sleep -Seconds 1; $null = Start-Lumen } catch { Notify $_.Exception.Message 'Error' }
  Update-Tray
})
$pairItem.add_Click({
  Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'lumendock.ps1'), 'pair')
})
$logsItem.add_Click({ Initialize-ConfigDir; Start-Process explorer.exe -ArgumentList @($script:ConfigDir) })
$quitItem.add_Click({
  Set-TrayState '... LumenDock: stopping' 'stopping services'
  try { $null = Stop-Lumen } catch { }
  $timer.Stop(); $icon.Visible = $false; $icon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$icon.add_MouseClick({ param($sender, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Notify $detailItem.Text } })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({ Update-Tray })

# Start services once the icon is visible, then keep the status fresh.
$startup = New-Object System.Windows.Forms.Timer
$startup.Interval = 300
$startup.add_Tick({
  $startup.Stop()
  try { $null = Start-Lumen } catch { Notify $_.Exception.Message 'Error' }
  Update-Tray
  $timer.Start()
})
$startup.Start()

try { [System.Windows.Forms.Application]::Run() }
finally { $icon.Dispose(); $mutex.ReleaseMutex() }
