# Changelog

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
