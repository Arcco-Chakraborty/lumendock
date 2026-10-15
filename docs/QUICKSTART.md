# Phone quickstart: from cable to running dashboard

The short path for a Redmi 9A (Android 10+, MIUI). Full details, troubleshooting and uninstall are in [SETUP.md](SETUP.md). Everything here is software-verified only; the steps have not yet been run on the real phone, so record what happens in [DEVICE_ACCEPTANCE.md](DEVICE_ACCEPTANCE.md).

Run every command from the repository root with the project toolchain first on `PATH`:

```sh
export TC=$HOME/.local/share/phone-monitor/toolchains
export PATH=$TC/node-v24.22.0-linux-x64/bin:$PATH
```

## 0. One-time laptop build (skip if `npm run doctor` already shows both builds)

```sh
npm ci
npm run build
JAVA_HOME=$TC/jdk17 ANDROID_HOME=$TC/android-sdk node scripts/build.mjs   # builds the APK into artifacts/phone-monitor-debug.apk
npm run doctor
```

## 1. Prepare the phone (once)

1. **Settings → About phone → tap "MIUI version" 7 times** to unlock Developer options.
2. **Settings → Additional settings → Developer options**, turn on:
   - **USB debugging**
   - **Install via USB** (MIUI blocks `adb install` without it; it may ask you to sign in to a Mi account or insert a SIM once).
3. Plug the phone into the laptop and **unlock it**. Tap **Allow** on "Allow USB debugging?" (tick "Always allow from this computer"). No tool can do this for you.

## 2. Install the app

```sh
npm run doctor                 # must list 1 authorized physical USB device
adb devices -l                 # copy the serial yourself; never paste it into tracked files
adb -s SERIAL install -r artifacts/phone-monitor-debug.apk
```

If MIUI shows an install confirmation on the phone, tap **Install**. `INSTALL_FAILED_USER_RESTRICTED` means "Install via USB" is still off.

## 3. Link the phone to the laptop (terminal A, leave running)

```sh
npm run connect -- --serial SERIAL
```

This forwards only the phone's `127.0.0.1:8765` to the laptop hub over USB and restores it after unplug/replug. Ctrl-C stops it.

## 4. Start the hub and pair (terminal B)

```sh
# if you installed the login service earlier: systemctl --user stop phone-monitor-hub.service
npm run start --workspace @phone-monitor/desktop -- --pair
```

It prints an **8-digit code valid for 2 minutes**. On the phone, open **Phone Monitor** and tap **Pair laptop** on the main screen (or settings icon → **Pair laptop**), and type the code into the native **Pair with laptop** dialog. After "Laptop connected" appears, stop the hub (Ctrl-C) and start it again **without** `--pair` so pairing stays closed:

```sh
npm run start --workspace @phone-monitor/desktop
```

(Optional: `./phone-monitor.sh start` or `npm run service:start` runs both the hub and ADB supervisor in the background as a single command, without registering startup permissions; see below.)

### Everyday background runner (laptop)

To start or stop all laptop background tasks with a single command without installing login services:

```sh
./phone-monitor.sh start      # or: npm run service:start (starts hub + adb reverse supervisor in background)
./phone-monitor.sh status     # or: npm run service:status (checks hub & adb supervisor)
./phone-monitor.sh logs       # or: npm run service:logs (streams hub & connection logs)
./phone-monitor.sh stop       # or: npm run service:stop (stops both at once)
```

## 5. Connect the light controller (phone only)

Power on the ESP32. In the app's settings tap **Connect controller**, enter the controller's network name (`Rgb_Controller`) and its Wi-Fi password (from your RGB_Controller firmware configuration), tap **Connect**, and approve Android's one-time prompt to join this no-internet network. If Android declines, choose **Use Wi-Fi settings** and join it manually. The USB laptop link stays independent of this Wi-Fi.

## 6. Turn on the data feeds you want (laptop)

```sh
npm run claude-install -- --dry-run      # shows what would change; then without --dry-run to opt in
npm run start --workspace @phone-monitor/desktop -- notifications allow "APP_LABEL"   # optional, default is no notifications
```

Codex usage appears automatically: the hub finds the Codex CLI on `PATH` or inside the VS Code ChatGPT extension (`npm run doctor` shows the version it found). Claude usage appears after your next Claude Code session once the status line is installed.

## You are running when

- the bottom control dock shows **Laptop connected** and **Controller connected**,
- the Claude/Codex cards show percentages and reset times,
- **Monitor** shows room temperature/humidity, and **Deck** gives access to lighting controls.

Then fill in the rows of [DEVICE_ACCEPTANCE.md](DEVICE_ACCEPTANCE.md), starting with A2-D1 (pair) and A3-D1 (USB + Wi-Fi at the same time).

## Use Monitor and Deck

**Monitor** is the glanceable screen for local time/date, room readings, Claude/Codex limits and recent selected alerts. Open provider details to see every reported usage window, and History for room readings.

**Deck** contains the existing app shortcuts, audio/media controls and lighting presets. Open Light controls for colour, brightness, all modes, speed and timer.

The bottom control dock switches between Monitor and Deck and opens Settings. It hides after eight seconds of inactivity; tap the small bottom handle to show it again. It stays accessible while a control has keyboard focus. Settings contains laptop/controller setup and display preferences. The phone clock remains available without either connection.
