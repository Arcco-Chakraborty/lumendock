# LumenDock setup

Status legend used throughout: **VERIFIED (software)** means an automated test or a read-only command passed on the laptop. **UNVERIFIED / UNRUN** marks the formal device-acceptance rows in [DEVICE_ACCEPTANCE.md](DEVICE_ACCEPTANCE.md) that nobody has recorded yet. Since those notes were written, pairing, the USB link and lamp Wi-Fi working at the same time, live Claude/Codex usage, live notifications and room readings have all been seen working on the developer's Redmi 9A (see "Observed in daily use" in that file). The formal rows are still the place to record a full pass.

All commands run from the repository root with the project Node 24 toolchain first on `PATH` (the system Node 20 / Java 8 defaults are never changed):

```sh
export TC=$HOME/.local/share/phone-monitor/toolchains
export PATH=$TC/node-v24.22.0-linux-x64/bin:$PATH
npm ci                    # first time on a fresh clone
npm run build             # protocol + desktop hub + dashboard
JAVA_HOME=$TC/jdk17 ANDROID_HOME=$TC/android-sdk node scripts/build.mjs   # Android tests/lint + debug APK -> artifacts/phone-monitor-debug.apk
# or: ... node scripts/build.mjs --release   # signed release -> artifacts/lumendock-<version>.apk (see "Release builds" below)
npm run doctor            # add -- --json for machine output
```

**Short path:** [QUICKSTART.md](QUICKSTART.md) has the exact order from cable to running dashboard. The order matters: install the APK and start `npm run connect` (USB link) **before** starting the hub with `--pair`, because the 2-minute pairing code must reach the phone over that link. `connect` and the hub both run in the foreground, so use two terminals. If you installed the optional service (§7), stop it first (`systemctl --user stop phone-monitor-hub.service`) so `--pair` can bind port 8765.

No placeholder below is a real serial, token or password. Replace `SERIAL` with the value you read yourself from `adb devices -l`; never paste it into tracked files or shared reports.

## 1. Check the laptop

`npm run doctor` reports Node 24, JDK 17 and Android SDK 36 (needed only to build the app), `adb`, Claude Code, Codex CLI and whether the hub/APK are built. It lists **authorized physical USB devices** only, with serials masked (`ABCD****`). Wireless adb devices are ignored by design. `--show-serial` prints full serials: use it only on your own terminal. `--serial SERIAL` adds model, Android release/API and MIUI version for that device (read-only `getprop`). Running doctor starts the adb server if it is not running; it changes nothing on the phone.

VERIFIED (software): doctor against fake runners and a read-only smoke run with no phone attached. UNRUN: doctor with an attached Redmi.

## 2. Install the app, then pair the phone (after §3 is running)

Install the APK once the phone is authorized (see §3 for USB debugging). On a Xiaomi/Redmi phone also enable **Developer options → Install via USB** (it may ask you to sign in to a Mi account once); without it `adb install` fails with `INSTALL_FAILED_USER_RESTRICTED`:

```sh
adb -s SERIAL install -r artifacts/lumendock-<version>.apk   # or the debug APK you built
```

With `npm run connect -- --serial SERIAL` running in another terminal, start the hub in pairing mode. It binds only `127.0.0.1:8765`, and pairing is closed unless you ask for it:

```sh
npm run start --workspace @phone-monitor/desktop -- --pair
```

The terminal prints an eight-digit code valid for 120 seconds, five wrong attempts, one use. **Type the code on the phone:** open LumenDock; an unpaired phone shows a **Pair laptop** card on the main screen (also under the settings icon → **Pair laptop**). Enter it in the native **Pair with laptop** dialog only (not on a web page, never as a command-line argument). The token is stored privately on both sides (`~/.config/phone-monitor/phone-token`, mode 0600, directory 0700). Restart the hub without `--pair` afterwards: pairing then stays closed.

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

## 4b. Codex usage

