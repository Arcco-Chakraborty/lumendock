# Device acceptance matrix

**Software verified is not device accepted.** JVM tests, lint, APK builds and compiled-but-unexecuted instrumentation prove only the software seams. Every row below must be executed on the selected Redmi 9A (Android/MIUI build recorded at the time of execution) against the real laptop hub before its behaviour can be claimed. A row stays `UNRUN` until a person runs it and records the date, APK SHA-256, phone build, and observed result.

Record only sanitized evidence: no phone serial, pairing code, token, Wi-Fi password, notification text or raw capture in this file. Use `npm run doctor` (serials masked) for device identification.

Status values: `UNRUN` · `PASS` · `FAIL` (with a linked finding) · `BLOCKED` (with the missing prerequisite).

## PRD acceptance matrix A01-A17 (status as of 2026-10-15)

Two columns on purpose: **Software** = automated/browser/JVM evidence run by Claude Code (Node 24.22.0, JDK 17, Chrome 155 headless); **Device** = Redmi 9A / ESP32 / real desktop, all of which are `UNRUN` because no phone or controller was attached. No row is "complete" on software evidence alone.

| ID | Software | Device | Evidence / what is missing |
|---|---|---|---|
| A01 | PASS (partial) | UNRUN | Production APK builds (`artifacts/phone-monitor-debug.apk`, 4,361,672 B); shell and setup states render in headless Chrome e2e with a fake bridge. Not installed on a phone. |
| A02 | UNRUN | UNRUN | Needs simultaneous USB hub + controller Wi-Fi on the Redmi (rows A2-D1, A3-D1). JVM tests prove only that the controller factory gets the selected Wi-Fi and the hub client stays unbound. |
| A03 | PASS (fixtures) | UNRUN | Collectors tested with synthetic data only. No comparison with the real provider views; no inference was made for testing. |
| A04 | PASS | n/a | Dashboard vitest + e2e: unknown/zero/fractional/over-100%/expired/stale quotas and nonstandard Codex windows (screenshots `dashboard/evidence/w3a-*`). |
| A05 | PASS (JVM/fake) | UNRUN | Reconnect/backoff/age tests; physical unplug/replug is A2-D2. |
| A06 | PASS (JVM/fake) | UNRUN | onLost cancel/no-replay tests; power-cycle is A3-D8. |
| A07 | PASS (queue tests) | UNRUN | ControlQueue/lightIntent tests incl. no timer replay; actual strip is A3-D12/D13. |
| A08 | PASS | UNRUN | Parser/UI tests for ok=false, nulls, malformed, history gaps; no real sensor fault observed. |
| A09 | PASS (temp files) | UNRUN | `claude-cli`/installer tests; live opt-in on a real Claude settings file not done. |
| A10 | PASS (hand-written fixture) | UNRUN | Collector tests; Codex was to verify the wire format on an isolated private bus (result not recorded here). No real GNOME capture. |
| A11 | PARTIAL | UNRUN | Bridge/origin/token-redaction/markup tests exist; no dedicated security review has been run by a gpt-6 reviewer. |
| A12 | PASS (JVM lifecycle) | UNRUN | Lifecycle regression tests; real background/approval/renderer/process/ADB transitions unrun (A2-D4, A3-D10/D11). |
| A13 | PASS | UNRUN | Playwright 18/18 at 800x360, 740x320, 360x800, 130% text, reduced motion; real Redmi viewport/textZoom unknown. |
| A14 | PASS (size) | UNRUN | JS+CSS 336,704 B <= 768,000 B; APK 4,361,672 B <= 20 MiB. Three-second startup not measured on device. |
| A15 | UNRUN | UNRUN | 60-minute and 2-hour soaks and PSS measurement need the phone. |
| A16 | NOT DONE | NOT DONE | Requires a `gpt-6-astra` high whole-project review; not runnable from Claude Code. Claude-built tasks D3, W2 repair, A2, A3, W3a/W3b also still need independent non-Claude review. |
| A17 | see below | n/a | Cold-resume check result recorded below once run. |

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

All rows below are **UNRUN**: no phone or controller was attached during A3. JVM fakes prove only that the controller client receives the selected Wi-Fi `Network` while the laptop client stays unbound; they cannot prove real Android routing, MIUI prompts, or strip behaviour.

Preconditions (in addition to the A2 preconditions for any row that uses the laptop link):

1. The existing ESP32 controller is powered with its unmodified firmware (AP address `192.168.4.1`). Do not flash or edit it. Its SSID and password are typed only into the phone's native dialog and are **never** recorded here.
2. Record the phone's Android API, MIUI build, WebView version, and whether a SIM/mobile data is present. Record the exact system prompt titles/buttons seen (sanitized), not assumptions about them.
3. The diagnostic APK shows a sanitized "Controller link" panel (`esp.state` every 3 s while visible, plus history and test light buttons). The production APK shows the same through the dashboard.
4. Read evidence **on the phone** (panel/dashboard and `app.status`), never from laptop connectivity alone.

