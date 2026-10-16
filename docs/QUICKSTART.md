# Quickstart: from cable to running dashboard

The short path for an Android phone (developed on a Redmi 9A with MIUI). Full details, troubleshooting and uninstall are in [SETUP.md](SETUP.md).

Run every command from the repository root. If you use the project toolchain, put it first on `PATH`:

```sh
export TC=$HOME/.local/share/phone-monitor/toolchains
export PATH=$TC/node-v24.22.0-linux-x64/bin:$PATH
```

## 0. Laptop (once)

```sh
npm ci
npm run build
npm run doctor
```

Get the phone app: download `lumendock-<version>.apk` from the [latest release](https://github.com/Arcco-Chakraborty/lumendock/releases/latest) into `artifacts/`, or build it yourself with `node scripts/build.mjs --release` (your own key) or `node scripts/build.mjs` (debug).

## 1. Prepare the phone (once)

1. **Settings → About phone → tap "MIUI version" (or "Build number") 7 times** to unlock Developer options.
2. In **Developer options**, turn on:
   - **USB debugging**
   - **Install via USB** on Xiaomi/Redmi phones. MIUI blocks `adb install` without it, and may ask you to sign in to a Mi account or insert a SIM once.
3. Plug the phone into the laptop and **unlock it**. Tap **Allow** on "Allow USB debugging?" and tick "Always allow from this computer". No tool can do this for you.

## 2. Install the app

```sh
npm run doctor                 # must list 1 authorized physical USB device
adb devices -l                 # copy the serial yourself; never paste it into tracked files
adb -s SERIAL install -r artifacts/lumendock-<version>.apk
```

If the phone asks to confirm the install, tap **Install**. `INSTALL_FAILED_USER_RESTRICTED` means "Install via USB" is still off. `INSTALL_FAILED_UPDATE_INCOMPATIBLE` means a build signed with a different key is installed (for example, a debug build). Uninstall that first with `adb -s SERIAL uninstall com.phonemonitor`; you then pair again and rejoin the lamp Wi-Fi.

## 3. Link the phone to the laptop (terminal A, leave running)

```sh
npm run connect -- --serial SERIAL
```

This forwards only the phone's `127.0.0.1:8765` to the laptop hub over USB, and restores it after unplug/replug. Ctrl-C stops it.

## 4. Start the hub and pair (terminal B)

```sh
npm run start --workspace @phone-monitor/desktop -- --pair
```

It prints an **8-digit code valid for 2 minutes**. On the phone, open **LumenDock**, tap **Pair laptop** (on the main screen, or settings → **Pair laptop**), and type the code into the native **Pair with laptop** dialog. When the bar shows "Laptop connected", stop the hub (Ctrl-C) and stop `connect` in terminal A.

## 5. Run it in the background

```sh
./phone-monitor.sh start      # hub + USB link in the background
./phone-monitor.sh status
./phone-monitor.sh logs
./phone-monitor.sh stop
```

The same commands exist as `npm run service:start|status|logs|stop`. To start the hub at login instead, see the optional service in [SETUP.md](SETUP.md#7-optional-login-service-foreground-is-the-default).

## 6. Connect the lamp (phone only)

Power on the ESP32. In the app's settings, tap **Connect controller**. Enter the controller's network name (`Rgb_Controller`) and its Wi-Fi password (from your RGB_Controller firmware configuration), tap **Connect**, and approve Android's one-time prompt to join this no-internet network. If Android declines, choose **Use Wi-Fi settings** and join it manually. The USB link to the laptop stays independent of this Wi-Fi.

## 7. Turn on the data you want (laptop)

```sh
npm run claude-install -- --dry-run      # shows what would change; run again without --dry-run to opt in
npm run start --workspace @phone-monitor/desktop -- notifications allow "WhatsApp"   # repeat per app; default is none
```

- **Codex** usage appears automatically. The hub finds the Codex CLI on `PATH` or inside the VS Code ChatGPT extension; `npm run doctor` shows the version it found.
- **Claude** usage appears after your next Claude Code session, once the status line is installed.
- **Notifications:** use the app name exactly as GNOME shows it on the notification banner.

## You are running when

- the bottom bar shows **Laptop connected** and **Controller connected**,
- the Claude and Codex panels show percentages and reset times,
- the room panel shows temperature and humidity.

## Using it

**Monitor** shows the time, the room, Claude/Codex usage and recent alerts. Tap **Details** or **View N** on a usage panel for every window, and **History** for room readings.

**Deck** has four rows: app launchers, now playing with media keys, system keys (volume, mute, mic, Do Not Disturb, lock, screenshot tool) and lamp keys. **Controls** opens colour, brightness, all nine modes, speed and the sleep timer.

**The bottom bar** switches between Monitor and Deck and opens settings. It slides over the bottom of the screen and hides after eight seconds; tap the bottom edge to bring it back. Key feedback shows in that edge strip.

**Settings → Lamp signals** turns each lamp pulse on or off, sets quiet hours (11 PM to 8 AM), and has **Try a signal** to preview one.
