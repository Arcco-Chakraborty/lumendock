# LumenDock Windows host helper: one resident Windows PowerShell 5.1 process owned by the hub.
# It reads one fixed command word per stdin line and answers exactly one JSON line on stdout.
# Nothing read from stdin is ever executed or interpolated; unknown words get an error reply.
# Only title, artist and player name of the current media session leave this process.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace LumenDock {
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out uint count);
    int SetMasterVolumeLevel(float level, ref Guid context);
    int SetMasterVolumeLevelScalar(float level, ref Guid context);
    int GetMasterVolumeLevel(out float level);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
    int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
    int GetChannelVolumeLevel(uint channel, out float level);
    int GetChannelVolumeLevelScalar(uint channel, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object endpoint);
  }
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}

  public static class Host {
    // flow 0 = speakers (render), 1 = microphone (capture); role 1 = multimedia.
    static IAudioEndpointVolume Endpoint(int flow) {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice device;
      Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(flow, 1, out device));
      var iid = typeof(IAudioEndpointVolume).GUID;
      object endpoint;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out endpoint));
      return (IAudioEndpointVolume)endpoint;
    }
    public static float GetVolume(int flow) { float v; Marshal.ThrowExceptionForHR(Endpoint(flow).GetMasterVolumeLevelScalar(out v)); return v; }
    public static bool GetMute(int flow) { bool m; Marshal.ThrowExceptionForHR(Endpoint(flow).GetMute(out m)); return m; }
    public static void SetMute(int flow, bool mute) { var g = Guid.Empty; Marshal.ThrowExceptionForHR(Endpoint(flow).SetMute(mute, ref g)); }
    public static void StepVolume(float delta) {
      var e = Endpoint(0); float v; Marshal.ThrowExceptionForHR(e.GetMasterVolumeLevelScalar(out v));
      var g = Guid.Empty; Marshal.ThrowExceptionForHR(e.SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, v + delta)), ref g));
    }

    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    // Media keys go wherever Windows routes them (the active media session), like a keyboard's keys.
    public static void Key(byte vk) { keybd_event(vk, 0, 1, UIntPtr.Zero); keybd_event(vk, 0, 3, UIntPtr.Zero); }

    // Do Not Disturb has no public API; the shell publishes its active quiet-hours profile in this WNF state
    // (0 = off, 1 = priority only, 2 = alarms only). Reading it is reliable; writing it does not switch DND.
    [DllImport("ntdll.dll")] static extern int NtQueryWnfStateData(ref ulong name, IntPtr type, IntPtr scope, out uint stamp, byte[] buffer, ref uint size);
    const ulong QuietHoursProfile = 0x0D83063EA3BF1C75UL;
    public static int GetQuietProfile() {
      ulong name = QuietHoursProfile; uint stamp; var buffer = new byte[4]; uint size = 4;
      int status = NtQueryWnfStateData(ref name, IntPtr.Zero, IntPtr.Zero, out stamp, buffer, ref size);
      if (status != 0) throw new InvalidOperationException("WNF query failed");
      return size >= 4 ? BitConverter.ToInt32(buffer, 0) : 0;
    }
  }

  // Graphics adapters with the LUID that names them in the "GPU Engine" performance counters.
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct AdapterDesc1 {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    public uint VendorId, DeviceId, SubSysId, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public uint LuidLow; public int LuidHigh; public uint Flags;
  }
  [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIAdapter1 {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    void EnumOutputs(); void GetDesc(); void CheckInterfaceSupport();
    [PreserveSig] int GetDesc1(out AdapterDesc1 desc);
  }
  [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIFactory1 {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    void EnumAdapters(); void MakeWindowAssociation(); void GetWindowAssociation(); void CreateSwapChain(); void CreateSoftwareAdapter();
    [PreserveSig] int EnumAdapters1(uint index, out IDXGIAdapter1 adapter);
  }
  // Sum of a wildcard performance counter through PDH, which (unlike .NET's counters) sees the
  // "GPU Engine" instances and re-expands the wildcard as processes come and go.
  public sealed class PdhSum {
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQuery(string source, IntPtr user, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounter(IntPtr query, string path, IntPtr user, out IntPtr counter);
    [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArray(IntPtr counter, uint format, ref uint size, out uint count, IntPtr buffer);
    const uint DoubleFormat = 0x200, MoreData = 0x800007D2;
    IntPtr query, counter;
    public PdhSum(string path) {
      if (PdhOpenQuery(null, IntPtr.Zero, out query) != 0 || PdhAddEnglishCounter(query, path, IntPtr.Zero, out counter) != 0) throw new InvalidOperationException("PDH");
      PdhCollectQueryData(query);
    }
    public double Read() {
      if (PdhCollectQueryData(query) != 0) return 0;
      uint size = 0, count;
      if (PdhGetFormattedCounterArray(counter, DoubleFormat, ref size, out count, IntPtr.Zero) != MoreData || size == 0) return 0;
      IntPtr buffer = Marshal.AllocHGlobal((int)size);
      try {
        if (PdhGetFormattedCounterArray(counter, DoubleFormat, ref size, out count, buffer) != 0) return 0;
        // PDH_FMT_COUNTERVALUE_ITEM: name pointer, then { DWORD status; (padding); double value }.
        int item = IntPtr.Size + 16; double sum = 0;
        for (int i = 0; i < count; i++) {
          IntPtr at = new IntPtr(buffer.ToInt64() + (long)i * item);
          uint status = (uint)Marshal.ReadInt32(at, IntPtr.Size);
          if (status <= 1) sum += BitConverter.Int64BitsToDouble(Marshal.ReadInt64(at, IntPtr.Size + 8));
        }
        return sum;
      } finally { Marshal.FreeHGlobal(buffer); }
    }
  }

  public static class Gpu {
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IDXGIFactory1 factory);
    // The integrated GPU (AMD or Intel) as "luid_0x<high>_0x<low>", or null.
    public static string IntegratedLuid() {
      var iid = typeof(IDXGIFactory1).GUID; IDXGIFactory1 factory;
      if (CreateDXGIFactory1(ref iid, out factory) != 0) return null;
      for (uint i = 0; i < 8; i++) {
        IDXGIAdapter1 adapter; if (factory.EnumAdapters1(i, out adapter) != 0) break;
        AdapterDesc1 d; if (adapter.GetDesc1(out d) != 0) continue;
        if (d.VendorId == 0x1002 || d.VendorId == 0x8086) return string.Format("luid_0x{0:X8}_0x{1:X8}", d.LuidHigh, d.LuidLow);
      }
      return null;
    }
  }
}
'@

# Windows media sessions (now playing). WinRT async calls are awaited through AsTask with a short bound.
$script:media = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
} catch { $script:asTask = $null }
function Await($operation, [Type]$type) {
  $task = $script:asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  if (-not $task.Wait(1500)) { throw 'timeout' }
  $task.Result
}
function Get-MediaManager {
  if ($null -eq $script:media -and $null -ne $script:asTask) {
    $script:media = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  }
  $script:media
}
$script:appNames = $null
function Get-PlayerName([string]$aumid) {
  if ($null -eq $script:appNames) {
    $script:appNames = @{}
    try { foreach ($app in Get-StartApps) { $script:appNames[$app.AppID.ToLowerInvariant()] = $app.Name } } catch { }
  }
  $key = $aumid.ToLowerInvariant()
  if ($script:appNames.ContainsKey($key)) { return $script:appNames[$key] }
  $name = $aumid
  if ($name.Contains('!')) { $name = ($name.Split('!')[0]).Split('_')[0]; $name = $name.Split('.')[-1] }
  $name = [System.IO.Path]::GetFileNameWithoutExtension($name)
  if ($name.Length -gt 0) { $name = $name.Substring(0, 1).ToUpperInvariant() + $name.Substring(1) }
  $name
}
function Read-Media {
  $manager = Get-MediaManager
  if ($null -eq $manager) { return $null }
  $players = @()
  foreach ($session in @($manager.GetSessions()) | Select-Object -First 8) {
    try {
      $status = switch ([int]$session.GetPlaybackInfo().PlaybackStatus) { 4 { 'playing' } 5 { 'paused' } default { 'stopped' } }
      $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $players += [ordered]@{ player = (Get-PlayerName $session.SourceAppUserModelId); status = $status; title = [string]$props.Title; artist = [string]$props.Artist }
    } catch { }
  }
  $playing = $players | Where-Object { $_.status -eq 'playing' } | Select-Object -First 1
  if ($playing) { return $playing }
  $players | Where-Object { $_.status -eq 'paused' } | Select-Object -First 1
}

function Try-Value([scriptblock]$read) { try { & $read } catch { $null } }

$script:perf = $null
$script:baseMhz = $null

# ACPI thermal zones (no administrator rights needed). On laptops the hottest zone follows the CPU.
$script:zones = $null
function Read-ThermalC {
  if ($null -eq $script:zones) {
    $script:zones = @()
    try {
      $category = New-Object System.Diagnostics.PerformanceCounterCategory('Thermal Zone Information')
      foreach ($name in $category.GetInstanceNames()) {
        $counter = $(if ($category.CounterExists('High Precision Temperature')) { 'High Precision Temperature' } else { 'Temperature' })
        $script:zones += New-Object System.Diagnostics.PerformanceCounter('Thermal Zone Information', $counter, $name)
      }
    } catch { }
  }
  $hottest = $null
  foreach ($zone in $script:zones) {
    try {
      $kelvin = $zone.NextValue(); if ($zone.CounterName -eq 'High Precision Temperature') { $kelvin = $kelvin / 10 }
      $celsius = [Math]::Round($kelvin - 273.15, 1)
      if ($celsius -gt -50 -and $celsius -lt 150 -and ($null -eq $hottest -or $celsius -gt $hottest)) { $hottest = $celsius }
    } catch { }
  }
  $hottest
}

# Page file use, refreshed at most every 15 seconds (a WMI query).
$script:swap = $null; $script:swapAt = [datetime]::MinValue
function Read-Swap {
  if (((Get-Date) - $script:swapAt).TotalSeconds -ge 15) {
    $script:swapAt = Get-Date
    try {
      $files = @(Get-CimInstance Win32_PageFileUsage)
      $script:swap = [ordered]@{ usedMb = [int](($files | Measure-Object CurrentUsage -Sum).Sum); totalMb = [int](($files | Measure-Object AllocatedBaseSize -Sum).Sum) }
    } catch { $script:swap = $null }
  }
  $script:swap
}

# Integrated GPU load: the sum of its 3D engines (every process) in the "GPU Engine" counters.
$script:igpu = $null; $script:igpuChecked = $false
function Read-IgpuLoad {
  if (-not $script:igpuChecked) {
    $script:igpuChecked = $true
    try {
      $luid = [LumenDock.Gpu]::IntegratedLuid()
      if ($luid) { $script:igpu = New-Object LumenDock.PdhSum("\GPU Engine(*$($luid)*engtype_3D)\Utilization Percentage") }
    } catch { $script:igpu = $null }
  }
  if ($null -eq $script:igpu) { return $null }
  [Math]::Round([Math]::Min(100, $script:igpu.Read()), 1)
}

function Read-Vitals {
  if ($null -eq $script:perf) {
    try {
      $script:perf = New-Object System.Diagnostics.PerformanceCounter('Processor Information', '% Processor Performance', '_Total')
      $null = $script:perf.NextValue()
    } catch { $script:perf = $false }
    try { $script:baseMhz = [int](Get-CimInstance Win32_Processor | Select-Object -First 1).MaxClockSpeed } catch { $script:baseMhz = $null }
  }
  $clock = $null
  if ($script:perf -and $script:baseMhz) { $clock = [int][Math]::Round($script:baseMhz * $script:perf.NextValue() / 100) }
  $power = [System.Windows.Forms.SystemInformation]::PowerStatus
  $flags = [int]$power.BatteryChargeStatus
  $hasBattery = ($flags -band 128) -eq 0 -and $flags -ne 255
  $percent = $null; if ($hasBattery -and $power.BatteryLifePercent -le 1) { $percent = [int][Math]::Round($power.BatteryLifePercent * 100) }
  $line = [string]$power.PowerLineStatus
  $minutes = $null; if ($hasBattery -and $line -ne 'Online' -and $power.BatteryLifeRemaining -gt 0) { $minutes = [int][Math]::Round($power.BatteryLifeRemaining / 60) }
  [ordered]@{
    clockMhz = $clock
    cpuTempC = (Try-Value { Read-ThermalC })
    igpuPercent = (Try-Value { Read-IgpuLoad })
    swap = (Try-Value { Read-Swap })
    power = [ordered]@{
      ac = $(if ($line -eq 'Online') { $true } elseif ($line -eq 'Offline') { $false } else { $null })
      hasBattery = $hasBattery; batteryPercent = $percent
      charging = $(if ($hasBattery) { ($flags -band 8) -ne 0 } else { $null }); minutesLeft = $minutes
    }
  }
}

function Read-State {
  $profile = Try-Value { [LumenDock.Host]::GetQuietProfile() }
  [ordered]@{
    media = (Try-Value { Read-Media })
    volumePercent = (Try-Value { [int][Math]::Round([LumenDock.Host]::GetVolume(0) * 100) })
    muted = (Try-Value { [LumenDock.Host]::GetMute(0) })
    micMuted = (Try-Value { [LumenDock.Host]::GetMute(1) })
    doNotDisturb = $(if ($null -eq $profile) { $null } else { $profile -ne 0 })
  }
}

$keys = @{ media_play_pause = 0xB3; media_next = 0xB0; media_prev = 0xB1 }
function Invoke-Command([string]$word) {
  switch ($word) {
    'state' { return @{ ok = $true; data = (Read-State) } }
    'vitals' { return @{ ok = $true; data = (Read-Vitals) } }
    'volume_up' { [LumenDock.Host]::StepVolume(0.05); return @{ ok = $true } }
    'volume_down' { [LumenDock.Host]::StepVolume(-0.05); return @{ ok = $true } }
    'media_mute' { [LumenDock.Host]::SetMute(0, -not [LumenDock.Host]::GetMute(0)); return @{ ok = $true } }
    'mic_mute' { [LumenDock.Host]::SetMute(1, -not [LumenDock.Host]::GetMute(1)); return @{ ok = $true } }
    'ping' { return @{ ok = $true } }
    default {
      if ($keys.ContainsKey($word)) { [LumenDock.Host]::Key([byte]$keys[$word]); return @{ ok = $true } }
      return @{ ok = $false; error = 'UNKNOWN_COMMAND' }
    }
  }
}

$stdout.WriteLine('{"ok":true,"ready":true}')
while ($null -ne ($line = $stdin.ReadLine())) {
  $word = $line.Trim()
  if ($word -eq 'exit') { break }
  try { $reply = Invoke-Command $word } catch { $reply = @{ ok = $false; error = 'FAILED' } }
  $stdout.WriteLine(($reply | ConvertTo-Json -Compress -Depth 5))
}
