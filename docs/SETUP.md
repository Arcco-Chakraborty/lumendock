# Phone Monitor setup

Status legend used throughout: **VERIFIED (software)** means an automated test or a read-only command passed on the laptop. **UNVERIFIED / UNRUN** means no real phone, ESP32 or live capture has exercised it yet. Software-verified is not device-accepted: the Redmi/ESP32 acceptance matrix in [the PRD](PRD.md) is still open (see [TESTING.md](TESTING.md)).

All commands run from the repository root with the project Node 24 toolchain first on `PATH` (the system Node 20 / Java 8 defaults are never changed):

```sh
export PATH=$HOME/.local/share/phone-monitor/toolchains/node-v24.22.0-linux-x64/bin:$PATH
npm run build --workspace @phone-monitor/desktop
npm run doctor            # add -- --json for machine output
```

No placeholder below is a real serial, token or password. Replace `SERIAL` with the value you read yourself from `adb devices -l`; never paste it into tracked files or shared reports.

## 1. Check the laptop

`npm run doctor` reports Node 24, JDK 17 and Android SDK 36 (needed only to build the app), `adb`, Claude Code, Codex CLI and whether the hub/APK are built. It lists **authorized physical USB devices** only, with serials masked (`ABCD****`). Wireless adb devices are ignored by design. `--show-serial` prints full serials: use it only on your own terminal. `--serial SERIAL` adds model, Android release/API and MIUI version for that device (read-only `getprop`). Running doctor starts the adb server if it is not running; it changes nothing on the phone.

VERIFIED (software): doctor against fake runners and a read-only smoke run with no phone attached. UNRUN: doctor with an attached Redmi.

## 2. Start the hub and pair the phone

The hub binds only `127.0.0.1:8765`. Pairing is closed unless you ask for it:

```sh
npm run start --workspace @phone-monitor/desktop -- --pair
```

The terminal prints an eight-digit code valid for 120 seconds, five wrong attempts, one use. **Type the code on the phone, in the app's native pairing screen** (not on a web page, and never as a command-line argument). The token is stored privately on both sides (`~/.config/phone-monitor/phone-token`, mode 0600, directory 0700). Restart the hub without `--pair` afterwards: pairing then stays closed.

UNVERIFIED: the phone-side pairing screen on a real device.

## 3. Connect the phone over USB

1. Enable Developer options and USB debugging on the phone, then plug in the cable.
2. The phone shows **"Allow USB debugging?"**. This confirmation is physical: you must unlock the phone and tap Allow yourself (no tool can or should do it). Until then the device is `unauthorized` and every command refuses to use it.
3. Select the phone explicitly. Nothing is auto-chosen, even when only one device is attached:

```sh
npm run doctor                         # find the device (serial masked)
adb devices -l                         # copy the full SERIAL yourself
npm run connect -- --serial SERIAL     # foreground; Ctrl-C to stop
npm run connect -- --serial SERIAL --once   # set the mapping once and exit
```

`connect` runs `adb -s SERIAL reverse tcp:8765 tcp:8765`, then `adb -s SERIAL reverse --list` and confirms the mapping. In foreground mode it re-checks every 2 seconds and restores the mapping after unplug/replug, reauthorization or an adb server restart (bounded back-off up to 10 s on real adb errors). It never acts on wireless/mDNS/emulator devices, never kills a process, and never prints your full serial unless `--show-serial` is given.

Typical messages and the fix:

| Message | Fix |
|---|---|
| "has not authorized this computer" | Unlock the phone, tap Allow USB debugging |
| "Port 8765 is already in use or mapped differently" | Stop the other program or remove the other mapping yourself, then retry. Nothing is stopped for you |
| "Wireless/mDNS devices are not used" | Use the USB serial, not an IP/mDNS name |
| "cannot access the USB device" | Install udev rules / join `plugdev`, then replug |

The laptop keeps its normal internet; only a loopback port is forwarded. The reverse mapping lasts until unplug or `adb kill-server`; leaving it is harmless.

VERIFIED (software): all of the above with a fake adb runner. UNRUN: a real Redmi, real unplug/replug, real port conflict.

## 4. ESP32 Wi-Fi (phone side)

The ESP32 keeps its own access point (SSID `Rgb_Controller`, address `192.168.4.1`; the controller firmware is not modified). The phone joins it through the app's native Wi-Fi setup (Android's app-specific network request, with a manual Wi-Fi settings fallback). A no-internet network is expected. The laptop never joins that AP, and USB traffic stays independent of it. Enter the AP password in the native screen only; it is stored in app-private storage and never leaves the phone.

