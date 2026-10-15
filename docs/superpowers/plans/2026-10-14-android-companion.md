# Android Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a small Android host whose native transports simultaneously reach the laptop through USB loopback and the controller through Wi-Fi, independently and safely.

**Architecture:** Kotlin Activity + bundled WebView assets + origin-checked asynchronous bridge. Native clients own tokens/Wi-Fi/network selection; JS sees typed data and submits bounded intent only. Diagnostic assets allow transport testing before product UI polish.

**Tech Stack:** JDK 17, AGP 9.4.0, Gradle wrapper 9.6.0, AGP built-in Kotlin, compile/target SDK 36, min SDK 29, AndroidX WebKit 1.17.1; JVM tests plus Android instrumentation.

**Spec:** [Android companion specification](../specs/2026-10-14-phone-monitor-design.md#android-companion-specification), [PRD](../../PRD.md), [main plan](2026-10-14-phone-monitor.md).

## Global Constraints

- Product baseline: Redmi 9A on Android API 29 or later; current stable WebView with `WEB_MESSAGE_LISTENER`; Linux Ubuntu/GNOME laptop.
- ESP address is `192.168.4.1`; existing HTTP endpoints only; no sibling firmware edits/flashing.
- ESP traffic binds individual connections to selected Wi-Fi; never call `bindProcessToNetwork`.
- Hub binds only `127.0.0.1:8765`; paired bearer auth; no remote bind option; no credentials in WebView, query strings, shell arguments, or logs.
- Bundled UI origin is `https://appassets.androidplatform.net`; exact origin/main-frame bridge enforcement; no remote assets or data HTML.
- Laptop snapshot poll 2 seconds; ESP state poll 3 seconds; history refresh 30 seconds while open; no overlapping requests of the same operation.
- Light intents: explicit power values, brightness/speed 1–100, mode 0–8, timer 0–720 minutes; 150-ms coalescing; ≤4 dispatched writes/second; no automatic timer replay.
- Files with secrets are private; configuration install/uninstall preserves unrelated edits; use only the user's existing Git identity and no attribution lines.
- Distinguish software-verified from device-accepted; final project and PRD review uses `gpt-6-astra` at `high`.
- Other project-wide requirements in the main plan remain binding.

## Review Focus

1. No-internet Wi-Fi must not affect USB: A2/A3 factory-seam tests and real dual-link test.
2. Non-app origins, subframes, redirects, malformed/oversized messages, and incompatible WebView must fail closed: A1 tests.
3. Permission/approval dialogs versus true background/process death must not cancel the wrong session or leak requests: A1/A3 lifecycle tests.
4. Timeout plus late response must not reorder desired state or replay timers: A3 control-queue tests.
5. Phone clock skew and USB authorization/pairing failures must yield correct stale state with no token leak: A2 tests.

## Task 1: Packaged WebView and restricted bridge

**Agent:** Astra high; a separate Astra-high reviewer for the trust/lifecycle boundary.

**Files:**
- Create: `android/settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, wrapper and version catalog, `android/app/build.gradle.kts`, `AndroidManifest.xml`.
- Create: `android/app/src/main/java/com/phonemonitor/MainActivity.kt`, `DashboardBridge.kt`, `BridgeRouter.kt`, `SessionLifecycle.kt`.
- Create: `android/app/src/main/res/xml/network_security_config.xml`, `android/diagnostic/index.html`, `scripts/build.mjs`.
- Test: `android/app/src/test/java/com/phonemonitor/BridgeRouterTest.kt`, `SessionLifecycleTest.kt`; `android/app/src/androidTest/java/com/phonemonitor/DashboardSecurityTest.kt`.

**Interfaces:**
- Consumes: D1 protocol/fixture files and every exact app-operation schema, including SetupResult/AppStatus/EspSnapshot. Inject BridgeServices, clock, and lifecycle controller into a pure router for JVM tests.
- Produces: `BridgeRouter.handle(requestJson:String,sourceOrigin:String,isMainFrame:Boolean): BridgeReply`; `DashboardBridge.attach(webView)/dispose()`; `SessionLifecycle.enterForeground()/leaveForeground(reason)/close()`; native setup/capability messages; diagnostic APK build.
- Android package ID: `com.phonemonitor`; Activity: `.MainActivity`; bundled origin and entry URL exactly match the design.

- [ ] **Step 1: Provision and pin a reproducible Android build.** Put JDK 17 and Android command-line SDK/platform 36/build-tools 36.0.0 into user-owned paths; confirm javac exists. Use verified official downloads/checksums. Generate Gradle 9.6.0 wrapper with distribution checksum, pin AGP 9.4.0/WebKit 1.17.1, use AGP built-in Kotlin rather than a conflicting separate Android Kotlin plugin. Configure min 29/compile 36/target 36 and synthetic shared test resources. Do not replace system Java 8.

```kotlin
plugins { id("com.android.application") version "9.4.0" }
android { namespace = "com.phonemonitor"; compileSdk = 36
  defaultConfig { applicationId = "com.phonemonitor"; minSdk = 29; targetSdk = 36 }
}
dependencies { implementation("androidx.webkit:webkit:1.17.1") }
```

Use a diagnostic build switch `-PdiagnosticUi=true` to package `android/diagnostic`; normal production build requires the real dashboard bundle and fails if absent. Do not silently package diagnostic data into the finished APK.

- [ ] **Step 2: Write failing pure router/lifecycle tests.** Reject wrong origin/subframe/version/op/args, >16 KiB message, arbitrary URL/shell operation, duplicate live request ID, nonfinite values, and credentials returned by a service. Setup acknowledgment returns within one second; a 30-second code entry/system approval causes no request timeout; duplicate same-flow tap returns started:false with the same setupId; a competing flow is SETUP_BUSY; cancellation/expiry produce exact AppStatus states. Renderer teardown rejects view requests but retains Activity-owned setup/paired state; true Activity/session end cancels unfinished setup. A paused approval UI does not end the network session.

```kotlin
@Test fun deniesSubframeAtTrustedOrigin() {
    val reply = router.handle("""{"v":1,"id":"x","op":"hub.snapshot","args":{}}""",
        "https://appassets.androidplatform.net", false)
    assertFalse(reply.ok)
    assertEquals(0, fakeServices.hubRequests)
}
@Test fun rendererCloseCancelsAllPendingCallbacks() {
    lifecycle.enterForeground()
    lifecycle.registerPending("x", fakeCallback)
    lifecycle.close()
    assertEquals("SESSION_ENDED", fakeCallback.lastError)
    assertEquals(0, lifecycle.pendingCount)
}
```

`registerPending`, `pendingCount`, and fake service/callback types are declared in this task's pure lifecycle seam; their behavior must match production, not merely tests.

- [ ] **Step 3: Verify those tests fail.** `./android/gradlew -p android :app:testDebugUnitTest`. An absent JDK/SDK is a provisioning failure to resolve, not a meaningful red test.
- [ ] **Step 4: Implement trusted asset hosting and narrow bridge.** `WebViewAssetLoader` serves only bundled assets; native clients do I/O, JS cannot fetch remote data. Register `phoneMonitor` for the exact origin, check main frame/origin/strict schema on each call, and reply with JSON message data. Feature absence displays native update guidance. Reject navigation/subresource requests outside the local asset path; disable file/content/mixed content, popup/download paths and frame usage. Add CSP from the design and no unrestricted fallback.

```kotlin
WebViewCompat.addWebMessageListener(webView, "phoneMonitor",
    setOf("https://appassets.androidplatform.net")) { _, message, origin, mainFrame, replyProxy ->
    bridge.dispatch(message.data, origin.toString(), mainFrame) { reply ->
        replyProxy.postMessage(reply.toJson())
    }
}
```

`dispatch` validates synchronously, executes bounded typed service work off-main, and posts replies on-main. App setup actions acknowledge with SetupResult immediately, then native completion/cancellation is observed through exact AppStatus. One Activity-owned flow exists; renderer view jobs/reply callbacks are a separate scope and recreating the view does not start another flow or erase pairing. Implement renderer-crash recreation, exact view/Activity teardown, landscape/portrait, foreground screen-on and app-only brightness. Keep Android backup disabled and log only safe error codes.

- [ ] **Step 5: Add actual WebView instrumentation checks.** Trusted main-frame message succeeds; subframe/wrong origin never reaches services; hostile notification text cannot create DOM scripts/links; navigation to remote/file/data URL is blocked; diagnostic loads without network; unsupported feature shows native guidance. Run unit tests/lint/diagnostic APK build; run instrumentation only on an authorized device/emulator and mark it unrun if none is available.
- [ ] **Step 6: Review and commit.** Report exact toolchain/WebView assumptions and software versus device evidence. Commit `feat: add trusted Android dashboard host` after independent Astra review.

## Task 2: USB hub client and reconnection

**Agent:** Astra high; fresh Sol-high review, escalating security/handshake ambiguity to Astra high.

**Files:**
- Create: `android/app/src/main/java/com/phonemonitor/LaptopClient.kt`, `PairingStore.kt`.
- Modify: `MainActivity.kt`, `BridgeRouter.kt`, `SessionLifecycle.kt`, `network_security_config.xml`, diagnostic UI.
- Test: `android/app/src/test/java/com/phonemonitor/LaptopClientTest.kt`; extend `BridgeRouterTest.kt`, instrumentation; `docs/DEVICE_ACCEPTANCE.md` transport rows.

**Interfaces:**
- Consumes: D1 pairing/snapshot routes, D3 selected-device ADB connection, A1 services/router/lifecycle.
- Produces: `LaptopClient.snapshot(): LinkSnapshot<HubSnapshot>`, `.pair(code:String): PairResult`, `.close()`; `PairingStore.getToken()/setToken()/clearToken()` accessible only to native code. Clock seam provides epoch and monotonic values.
- Production URL fixed to `http://127.0.0.1:8765`; internal test transport can use synthetic local responses without adding arbitrary URL bridge arguments.

- [ ] **Step 1: Write failing HTTP/private-token/recovery tests.** Pair once, persist privately, attach Bearer only to hub requests; never include token in reply/log/request URL; wrong token yields auth-required without endless retry. Code entry after 30 seconds completes the native setup state without a bridge timeout; expired code fails cleanly. Timeout preserves the exact last payload and its original monotonic receipt; returned age increases through repeated failures and renderer recreation. Six seconds makes link stale; backoff caps at 15 seconds; one request in flight; phone wall-clock jumps don't change age/countdown. Empty cache has null age/data and cannot create a fake laptop-time baseline.

```kotlin
@Test fun keepsTokenOutsideJavascriptAndUrls() {
    client.pair("01234567")
    val snapshot = client.snapshot()
    assertEquals("Bearer test-native-token", transport.lastHeaders["Authorization"])
    assertFalse(snapshot.toJson().contains("test-native-token"))
    assertFalse(transport.lastUrl.contains("token"))
}
@Test fun wallClockJumpDoesNotMakeOldSnapshotFresh() {
    client.snapshot()
    clock.advanceMonotonic(7000)
    clock.shiftWall(-60000)
    transport.failNext()
    assertTrue(client.snapshot().stale)
}
```

- [ ] **Step 2: Run targeted failures.** `./android/gradlew -p android :app:testDebugUnitTest --tests '*LaptopClientTest'` using fake transport/private store and deterministic clocks.
- [ ] **Step 3: Implement unbound loopback HTTP and native pairing dialog.** Apply 2-second connect/3-second read timeout, no redirect, 256-KiB reply budget, strict parser, private token storage, and invalid-token setup state. app.setupHub opens one native code-entry dialog and immediately returns SetupResult; internal PairResult completion updates AppStatus and only the native store receives the token. Cleartext policy permits only the fixed hub/controller IPs; base policy forbids cleartext elsewhere.

```xml
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">192.168.4.1</domain>
  </domain-config>
</network-security-config>
```

Preserve independent cached LinkSnapshot. Its ageMs is elapsed time since receipt of that exact data payload; failed bridge returns never reset the baseline. JS anchors laptop time at data.serverNowEpochMs + ageMs and then advances monotonically. Defer polling while hidden. Re-pair only on explicit setup; a transient hub restart must not erase a valid token.

- [ ] **Step 4: Wire diagnostic bridge and USB setup.** Show sanitized hub status and synthetic/real quota windows from `hub.snapshot`; run selected-device reverse command through D3 launcher; verify from the phone, not merely from laptop health. Native loopback uses an ordinary connection with no Wi-Fi socket factory or global network binding.

```kotlin
val connection = URL("http://127.0.0.1:8765/v1/snapshot").openConnection() as HttpURLConnection
connection.instanceFollowRedirects = false
connection.setRequestProperty("Authorization", "Bearer $nativeToken")
```

- [ ] **Step 5: Verify independent reconnect.** Automated tests cover 401/pair expiry, malformed/oversized responses, cancellation, stale age, and byte-safe token redaction. On Redmi: pair, unplug/replug, confirm ADB authorization handling, stop/restart hub, background/return. No available device means these rows remain explicitly unrun while software checks proceed.
- [ ] **Step 6: Review and commit.** Commit `feat: connect Android to paired desktop hub over USB` only after scoped review/checks; report whether actual Redmi USB was exercised.

## Task 3: Explicit Wi-Fi ESP32 access and controls

**Agent:** Astra high; fresh independent Astra-high reviewer for routing/lifecycle/command semantics.

**Files:**
- Create: `android/app/src/main/java/com/phonemonitor/WifiSession.kt`, `EspClient.kt`, `ControlQueue.kt`.
- Modify: `MainActivity.kt`, `DashboardBridge.kt`, `BridgeRouter.kt`, `SessionLifecycle.kt`, manifest, diagnostic UI.
- Test: `android/app/src/test/java/com/phonemonitor/EspClientTest.kt`, `ControlQueueTest.kt`, extend lifecycle/security tests.
- Document: `docs/DEVICE_ACCEPTANCE.md` Wi-Fi/routing/control/lifecycle rows, `docs/SETUP.md` native/manual Wi-Fi steps.

**Interfaces:**
- Consumes: existing controller GET API, A1 bridge lifecycle, A2 laptop independence, shared `EspState`, `EspHistory`, `LightPatch`.
- Produces: WifiSession.connect()/disconnect() and selected-Network callbacks; EspClient.state(): EspSnapshot, .history(): LinkSnapshot<EspHistory>, .set(patch:LightPatch,generation:Long): CommandResult; ControlQueue.submit(patch,generation)/acknowledge()/cancel(). Bridge esp.set args are exactly {patch,generation}; result includes kind/outcome; mixed timer/state patch is rejected. Native reconciliation updates separate latest state/timer outcomes in EspSnapshot.commands; AppStatus.nextCommandGeneration prevents reused IDs after renderer recreation, with safe-integer Long validation and stale-generation rejection.
- Native typed transport factory makes controller requests via selected `Network.openConnection(URL,Proxy.NO_PROXY)`; fake factory proves separation in JVM tests, hardware proves actual routing.

- [ ] **Step 1: Write failing routing/parser/lifecycle/intent tests.** Controller factory receives selected Wi-Fi; laptop remains unbound; onLost cancels obsolete I/O. Parse ready/ok=false, null climate/history, missing/invalid numbers, unequal lengths, >120 samples, rebooted uptime, redirect, and oversized JSON. Command tests cover rapid drag/final release/four writes per second; brightness then mode merging while an earlier write is in flight; timer then slider and slider then timer ordering; mixed timer patch rejection; queued timer cancelled by power-off; timeout then matching/mismatching state; older poll after new intent; no replay after loss/teardown; outcome via esp.state; renderer recreation reads native generation floor and cannot reuse a previous command ID. Permission tests exercise API 29, 30, 31, 32, 33, denied permission, and applicable location-services-off.

```kotlin
@Test fun timerIsNeverAutomaticallyReplayedAfterTimeout() {
    queue.submit(LightPatch(timerMinutes = 30), generation = 1)
    transport.completeWithTimeout()
    clock.advanceMonotonic(15000)
    queue.onReconnect()
    assertEquals(1, transport.timerWriteCount)
    assertEquals("COMMAND_UNCONFIRMED", queue.lastError)
}
@Test fun olderAcknowledgementCannotReplaceNewerIntent() {
    queue.submit(LightPatch(bright = 20), 1)
    queue.submit(LightPatch(bright = 80), 2)
    queue.acknowledge(generation = 1, state = stateWithBrightness(20))
    assertEquals(80, queue.desired.bright)
    assertTrue(queue.hasPendingIntent)
}
```

- [ ] **Step 2: Verify targeted failures.** `./android/gradlew -p android :app:testDebugUnitTest --tests '*EspClientTest' --tests '*ControlQueueTest' --tests '*SessionLifecycleTest'`. No test silently substitutes internet/default-network reachability for controller readiness.
- [ ] **Step 3: Implement visible native Wi-Fi setup and per-network I/O.** app.connectEsp immediately acknowledges SetupResult; one native flow stores SSID/password privately and reports typed AppStatus. Request fine location through API 32, manifest maxSdkVersion 32; NEARBY_WIFI_DEVICES from API 33 with neverForLocation. Handle required older location-services state without falling through on API 31/32. Android approves the local-only network; denial/unavailable/loss do not repeatedly prompt. Manual mode observes existing Wi-Fi. Ignore validation/internet as readiness; verify controller HTTP. Never bind the process.

```kotlin
val request = NetworkRequest.Builder()
    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
    .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    .setNetworkSpecifier(specifier).build()
val connection = selectedNetwork.openConnection(
    URL("http://192.168.4.1/api/state"), Proxy.NO_PROXY) as HttpURLConnection
connection.instanceFollowRedirects = false
```

Keep one native request during a foreground session, including its approval overlay; release on explicit disconnect or ended session. Cancel/discard old Network onLost, recreate client after callbacks, pause view polling when hidden, and recover on process recreation. Timeout 1.5-second connect/2-second read; 64-KiB response limit.

- [ ] **Step 4: Implement parser, encoded queries, and serialized intents.** Convert power/ok 0/1 and RGB bytes, preserve nulls, validate history. Only explicit allowlisted query values; no generic path/URL. Merge latest per-field ordinary values in adjacent unsent units for 150 ms, never across timer barriers; queue ≤4 unsent units plus one in flight and settle superseded callbacks. Timers are timer-only patches; reject mixed patches. Power-off cancels unsent timers. Serialize reads/writes, rate ≤4 writes/second, retain final release. Native owns reconciliation: read started after write dispatch compares only touched ordinary fields, confirms that generation on match, otherwise remains unconfirmed; update EspSnapshot.commands for UI. No automatic retry; explicit user retry is a new generation. A timer without command response remains uncertain; never replay on reconnect. Earlier polls cannot confirm later writes or erase desired intent.

```kotlin
val query = Uri.Builder().appendQueryParameter("power", if (patch.power == true) "1" else "0")
// Build only keys actually present in the validated patch; omit absent keys.
val historyOffsets = history.temperatureC.indices.map { i ->
    (i - history.temperatureC.lastIndex) * history.intervalSeconds
}
```

Include only present keys for power/hex/bright/mode/speed/timer; confirm state from response. HTTP reachability and sensorOk remain separate statuses; controls continue when sensor fails.

- [ ] **Step 5: Prove the routing checkpoint on hardware when attached.** Redmi reaches hub and ESP concurrently, SIM/mobile data on/off; app-specific approval/denial/manual fallback; wrong password; AP power cycle; default-network changes; USB unplug with ESP continuing; Wi-Fi loss with hub continuing; physical button state; all light modes/timer semantics. Verify local routing with native requests and sanitized status, not desktop network connectivity alone. Record exact model/API/MIUI/WebView and actual system prompts; no assumptions about indefinite MIUI retention.
- [ ] **Step 6: Review and commit.** Run all Android unit/lint/APK checks and available instrumentation; attach observed/unrun hardware rows. Independent Astra checks route separation, job teardown, intent-generation behavior, and timer replay. Commit `feat: add independent Wi-Fi climate and light controls` after fixes.

**Android subproject exit gate:** buildable diagnostic companion, trusted bridge tests pass, native transports are independently testable, token/routing semantics checked, and the physical dual-link result is explicitly recorded as passed or unrun. The latter must pass before claiming a device-accepted release.
