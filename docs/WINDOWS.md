# LumenDock on Windows

The laptop hub also runs on Windows 10 and 11. The phone app, the lamp and the USB link work exactly as on Linux. What changes is how the hub reads the laptop. Windows has no `wpctl`, `busctl` or `gsettings`, so one small PowerShell helper reads volume, the microphone, now playing and battery, and runs the Deck keys. Notifications come from Windows' own notification history.

Nothing is set to start with Windows. LumenDock runs only after you open it from the desktop icon (or `lumendock.ps1 start`), and stops when you choose **Quit & stop** in its tray menu.

## Requirements

- Windows 10 or 11 with Windows PowerShell 5.1 (built in).
- Node.js 24 on `PATH`.
- Android platform-tools (`adb`). Put them on `PATH`, or unzip [platform-tools](https://dl.google.com/android/repository/platform-tools-latest-windows.zip) to `%LOCALAPPDATA%\Android\platform-tools`, where LumenDock looks for them.
- The phone's USB debugging driver. Most phones (including the Redmi 9A) install on their own as **Android Composite ADB Interface**. If `adb devices` lists nothing, install your phone maker's USB driver.

## Set up (once)

```powershell
git clone https://github.com/Arcco-Chakraborty/lumendock.git; cd lumendock
npm ci
npm run build
npm run doctor
powershell -ExecutionPolicy Bypass -File scripts\windows\lumendock.ps1 shortcut
```

The last command puts a **LumenDock** icon on the desktop. To remove the icon, run it again with `-Remove`.

Plug the phone in and tap **Allow USB debugging** on it when asked. Then pair it: double-click the desktop icon, right-click the tray icon (in the `^` overflow if it is hidden), choose **Pair phone...**, and type the eight-digit code into the phone (LumenDock > **Pair laptop**). A phone paired with another laptop must be paired again, because each laptop has its own token. Press Ctrl+C in the pairing window once the phone shows it is paired; LumenDock keeps running in the background.

## Day to day

Double-click **LumenDock** on the desktop. The tray icon starts the hub and the USB link and shows their state. Its menu has **Restart services**, **Pair phone...**, **Open log folder**, and **Quit & stop LumenDock**.

The same controls from a terminal:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\lumendock.ps1 start     # also: status, logs, stop, restart, pair
```

Logs and private settings live in `%USERPROFILE%\.config\phone-monitor`, the same folder name as on Linux.

## Turning on data

- **Codex:** appears automatically. The hub finds `codex.exe` on `PATH` or in the VS Code ChatGPT extension (`bin\windows-x86_64`).
- **Claude:** run `npm run claude-usage -- on` for usage polling (see the main README for what it reads). The Claude Code status-line installer (`claude-install`) is Linux-only, so on Windows use polling.
- **Notifications:** off by default. `npm run start --workspace @phone-monitor/desktop -- notifications allow "WhatsApp"`, or `notifications configure-selected` for Claude, Codex and WhatsApp. A label matches a Windows app whose identity contains it, ignoring case and spaces: `WhatsApp` matches the WhatsApp app, and `Claude` matches the Claude app. Only toasts that arrive after the hub starts are forwarded, and only for allowed apps. The hub reads `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db` read-only, and reads a toast's text only when its app is allowed.

## What differs from Linux

| Feature | Windows |
|---|---|
| Volume, mute, microphone | Windows Core Audio, default devices |
| Media keys, now playing | Media keys go to the active media session; title and artist come from Windows' media sessions (Spotify, browsers, Media Player) |
| Do Not Disturb key | Opens the notification center, where the bell switches Do Not Disturb. Windows has no supported way for another program to switch it. The Deck shows whether it is on. |
| Lock, screenshot | `LockWorkStation`, Snipping Tool overlay (`ms-screenclip:`) |
| Open app keys | Claude, ChatGPT and WhatsApp desktop apps when installed, else their websites; Chrome; Windows Terminal |
| Laptop screen | CPU load per thread and clock, CPU temperature from the hottest ACPI thermal zone (it follows the CPU on laptops, but updates more slowly than the sensor Linux reads), memory and page file (swap), battery, NVIDIA GPU via `nvidia-smi`, integrated GPU load. SSD temperature needs administrator rights and CPU package power needs a hardware-monitoring driver, so both are hidden. |
| Background service | Desktop icon + tray only. The systemd service (`install-hub`) is Linux-only. |

## Resource use

LumenDock takes about 1% CPU and under 0.5 GB of memory on Windows, most of it the two PowerShell processes (the helper and the tray). While no phone is watching, the helper is asked for Deck state every 15 seconds instead of every 2.

The Laptop screen's CPU load is time-based, like Linux and like Windows' "% Processor Time" counter. Task Manager shows "Processor Utility" instead, which scales with clock speed and usually reads lower, so the phone and Task Manager can differ.

## Tests

`npm test` passes on Windows. Tests for Linux-only parts (systemd unit, the `/bin/sh` status-line wrapper, POSIX file modes and symlinks) are skipped there. `desktop/test/windows.test.ts` covers the Windows modules with fakes and synthetic data on every platform.