The hub reads Codex limits from the Codex CLI's read-only app-server. It finds the CLI on `PATH`, or inside the VS Code/Cursor ChatGPT extension (`~/.vscode/extensions/openai.chatgpt-*/bin/linux-x86_64/codex`), or at an absolute path you set with `PHONE_MONITOR_CODEX=/path/to/codex` or `"codexPath"` in `~/.config/phone-monitor/config.json`. `npm run doctor` shows which version it found. Only the verified version (`codex-cli 0.162.0-alpha.17.2`) is used; after a Codex update the card shows "unsupported" until compatibility is re-verified, rather than guessing at a changed protocol.

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

## 5b. Claude usage with no session open (opt-in, off by default)

The status line only reports while a Claude Code session is open and in use. To keep the Claude card current without one, turn on usage polling:

```
npm run claude-usage -- on        # or: off, status
```

While the phone is connected, the hub asks Anthropic for your usage every 3 minutes (`GET https://api.anthropic.com/api/oauth/usage`). The figures are account-wide, so they include use on claude.ai and the desktop app. It uses the sign-in Claude Code keeps in `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`), and reads only the access token and its expiry:

- The token is sent only in that request. It is never refreshed, written anywhere, logged, or sent to the phone.
- When the token has expired, or the service refuses it, the hub sends nothing. The card keeps its last readings, falls back to the status line, and asks you to open Claude Code, which renews the sign-in. Polling resumes on its own once the token is renewed.
- A rate-limited reply pauses polling for at least 15 minutes. Any other error pauses it for 5.
- The endpoint is not a documented public API, so a Claude Code or Anthropic change can break it. The status line keeps working either way, and newer readings from either source win, per window.

A running hub picks up `on` or `off` within a few seconds. Turning it off drops every polled reading.

## 6. Notification allowlist (empty by default)

Notification capture is off until you allow at least one app. The allowlist starts empty, holds at most ten bounded app labels, and is edited only on the laptop (the phone settings sheet just explains this):

```sh
npm run start --workspace @phone-monitor/desktop -- notifications allow "APP_LABEL"
npm run start --workspace @phone-monitor/desktop -- notifications remove "APP_LABEL"
npm run start --workspace @phone-monitor/desktop -- notifications list
```

