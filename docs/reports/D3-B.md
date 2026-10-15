# D3-B report: selected-device USB, doctor, optional service, setup docs

Status: software implemented and verified on the laptop; nothing physical (Redmi, real adb transport, real systemd user manager, live capture) was exercised. Not committed (coordinator commits).

## Files
- New: `desktop/src/adb.ts` (AdbConnection, parsers, mask), `desktop/src/service.ts` (unit render, install/uninstall), `desktop/src/doctor.ts`, `desktop/src/setup-cli.ts` (testable cores of the four scripts).
- New scripts: `scripts/doctor.mjs`, `connect.mjs`, `install-hub.mjs`, `uninstall-hub.mjs` (thin wrappers over `desktop/dist`), `scripts/lib/dist.mjs`.
- Edited: `scripts/workspace.mjs` (doctor/install-hub/uninstall-hub dispatch; old inline doctor removed), root `package.json` (`install-hub`, `uninstall-hub` npm scripts).
- Tests: `desktop/test/adb.test.ts` (22), `service.test.ts` (15), `setup-cli.test.ts` (14).
- Docs: `docs/SETUP.md`, `docs/TESTING.md`. Untouched: android/, dashboard/, packages/, main.ts, config.ts, collectors/, notifications-cli.ts.

## Commands run
- `npm run test --workspace @phone-monitor/desktop`: 13 files, 172/172 pass (66 original + 51 mine + D3-A's files present at run time).
- `npm run typecheck --workspace @phone-monitor/desktop`: pass. `npm run build --workspace @phone-monitor/desktop`: pass.
- Smoke (no phone): `doctor` text and `--json`; `connect` without serial (exit 2), wireless serial (exit 1), absent serial (exit 1); foreground `connect` stopped by SIGINT ("Stopped", no leftover child); `install-hub --print` output passes `systemd-analyze verify`.
- Read-only adb only (`adb version`, `adb devices -l`); an adb server is running (`adb devices` starts one). No reverse, install, systemctl, pairing or enable was run.

## Design decisions
- Device selection is strict: explicit serial always required (even with one device); must be state `device`, a `usb:` port reported, and not wireless/mDNS/emulator (`:`, `tcp`, `mdns`, `_adb`, `adb-` forms rejected). Unknown/oversized lines are dropped; at most 64 devices parsed.
- Serial/args always argv (execFile, shell:false). Errors are fixed codes/messages and never echo adb output (it can contain serials). Port conflict (adb stderr, or a different existing tcp:8765 mapping) gives a fixed actionable error; nothing is killed.
- Watcher: each poll lists devices and checks `reverse --list`, restoring only when the mapping is missing (covers unplug/replug, reauth, adb server restart). One timer, one in-flight child, AbortController per generation; `stop()` clears the timer, aborts the child and awaits it. Waiting for cable/authorization polls at the base 2 s; real adb errors back off to 10 s.
- Doctor output has no paths, serials (masked `ABCD****`, whole serial hidden if <=4 chars) or accounts; `--show-serial` opt-in. Exit 1 only for Node!=24 or missing adb; JDK/SDK/provider CLIs are warnings.
- Service: unit 0644 with absolute node/hub paths (systemd-escaped, `%`/`$` doubled), `XDG_CONFIG_HOME` and `PATH` env, `Restart=on-failure`. Ownership record `hub-service.json` (0600, sha256 of unit, phased pending/installed/uninstall_pending like claude/install.ts) under a lock. Uninstall refuses with UNIT_MODIFIED before touching anything, including systemd state. Install writes the unit and daemon-reloads only; `--enable` is explicit; `systemctl` is always injected.

## Known gaps / notes for coordinator
- `main.ts` has no `--config-dir`; the unit passes the config dir via `XDG_CONFIG_HOME` and therefore requires the directory to be named `phone-monitor`.
- No CLI entry point exists for the Claude status-line installer (`claude/install.ts` is library-only); SETUP.md says so and keeps existing-command passthrough disabled. Needs a follow-up if the user wants the opt-in flow before final.
- `doctor` and `connect` need `desktop/dist` built (clear message otherwise). `doctor.ts` imports `CODEX_COMPATIBLE_VERSION` from `collectors/codex.ts`.
- SETUP.md documents `npm run start --workspace @phone-monitor/desktop -- notifications allow|remove|list` as implemented by D3-A's `main.ts`; not independently verified by me.
- `connect` does not probe whether the hub is listening; run the hub first (documented).
- Root `package.json` was edited (two script lines); coordinate if another owner edits it.

## NOT verified
Real adb reverse on a Redmi, unplug/replug with hardware, real port conflict text from adb (matched on common adb phrasings only), multi-device attach, USB `usb:` field format on this device, systemd enable/login/reboot, real `systemctl --user` behaviour, ESP Wi-Fi coexistence, live Claude/Codex/GNOME capture. Software-verified is not device-accepted.