UNVERIFIED: simultaneous USB + ESP Wi-Fi on the Redmi, MIUI approval/retention behaviour (PRD A02).

## 5. Claude Code status line (opt-in, not enabled by default)

Claude quota data comes from a status-line wrapper that you opt into; the hub never launches Claude and makes no inference calls. The installer (`desktop/src/claude/install.ts`) backs up your settings, preserves unrelated edits, and uninstall restores only the field it owns. If you already have a status-line command, **existing-command passthrough remains disabled**: the installer refuses unless the previous command's shell and cancellation behaviour have been verified for your Claude Code version. Until that is verified, an existing status-line command is left untouched and Claude shows "awaiting data".

Commands (all explicit; nothing runs at hub startup; settings default to `~/.claude/settings.json`, override with `--settings /absolute/path`):

```
npm run build --workspace @phone-monitor/desktop     # the wrapper must be built first
npm run claude-install -- --dry-run                  # reports state, writes nothing
npm run claude-install                               # adds the wrapper status line (backs up settings first)
npm run claude-uninstall                             # restores only the field this product owns
```

If you already have a status-line command, install **refuses and changes nothing** unless you supply every attestation yourself, after verifying them for your Claude Code version: `--previous-shell /absolute/shell --claude-version 2.1.N --attest-shell --attest-cancellation`. These flags are your own statement; the tool cannot verify cancellation behaviour and does not claim to. If you edit the status line after installing, uninstall refuses rather than overwrite your edit. UNVERIFIED: a live opt-in on a real Claude Code settings file and real quota data arriving; tests use temporary settings only.

## 6. Notification allowlist (empty by default)

Notification capture is off until you allow at least one app. The allowlist starts empty, holds at most ten bounded app labels, and is edited only on the laptop (the phone settings sheet just explains this):

```sh
npm run start --workspace @phone-monitor/desktop -- notifications allow "APP_LABEL"
npm run start --workspace @phone-monitor/desktop -- notifications remove "APP_LABEL"
npm run start --workspace @phone-monitor/desktop -- notifications list
```

A running hub applies changes without restarting other collectors. Only allowlisted notifications are kept (max 100 records, 30 minutes, memory only). If GNOME refuses D-Bus monitoring, the notification card shows "unavailable" and quotas keep working; no elevation is requested. The command syntax above is implemented by the notifications task (D3-A); see [TESTING.md](TESTING.md) for its status. UNRUN: live GNOME capture; a synthetic `notify-send` check is a manual opt-in step.

## 7. Optional login service (foreground is the default)

Running the hub in the foreground (step 2) needs nothing else. If you want it at login, install the optional systemd **user** unit. It is never installed or enabled by the hub itself:

```sh
npm run install-hub -- --print     # show the unit, change nothing
npm run install-hub                # write the unit + daemon-reload; NOT enabled
npm run install-hub -- --enable    # also `systemctl --user enable --now`
```

The unit embeds absolute paths to the Node binary you ran it with, `desktop/dist/main.js`, and `XDG_CONFIG_HOME` (so the hub reads `<that>/phone-monitor`). It binds loopback only. The unit is mode 0644 (no secrets); the ownership record is `~/.config/phone-monitor/hub-service.json` (0600). Rebuild the hub, then rerun `install-hub` if you move the repository or change Node.

VERIFIED (software): temp-directory install/reinstall/uninstall tests with a fake `systemctl`; the generated unit passes `systemd-analyze verify`. UNRUN: enabling against a real user manager and a login/reboot cycle.

## 8. Uninstall (precise)

```sh
npm run uninstall-hub
```

This disables the service only if `install-hub --enable` enabled it, removes only the unit file this product wrote, runs `daemon-reload`, and deletes its ownership record. If you edited the unit after installation the command **refuses**, leaves the unit and service state untouched, and tells you why. Your pairing token and other files in `~/.config/phone-monitor` are kept; delete that directory yourself to forget the pairing. Removing the Claude status-line wrapper uses its own uninstall (restores only the field it owns). The APK is removed from the phone like any app. Nothing else on the laptop or phone is changed.

## What this document does not claim

Hub, adb routing, installer and doctor logic are software-verified. Physical USB reverse on the Redmi, real replug recovery, ESP Wi-Fi coexistence, live Claude/Codex/GNOME capture, and the service at login are **UNRUN** until the acceptance rows in [TESTING.md](TESTING.md) are recorded.