A running hub applies changes without restarting other collectors. Only allowlisted notifications are kept (max 100 records, 30 minutes, memory only). If GNOME refuses D-Bus monitoring, the notification card shows "unavailable" and quotas keep working; no elevation is requested. App labels are the names apps send with their notifications (the bold name on GNOME's banner); apps that use GNOME's own `org.gtk.Notifications` or the desktop portal instead of the freedesktop `Notify` call are not captured, and very large notifications (over 256 KiB, e.g. embedded images) are dropped. UNRUN: live GNOME capture; a synthetic `notify-send` check is a manual opt-in step.

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

## 9. Controller Wi-Fi on the phone: native and manual steps (A3)

The phone reaches the controller at `192.168.4.1` over Wi-Fi while the laptop link stays on USB. Only the controller client uses the selected Wi-Fi network (each connection is opened on that `Network`); the app never binds the whole process to Wi-Fi, so USB loopback, and mobile data if present, are unaffected.

**Native (preferred).**

1. Power the controller and open the app in the foreground.
2. Tap the settings icon → **Connect controller**. One native "Controller Wi-Fi" dialog opens. Screenshots of it are blocked.
3. Type the controller's network name (`Rgb_Controller`) and its Wi-Fi password (the AP password configured in your RGB_Controller firmware; it is deliberately not copied into this repository) into that dialog only, then tap **Connect**. They are stored in app-private storage (backup disabled) and never shown to the dashboard, logs or diagnostics. The password is never prefilled.
4. Grant the one permission Android asks for: precise location on Android 10–12L (API 29–32; Location must also be switched on), or "Nearby devices" on Android 13+ (declared as not used for location).
5. Approve Android's prompt to join the controller network. It has no internet, which is expected.
6. Setup succeeds only once the controller itself answers over HTTP on that network. Internet validation is never used as readiness.

If you deny the permission, decline the prompt, or enter a wrong password, setup ends as failed and the app **does not ask again by itself**. Tap setup again when ready, or use the manual path. Leaving the app (Home, or another app taking over) releases the network request. Returning restores it from the stored settings, but only if it had previously reached the controller. Whether MIUI shows the approval prompt again on return is a device-acceptance observation (A3-D10).

**Manual fallback.**

1. Choose **Use Wi-Fi settings** in the dialog (or the dashboard's Wi-Fi settings action).
2. Join the controller network in Android settings. If asked, choose to stay connected without internet.
3. Return to the app. It observes the Wi-Fi network you joined and shows the controller as connected only after the controller replies.

**Stop using it.** Uninstalling the app, or clearing its storage, removes the stored controller settings. In manual mode, also forget the network in Android settings. The controller firmware and its access point are never modified by this product.

SOFTWARE-VERIFIED (JVM fakes): network selection and loss handling, the permission policy for API 29–33, no automatic re-prompting, strict controller parsing, and light-command ordering. UNRUN on hardware: every row A3-D1…A3-D14 in [DEVICE_ACCEPTANCE.md](DEVICE_ACCEPTANCE.md), including simultaneous USB + Wi-Fi on the Redmi.

## 10. Deck media and system keys (laptop requirements)

The Deck's now-playing panel and system keys read and change laptop state through fixed commands. The phone never sends a command line, and each tool is optional: if one is missing, only its own key or field stops working.

| Feature | Laptop tool | Command (fixed, no shell) |
|---|---|---|
| Now playing | `busctl` (systemd) and any MPRIS player (browsers, Spotify, mpv, ...) | reads `PlaybackStatus` and `Metadata` from `org.mpris.MediaPlayer2.*`; only the title, artist and player name are sent to the phone |
| Volume, mute, microphone | `wpctl` (PipeWire) | `wpctl get-volume` / `set-mute @DEFAULT_AUDIO_SOURCE@ toggle` |
| Do Not Disturb | `gsettings` (GNOME) | flips `org.gnome.desktop.notifications show-banners` |
| Lock | `loginctl` | `loginctl lock-session` |
| Screenshot | xdg-desktop-portal | opens the interactive GNOME screenshot tool; GNOME does not let other apps capture silently |
| Terminal | `ptyxis`, `gnome-terminal`, `kgx` or `x-terminal-emulator` | the first one found is started detached |

The hub polls this state every 2 seconds, and immediately after any Deck key, so status lights follow quickly. VERIFIED (software): fake-runner tests in `desktop/test/host.test.ts` and `desktop/test/actions.test.ts`, plus a read-only live read on the development laptop.

## 11. Lamp signals (phone)

Lamp signals run entirely on the phone, which is the only device that talks to the lamp controller. When a new Claude/Codex alert arrives, a new WhatsApp alert arrives, or a usage window that was at 100% drops back, the app sets the lamp to a 4-second Breathe pulse (cyan, green or white). It then restores the previous colour, mode, brightness, speed and power, unless you changed the lamp in the meantime. Signals are at least 15 seconds apart. Alerts already on screen when the app opens never signal.

Settings → **Lamp signals** has one switch per signal, quiet hours (11 PM to 8 AM, on by default) and **Try a signal**. The choices are stored on the phone only.

## 12. Release builds

`node scripts/build.mjs --release` builds, tests, lints and signs the APK, verifies it with `apksigner`, and copies it to `artifacts/lumendock-<version>.apk`. It deletes any `artifacts/phone-monitor-debug.apk` so a release package never ships a debug build.

Signing reads a private properties file that never enters the repository:

```
storeFile=/absolute/path/to/your-release.jks
storePassword=...
keyAlias=...
keyPassword=...
```

Point `LUMENDOCK_SIGNING` at it (default `~/.local/share/phone-monitor/signing/release.properties`). Keep the keystore backed up: Android only accepts updates signed with the same key, so losing it means users must uninstall (and pair again) to move to a new key. To create your own:

```sh
keytool -genkeypair -keystore my-release.jks -storetype PKCS12 -alias lumendock -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=LumenDock"
```
