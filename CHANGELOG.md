# Changelog

## 1.3.1 (2026-10-18)

- Fixed: on Windows, opening LumenDock after a fresh boot started the hub but never linked the phone, so it could not connect or pair. The tray waited for the adb server it had just started, which never exits (Windows PowerShell's `Start-Process -Wait` also waits for the processes a command starts). It now waits only for `adb start-server` itself; the phone links within about 10 seconds of opening LumenDock.

## 1.3.0 (2026-10-18)

### Desktop apps for Windows and Ubuntu

- Each release now ships two ready desktop bundles next to the APK: `lumendock-desktop-<version>-windows.zip` (run `Install.cmd`) and `lumendock-desktop-<version>-linux.tar.gz` (run `scripts/linux/install-desktop.sh`). Both add a LumenDock launcher with a tray icon; neither starts anything at boot or login.
- Linux: `./phone-monitor.sh pair` and **Pair Phone…** in the top-bar menu pair the phone and hand over to the background hub by themselves. A release bundle installs its production dependencies on first start.
- The Android app is unchanged since 1.2.0; this release carries the same signed `lumendock-1.2.0.apk`.

### Fixes

- Fixed: after a fresh boot on Windows the USB link never came up, so the phone could not pair. The first `adb` call started the adb server with its own output pipes attached; that call never finished, and the server exited when its caller gave up ("cannot write ACK"). LumenDock now starts the adb server on its own first, and its adb calls finish when adb exits.
- Fixed: on Windows, `lumendock.ps1 status` and the tray reported an error instead of the state when no phone was plugged in.


### Windows laptops

- The hub runs on Windows 10 and 11. A resident PowerShell helper reads volume, microphone, now playing and battery, and runs the Deck keys. Codex usage, the Laptop screen (CPU, memory, battery, NVIDIA GPU) and notifications from allowed apps work too. See [docs/WINDOWS.md](docs/WINDOWS.md).
- A desktop icon (`scripts\windows\lumendock.ps1 shortcut`) opens a tray icon that starts and stops the hub and the USB link. Nothing is set to start with Windows.
- `npm run doctor` and `connect` find `adb` in `%LOCALAPPDATA%\Android\platform-tools` when it is not on `PATH`. Windows `adb` never reports a USB port, so there a local, non-emulator serial counts as a USB phone.
- On Windows, the Do Not Disturb key opens the notification center: Windows has no supported way for another program to switch Do Not Disturb.
- The Windows Laptop screen shows CPU temperature (ACPI thermal zone), swap (page file) and integrated-GPU load. While no phone is watching, the hub asks Windows for Deck state every 15 seconds instead of every 2.

## 1.2.0 (2026-10-16)

### Claude usage without an open session

- **Opt-in usage polling:** run `npm run claude-usage -- on`. While the phone is connected, the hub asks Anthropic for your Claude usage every 3 minutes. It uses the sign-in Claude Code already keeps on the laptop, so usage stays current with no Claude Code session open, and includes use on claude.ai and the desktop app. The hub reads only the access token and its expiry. It never refreshes, copies or logs the token, or sends it to the phone. When the token expires, the hub waits for Claude Code to renew it the next time you open Claude Code, and the card falls back to the status line. It is off by default, and `npm run claude-usage -- off` turns it off.
- **Claude readings stay current until they reset.** Claude only reports while it is in use, so a reading no longer turns "Stale" 5 minutes after its last update. Once a window's reset time passes with no newer report, the card shows **Reset** instead of the old percentage.
- Claude's windows are now named **Session** (5 hours) and **Week** (7 days), so the card no longer reads "5 hours 5h".

## 1.1.0 (2026-10-16)

### Laptop screen

A third screen, **Laptop**, shows the laptop's vitals, updated every 2 seconds:

- **CPU:** load, a bar per thread, temperature (amber from 75°C, red from 85°C), clock, package power, and a three-minute load chart.
- **GPU:** load, temperature, hotspot when the driver reports one, power, memory and clock, plus the integrated graphics' load and temperature. A hybrid-graphics GPU that is asleep shows as **Asleep**: the hub never wakes it to read stats. If it has sat idle for a few readings, the hub stops asking so it can fall asleep again.
- **Memory:** use, with swap.
- **Power:** AC or battery, charge level, draw or charge rate, time left or time to full, and SSD temperature.

Vitals are read from `/proc` and `/sys`, plus `nvidia-smi` for NVIDIA GPUs, and only while the phone is connected. On the reference laptop (RTX 3050 Ti), the NVIDIA driver does not report a GPU hotspot, so it shows as "not reported by driver".

### Fixes

- Fixed: `./phone-monitor.sh status`, `start` and `restart` could mistake any process whose command line mentioned the hub's path for a running hub. `restart` then stopped the service and never started it again. All checks now count only real `node` processes.

## 1.0.0 (2026-10-16)

First public release.

### Phone app

- **Monitor:** large local clock and date, a room panel with temperature, humidity and history, Claude and Codex usage, and the newest Claude, Codex and WhatsApp alerts. Usage shows the window name beside the percentage, a bar that turns red at 90% or more, and resets counted in days once they are a day or more away. The full view names windows in hours and days.
- **Deck:** app launchers (Claude, ChatGPT, Chrome, WhatsApp, Terminal), a now-playing panel with a play/pause key that follows the laptop, system keys (volume, mute, microphone, Do Not Disturb, lock, screenshot tool) with status lights, and lamp presets with full light controls.
- **Lamp signals:** the lamp pulses cyan for Claude/Codex alerts, green for WhatsApp and white when a used-up quota resets, then restores itself. Each signal can be switched off, with quiet hours from 11 PM to 8 AM.
- **Control bar:** overlays the bottom of the screen like an auto-hiding taskbar. Tap the bottom edge to bring it back. Key feedback shows in the edge strip without covering keys.
- **Design:** near-black instrument panel with graphite keys and an electric cyan accent, using the bundled Archivo typeface. Works in landscape and portrait, and with enlarged system text.
- The app is now called LumenDock on the phone, and is signed with the LumenDock release key.

### Laptop hub

- Reports media, volume, microphone and Do Not Disturb state to the phone (an optional `host` block in the snapshot, validated on both sides).
- New fixed actions: `open_terminal`, `mic_mute`, `dnd_toggle`, `lock_screen` and `screenshot`. Spotify was removed from the launchers.
- Fixed: the Mute key sent `volume_mute`, which the hub did not recognise, so it never worked.
- Fixed: `./phone-monitor.sh stop` could kill any process whose command line mentioned the hub's path. It now only stops real `node` processes.
- The server tests no longer run a real host action (they used to toggle the system mute).

### Build

- `node scripts/build.mjs --release` builds a signed, verified release APK from a private keystore outside the repository.