| ID | Row | Exact steps | Expected result | Status |
|---|---|---|---|---|
| A3-D1 | **Simultaneous USB + Wi-Fi independence (essential)** | 1. Complete A2-D1 so the laptop link is `connected` over USB. 2. Run A3-D2 so the controller link is `connected`. 3. Leave both running 5 min with mobile data **on**, then 5 min with mobile data **off** (and, if no SIM, note that). 4. On the laptop, open any website to confirm its own internet. | Both panels stay `connected` at the same time with ages under about 3 s (laptop) and 4 s (controller) throughout. Neither link flaps when mobile data toggles. The laptop keeps internet and never joins the controller AP. `app.status` shows `paired:true` and `wifiMode:"app_request"`. | UNRUN |
| A3-D2 | Native app-specific request and approval | 1. Tap **Connect controller** (diagnostic) or the dashboard's controller setup. 2. Enter SSID and password in the native "Controller Wi-Fi" dialog; tap **Connect**. 3. Grant the runtime permission shown (location on API 29–32, Nearby devices on 33+). 4. Approve the system network prompt. | The bridge acknowledges at once; one native dialog opens; screenshots of it are blocked. Exactly one permission prompt, then one system network-approval prompt; neither stop cancels the setup. Setup becomes `succeeded` only after the controller answered over HTTP (panel shows real state), not merely when Android joined. No "no internet" condition blocks it; USB stays `connected`. | UNRUN |
| A3-D3 | Denial and declined approval | 1. Start setup, **deny** the runtime permission. 2. Press Home, return, wait 2 min. 3. Start setup again, grant, then **decline/cancel** the system network prompt. 4. Background and return again. | Step 1: setup `failed` (`WIFI_UNAVAILABLE`), the explanation offers Wi-Fi settings. Steps 2 and 4: **no** permission or network prompt appears by itself. Step 3: setup `failed`; nothing retries until the user taps setup again. | UNRUN |
| A3-D4 | Wrong password | Start setup with a deliberately wrong password and approve the prompt. | Android reports the network unavailable (record what MIUI shows). Setup `failed`; the wrong request is not re-issued on background/return; a corrected attempt works. | UNRUN |
| A3-D5 | Location services off (API 29–32 only) | With Location turned off in quick settings, start setup and grant the permission. | The app stops before requesting the network and explains that Location must be on (button to Location settings). After enabling Location and tapping setup again it proceeds. On API 33+ this row is N/A (Location is not needed). | UNRUN |
| A3-D6 | Manual Wi-Fi fallback | 1. In the native dialog choose **Use Wi-Fi settings**, join the controller AP in Android settings (choose to stay connected without internet). 2. Return to the app. 3. Repeat while joined to a normal home Wi-Fi instead. | Step 2: `wifiMode:"manual"`; the controller link becomes `connected` only after a real controller reply. Step 3: the controller link is **not** shown connected (it reports disconnected/timeout) because the controller does not answer there. | UNRUN |
| A3-D7 | USB unplug while controller continues | With A3-D1 running, unplug USB for 60 s, operating the light controls meanwhile. | Laptop link goes `disconnected`/stale with retained data; controller link stays `connected` and every light control still works. Replug restores the laptop link without re-pairing. | UNRUN |
| A3-D8 | Controller AP power cycle while hub continues | With A3-D1 running, power the controller off for 60 s, then on. | Controller link shows `disconnected` and becomes stale after 9 s with the last reading and its age retained; laptop link stays `connected`. In-flight/queued light commands become unconfirmed/cancelled and are **not** replayed when the AP returns. Record whether Android rejoins automatically; if it does not, a manual tap reconnects without extra prompts. Uptime drop is accepted and history refreshes. | UNRUN |
| A3-D9 | Default-network change | With A3-D1 running, toggle airplane mode off→on→off with Wi-Fi re-enabled, and switch mobile data on/off. | Old controller requests are cancelled on loss; controller traffic always uses the selected Wi-Fi (never mobile data); USB loopback is unaffected. | UNRUN |
| A3-D10 | Background, return and process death | 1. With the controller `connected`, press Home 60 s, return. 2. Remove the app from recents (or `adb shell am kill com.phonemonitor` while backgrounded), reopen. | Hidden: controller polling stops and the app's Wi-Fi request is released. On return the request is restored without re-entering credentials (record whether MIUI re-prompts) and the link recovers; queued commands from before are not replayed. After process death the same happens from the privately stored settings. | UNRUN |
| A3-D11 | Approval pause versus interruption | 1. Start setup and leave the system network prompt on screen for 60 s, then approve. 2. Start again and, while the prompt is shown, take an incoming call or press Home. | Step 1: setup survives the prompt and succeeds. Step 2: setup becomes `cancelled` and the pending request is released; no request keeps running in the background. | UNRUN |
| A3-D12 | Light controls against the strip | With the controller `connected`: power on, power off (explicit values, never a toggle); each colour preset and a custom hex; brightness 1 and 100; modes 0–8 in turn; speed 1 and 100; then drag the brightness slider rapidly for 5 s and release. | The strip follows each command and the confirmed state matches. Pending/unconfirmed markers clear on confirmation. The rapid drag never exceeds 4 dispatched writes per second and the strip ends at the released value. | UNRUN |
| A3-D13 | Sleep timer semantics | 1. Set a 1-minute timer; wait. 2. Set a 5-minute timer, then power off. 3. Set a timer, then immediately power the controller off before the reply. | Step 1: the strip turns off after about 60 s. Step 2: power-off clears the timer. Step 3: the timer shows unconfirmed and is **never** resent after the controller returns; a new timer needs an explicit tap. | UNRUN |
| A3-D14 | Physical buttons and sensor | 1. Press the controller's power and mode buttons. 2. If safely possible, disconnect the DHT11 (or observe a real `ok=0`). | Step 1: the next state read (within about 3 s) shows the change, and a newer pending dashboard intent is not erased. Step 2: sensor shows unavailable with the old reading labelled, while the controller link stays `connected` and light controls keep working; history shows gaps. | UNRUN |

## W3 — Dashboard on device

Rows to be added by W3 (800×360 / 740×320 fit, portrait readability, font scaling, soak/startup).

## Final dual-link acceptance

A3-D1 is the component-level dual-link row. Rows to be added at integration (simultaneous USB laptop link and controller Wi-Fi, final Astra-high review gate).
