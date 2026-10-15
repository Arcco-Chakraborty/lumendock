# Device acceptance matrix

**Software verified is not device accepted.** JVM tests, lint, APK builds and compiled-but-unexecuted instrumentation prove only the software seams. Every row below must be executed on the selected Redmi 9A (Android/MIUI build recorded at the time of execution) against the real laptop hub before its behaviour can be claimed. A row stays `UNRUN` until a person runs it and records the date, APK SHA-256, phone build, and observed result.

Record only sanitized evidence: no phone serial, pairing code, token, Wi-Fi password, notification text or raw capture in this file. Use `npm run doctor` (serials masked) for device identification.

Status values: `UNRUN` · `PASS` · `FAIL` (with a linked finding) · `BLOCKED` (with the missing prerequisite).

## Common preconditions (A2 transport rows)

1. Hub built and started on the laptop (`npm run build --workspace @phone-monitor/desktop`; `npm run start --workspace @phone-monitor/desktop`, adding `-- --pair` only where a row says so).
2. Phone has USB debugging enabled and this laptop's adb key authorized; `npm run doctor` lists it as an authorized physical USB device.
3. Reverse mapping held by the D3 launcher in the foreground: `npm run connect -- --serial SERIAL`.
4. APK installed: the diagnostic APK (`node scripts/build.mjs --diagnostic`) shows the sanitized "Laptop link" panel, refreshed every 2 s while visible; the production APK shows the same through the dashboard. Note which APK and its SHA-256.
5. Evidence is read **on the phone** (diagnostic panel or dashboard laptop status), not from laptop-side health checks.

## A2 — USB hub link

| ID | Row | Exact steps | Expected result | Status |
|---|---|---|---|---|
| A2-D1 | Pair | 1. Stop the normal hub; start `npm run start --workspace @phone-monitor/desktop -- --pair`. 2. On the phone tap **Pair laptop** (diagnostic) or the dashboard's pairing action. 3. Wait more than 30 s, then type the 8-digit code into the native "Pair with laptop" dialog and tap **Pair**. 4. Repeat once with a deliberately wrong code first. 5. Separately, open pairing, wait more than 120 s, then submit. 6. Restart the hub without `--pair`. | Exactly one native dialog opens; the bridge acknowledges immediately and the page does not time out while the code is typed. Wrong code: dialog stays open with "not accepted", and the hub counts the attempt. Correct code: dialog closes, `app.status` shows `paired:true` and hub setup `succeeded`; the link becomes `connected` with quota windows. Expired: setup `failed` with `PAIRING_EXPIRED` and no token stored. Dialog screenshot is blocked (FLAG_SECURE). No token or code is visible anywhere in the WebView. | UNRUN |
| A2-D2 | Unplug / replug | 1. With link `connected`, unplug USB for about 20 s. 2. Watch the phone panel. 3. Replug; accept the ADB authorization prompt if MIUI shows one; keep `npm run connect` running. | Within 6 s of the last success the link shows `disconnected` with `stale`, and the same payload is retained with its age still increasing (not reset). Retries back off at 1/2/4/8/15 s, never faster. After replug and reverse restoration the link returns to `connected` within about 15 s **without re-pairing**. If authorization is revoked, the row records the prompt and that recovery still needs no re-pair. | UNRUN |
| A2-D3 | Hub restart | 1. With link `connected`, stop the hub process (Ctrl-C or `systemctl --user stop` if installed as a service). 2. Wait 30 s. 3. Start it again without `--pair`. | Phone shows `disconnected`, retained data stale with increasing age; the token is not erased (no pairing prompt, `paired` stays true). After restart the link reconnects automatically with the existing token. | UNRUN |
| A2-D4 | Background / return | 1. With link `connected`, press Home for 60 s. 2. On the laptop, check for snapshot requests while the app is hidden (none expected; e.g. note that Codex polling slows after 10 s without phone activity). 3. Return to the app. 4. Also try a call or other full-screen interruption while the pairing dialog is open. | Hidden: no snapshot polling, and any in-flight request is cancelled. On return the first poll goes out at once; the age reflects the real elapsed time and the link returns to `connected`. An interruption while pairing cancels that setup flow (setup `cancelled`), and the pairing persists if it had already completed. | UNRUN |
| A2-D5 | Orientation | 1. Hold the phone portrait and launch the app. 2. Rotate to landscape, then deliberately hold portrait (either way up) for 2 s. 3. Rotate back to landscape. 4. Relaunch the app from the launcher. 5. Repeat step 1 with system auto-rotate off. | Step 1: the app starts in landscape even though the phone is held portrait. Step 2: after about 1.2 s of portrait hold it switches to portrait and stays usable (pairing dialog and text readable). Step 3: it follows to landscape. Step 4: the new launch starts landscape again. Rotation never recreates the Activity: pairing state and the link age are preserved across rotation. Step 5 behaviour is recorded as observed (the policy uses `fullSensor` once unlocked). | UNRUN |
| A2-D6 | Instrumentation on device | `./android/gradlew -p android -PdiagnosticUi=true :app:connectedDebugAndroidTest` on the authorized phone (no laptop needed for `HubLinkInstrumentationTest`). | `DashboardSecurityTest`, `BridgeOriginInstrumentationTest` and `HubLinkInstrumentationTest` pass on the installed WebView. | UNRUN |

## A3 — Controller Wi-Fi and lighting

Rows to be added by A3 (explicit Wi-Fi request/approval, no-internet AP, USB unaffected by Wi-Fi, light command reconciliation, sensor loss).

## W3 — Dashboard on device

Rows to be added by W3 (800×360 / 740×320 fit, portrait readability, font scaling, soak/startup).

## Final dual-link acceptance

Rows to be added at integration (simultaneous USB laptop link and controller Wi-Fi, final Astra-high review gate).
