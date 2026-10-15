# Phone Monitor testing

Two completion levels exist and must never be conflated: **software verified** (automated tests, typecheck, build, read-only smoke runs pass) and **device accepted** (the real Redmi 9A and ESP32 pass the matrix in [the PRD](PRD.md)). Everything under "Automated" can be re-run by anyone; everything under "Physical" is **UNRUN** until someone records a result below. A mock or fake-runner pass is not evidence of USB routing, MIUI lifecycle behaviour or light output.

## Automated (software)

```sh
export PATH=$HOME/.local/share/phone-monitor/toolchains/node-v24.22.0-linux-x64/bin:$PATH
npm run test --workspace @phone-monitor/desktop
npm run typecheck --workspace @phone-monitor/desktop
npm run build --workspace @phone-monitor/desktop
```

Desktop tests for setup/operation (all use fakes and temp directories; no real adb device, no `systemctl`, no real notification stream, no provider auth, no model calls):

| File | Covers |
|---|---|
| `desktop/test/adb.test.ts` | `adb devices -l` parser (hostile/odd lines), offline/unauthorized/no-permission/wrong/multiple/wireless/emulator devices, argv-only serials, port conflict, mapping verification, unplug/replug restoration, back-off, generation-owned `stop()` with no timers or children left |
| `desktop/test/service.test.ts` | unit rendering/quoting, absolute paths, modes 0644 (unit) and 0600/0700 (record/dir), idempotent reinstall, refusal to overwrite or remove a modified/unowned/symlinked unit, interrupted-install recovery, enable only on request, disable on uninstall |
| `desktop/test/setup-cli.test.ts` | doctor JSON/text, serial masking, missing tools, strict option parsing, `connect` flows, install/uninstall command behaviour |
| `desktop/test/notifications.test.ts` | notification collector and allowlist (owned by D3-A; not part of this task's evidence) |

Read-only smoke runs recorded for this task (no phone attached): `npm run doctor`, `npm run doctor -- --json`, `npm run connect` (usage error), `connect --serial <wireless>` (rejected), `install-hub --print` (output accepted by `systemd-analyze verify`). The adb server may be started by `adb devices`; nothing was paired or authorized.

## Physical acceptance (UNRUN)

Record a dated, sanitized result (no serial, token, SSID password or notification text) for each row. Relevant to this task:

| ID | Setup-related check | Status |
|---|---|---|
| A02 | `npm run connect -- --serial SERIAL` shows Connected; phone reaches the hub over USB while joined to the ESP AP; laptop keeps internet | UNRUN |
| A05 | Unplug and replug the cable with `connect` running: "Waiting" then "Connected" again; laptop cards recover within 20 s of authorization; room controls unaffected | UNRUN |
| A10 | Empty allowlist shows capture off; after `notifications allow`, a synthetic `notify-send` event appears within 3 s; denied D-Bus monitoring shows "unavailable" while quotas work | UNRUN |
| A09 | Live opt-in of the Claude status-line wrapper keeps the previous output and restores on uninstall (no CLI entry point exists yet) | UNRUN |
| Service | `install-hub --enable`, log out/in, hub is listening on 127.0.0.1:8765; `uninstall-hub` removes only the unit; edit the unit then confirm uninstall refuses | UNRUN |
| Port conflict | Occupy tcp:8765 on the phone side and confirm the fixed PORT_CONFLICT message with nothing killed | UNRUN |
| Multiple devices | Attach two phones; confirm `connect` without `--serial` refuses and each `--serial` affects only its phone | UNRUN |

Manual procedure for A05: run `npm run connect -- --serial SERIAL`, wait for "Connected", pull the cable ("Waiting (DEVICE_NOT_FOUND)"), replug and tap Allow USB debugging if asked ("Waiting (DEVICE_UNAUTHORIZED)" then "Connected"), and confirm `adb -s SERIAL reverse --list` shows `tcp:8765 tcp:8765`.

Manual synthetic notification check (opt-in, after allowing a label): `notify-send "SYNTHETIC-TEST" "synthetic body"` from an allowed app label; never inspect or retain real notification streams.

## Privacy and cleanup checks

Before sharing any report: confirm it contains no full serial (doctor masks by default), token, Wi-Fi password, account identity, or notification body. Confirm that after stopping `connect` or the hub no `adb` child or timer remains (`pgrep -a adb` shows only the long-lived adb server), and that uninstall left unrelated unit/settings files byte-identical.

## Final gates

Independent review and the final Astra-high project review are separate gates tracked in `HANDOFF.md`/`docs/STATUS.json`; this file does not claim them.

## Claude status-line commands (software-verified, temp settings only)

`desktop/test/claude-cli.test.ts` (8 tests) covers: dry run writes nothing and never prints the existing command; install/idempotent reinstall/uninstall preserving unrelated edits; refusal of an existing command without the declared shell, exact `2.1.N` version, shell attestation and cancellation attestation (four separate refusals, settings unchanged); acceptance only with all of them and exact restore on uninstall; uninstall refusing after a user edit; unknown/duplicate/relative arguments rejected. The D2 installer gates are unchanged. UNRUN: opt-in on a real Claude settings file with a real Claude session.

