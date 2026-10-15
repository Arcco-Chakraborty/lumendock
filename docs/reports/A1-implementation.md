# A1 — Packaged WebView and restricted bridge

Status: implementation ready for independent Astra/high review; no commit made. Physical/device acceptance is unrun. A2/A3 transport and real native credential/permission flows remain separate planned work.

Execution root: `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor` (managed detached HEAD). Worker edited only `android/**`, `scripts/build.mjs`, and this scoped report. Coordinator owns HANDOFF/STATUS/PROGRESS and commits. No firmware, default system tools, provider auth/private captures, accounts, device permissions, or external publishing were touched.

## What is implemented

- Reproducible Android application scaffold: package `com.phonemonitor`, Activity `.MainActivity`, min 29/compile 36/target 36/build-tools 36.0.0; AGP 9.4.0 built-in Kotlin, Gradle 9.6.0 checksummed wrapper, WebKit 1.17.1. Version catalog additionally pins Gson 2.13.2, JUnit 4.13.2, AndroidX test runner/core 1.7.0 and ext.junit 1.3.0.
- Real dashboard assets are sourced from `dashboard/dist`. `-PdiagnosticUi=true` explicitly selects the separate, labelled `android/diagnostic` shell. Missing production assets fail explicitly. `scripts/build.mjs [--diagnostic]` selects the local manifest or explicit JAVA_HOME/ANDROID_HOME, builds the dashboard for production, then unit-tests/lints/builds Android.
- `WebViewAssetLoader` serves `/assets/` at exactly `https://appassets.androidplatform.net`; entry is `/assets/index.html`. URL policy rejects other schemes/authorities/ports/paths, queries, encoded paths, and traversal. Header CSP matches the design and adds form/frame-ancestor restrictions. Remote navigation/subresources, subframe navigation, file/content access, mixed content, windows, downloads, geolocation, web permission/file requests, and cookies are denied. Release/debug WebView inspection is disabled. No unrestricted JS interface exists.
- `phoneMonitor.postMessage` / `phoneMonitor.onmessage`: exact-origin listener with main-frame validation, strict JSON/string handling, version/operation/argument allowlists and a 16-KiB request limit. Duplicate keys, deep JSON, trailing data, invalid numbers/types, unknown keys/ops, arbitrary URLs/shell operations, and duplicate live IDs/operations are rejected.
- `ProtocolValidator` mirrors operation-specific D1 schemas, validates shared fixtures in JVM tests, and rejects credential/unknown fields anywhere in service results. It consumes the reviewed `QUEUE_FULL` error and uppercase normalized ESP state hex; input patches still accept either hex case. All errors are fixed codes with no exception messages or credentials. The brief's old `SESSION_CLOSED` example was corrected by the coordinator: implementation uses protocol `SESSION_ENDED` everywhere.
- `BridgeRouter` validates/reserves synchronously; `DashboardBridge` uses a bounded two-worker executor, bounded callback set, ten-second request deadlines, and main-thread JSON replies. Local app/status/setup acknowledgment operations cannot queue behind network I/O. Setup completion is queried through exact AppStatus rather than holding a bridge request during human entry/OS approval.
- `NativeSession` is Activity-owned; one native setup flow exists at a time. Repeated taps return the same setupId/started:false; competing setup returns SETUP_BUSY; cancellation/expiry are typed. Setup expiry uses a monotonic clock. Renderer scopes reject callbacks without erasing pairing or cancelling native setup; true background/end cancels unfinished setup. Approval pause preserves the native session. Request epoch checks reject stale completions after background/return. Command-generation reservation persists across renderer recreation and handles the entire JS-safe integer range without overflow/reuse.
- Renderer crash handling disposes the old bridge/WebView and creates a fresh view with the same NativeSession. Screen-on and brightness apply only to the foreground app window. Both landscape and portrait are supported via sensor orientation/configuration handling. Android backup is disabled; API31+ cloud/device-transfer rules explicitly exclude every storage domain.

## Extension interfaces for A2/A3

`BridgeServices` provides concrete operations: `hubSnapshot()`, `espState()`, `espHistory()`, `setLight(patch:JsonObject,generation:Long)`, and `openWifiSettings()`. Every JsonObject result must pass the operation-specific validator before JS sees it. Transport methods must remain bounded and cancellation-aware and must throw `BridgeFailure` with protocol safe codes for known failures.

`NativeSession` injects monotonic clock, `onStartSetup(kind,id)`, `onCancelSetup(kind,id)`, `onBackground`, and screen-change callbacks. UI callbacks must post promptly, not block for interaction. `finishSetup(kind,id,state,errorCode)` ignores stale IDs and preserves prior successful pairing on later failure/cancellation. `SessionLifecycle` owns renderer callbacks; `close()` does not close its NativeSession. `NativeSession.close()` is the Activity/session teardown boundary. Bridge dispatch must stay the only production route to the typed services; arbitrary request objects are not a supported public input.

Current `UnavailableBridgeServices` deliberately returns disconnected/no-data states. A1 native setup dialogs clearly say transport setup is not installed and finish as cancelled. These are A1 integration seams, not finished pairing/Wi-Fi implementation. A2/A3 replace them with real clients, native credential UI, network ownership/cancellation, and private persistence. NativeSession has no credential fields and the UI never receives credentials. Manual Wi-Fi settings opens natively with an actual opened boolean.

## Test-first evidence

User-local tool selection for every Gradle command:

```sh
JAVA_HOME=/home/arcco-chakraborty/.local/share/phone-monitor/toolchains/jdk17 \
ANDROID_HOME=/home/arcco-chakraborty/.local/share/phone-monitor/toolchains/android-sdk \
./android/gradlew -p android ...
```

- `javac -version`: `17.0.20.1`. System Java/default Node unchanged.
- Generated wrapper with user-local Gradle 9.6.0; downloaded official distribution SHA256 `bbaeb2fef8710818cf0e261201dab964c572f92b942812df0c3620d62a529a01` and added `distributionSha256Sum`. Wrapper JAR SHA256: `497c8c2a7e5031f6aa847f88104aa80a93532ec32ee17bdb8d1d2f67a194a9c7`.
- RED: `:app:testDebugUnitTest` against compiling router/lifecycle/asset stubs: 9 tests, 7 failed. Failures were missing asset acceptance, service execution/valid responses, setup acknowledgment and lifecycle state/callback behavior. One missing setup result also produced a null dereference, recorded rather than counted as a semantic assertion. Log: `/tmp/phone-monitor-a1-red.log`.
- GREEN after implementation: all original 9 tests passed. Log: `/tmp/phone-monitor-a1-green.log`.
- Additional RED: 11 tests, 2 failed—`backgroundReturnCannotMakeAnOldReplyCurrentAgain` and `generationUsesEntireSafeIntegerRangeWithoutOverflowOrReuse`. Log: `/tmp/phone-monitor-a1-edge-red.log`.
- GREEN after epoch and terminal-generation fixes: all 11 JVM tests passed (BridgeRouterTest 6, SessionLifecycleTest 4, AssetPolicyTest 1). No JVM tests need a device, account or network.
- Full diagnostic command: `:app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest -PdiagnosticUi=true`. The last verification log is `/tmp/phone-monitor-a1-final-verified.log`; see final results below.
- `node scripts/build.mjs --diagnostic` using the pinned local Node binary passed; log `/tmp/phone-monitor-a1-script.log`.
- Production-missing-assets test used only copied Gradle config in an isolated `/tmp/phone-monitor-a1-missing-assets-*` directory, without moving/deleting the dashboard worker's files. `:app:verifyDashboardAssets` exited 1 with `Dashboard bundle missing: build dashboard/dist first, or explicitly use -PdiagnosticUi=true for a diagnostic APK.` Log: `/tmp/phone-monitor-a1-missing-assets.log`.
- Root `npm test` using local Node24 passed at the concurrent-work checkpoint: protocol 15, desktop 46, dashboard 20 = 81 tests, 11 files. Log `/tmp/phone-monitor-a1-workspace-tests.log`. This is a shared-tree snapshot; later D2/W2 edits require their own verification.
- `git diff --check` passed for the current tracked tree. Android is not yet staged/committed.

## Instrumentation and device limits

Two real-WebView instrumentation classes compile into the instrumentation APK:

- `DashboardSecurityTest`: diagnostic assets/main-frame messages, diagnostic reply rendering of hostile synthetic text, navigation/subframe denial, native unsupported-WebView guidance. Run this class against `-PdiagnosticUi=true`; its diagnostic text check intentionally exercises the diagnostic handler. Real production notification rendering belongs to dashboard tests/integration.
- `BridgeOriginInstrumentationTest`: actual listener works in a trusted main frame; a same-origin subframe is rejected without reaching services; wrong-origin pages have no bridge; nonstring/ArrayBuffer input cannot cause service access. Test-only intercepted pages exercise listener attribution separately from production CSP frame denial and make no real external requests.

Instrumentation was NOT RUN: no device/emulator was authorized for this task, and the user deferred physical acceptance. Thus actual WebView behavior, unsupported provider behavior, crash recovery, system approval/MIUI lifecycle behavior, orientation/window insets, real Redmi startup/soak, simultaneous USB/Wi-Fi, ESP/light effects, installation and permissions remain unverified. An APK build or passing JVM tests proves none of these.

## Remaining review concerns

- Kotlin response schemas mirror TypeScript manually. Fixtures currently match; any later protocol changes must update/test this validator rather than silently accept new shapes.
- Lint succeeds with zero errors. Remaining warnings concern deliberately pinned SDK/AGP/Gradle/Gson versions, sensor orientation's future large-screen behavior, and `MissingOnRenderProcessGone` on the named WebViewClient. The last warning is contradicted by both the explicit override returning true and `javap` output confirming `public boolean onRenderProcessGone(android.webkit.WebView, android.webkit.RenderProcessGoneDetail)` in the compiled class. It is retained visibly rather than silently suppressed; runtime crash recovery is still device-unrun.
- The app's default is landscape-oriented dashboard layout, but actual portrait/landscape follows physical sensor rotation. No global orientation/system brightness policy is changed.
- Full A1 review and coordinator integration are pending. No software/device/final-project completion gate is asserted here.

Official references checked: AGP 9.4.0 compatibility (`https://developer.android.com/build/releases/agp-9-4-0-release-notes`), Android backup/extraction domains (`https://developer.android.com/identity/data/autobackup`), Gradle distribution checksum (`https://services.gradle.org/distributions/gradle-9.6.0-bin.zip.sha256`).

## Final verification/artifacts

- Final diagnostic verification succeeded: 84 Gradle tasks, 20 seconds; 11 JVM tests, zero failures/errors; lint zero errors; debug and instrumentation APKs built. `:app:assembleDebugAndroidTest` compiles both instrumentation classes; it does not run them.
- Production `:app:assembleDebug` also succeeded, then **both** `node scripts/build.mjs --diagnostic` and `node scripts/build.mjs` succeeded. Production script log: `/tmp/phone-monitor-a1-production-script.log`.
- ZIP inspection verified diagnostic APK contains only labelled diagnostic HTML/JS/CSS. Production ZIP inspection verified every asset byte equals the current `dashboard/dist` counterpart and no diagnostic asset/text is packaged. Production JS+CSS size is recorded below; this is the current shared-tree dashboard snapshot, not a W2 completion claim.
- Diagnostic APK preserved separately at `android/app/build/outputs/apk/diagnostic/app-debug-diagnostic.apk`: 4,051,059 bytes; SHA256 `58c6e2a59c4d0548be7500a49f350f9427310898882905a5e2f7e3ebb6322c74`.
- Instrumentation APK: `android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`: 2,248,906 bytes; SHA256 `e9063a91b3e1eb607cc370de26987e4eeba2f9c0dbe5b0aebc130700790697cf`.

- Production APK: `android/app/build/outputs/apk/debug/app-debug.apk`: 4,166,705 bytes; SHA256 `de8a44fb7758b935dee05f1be25bf21b15d7dffa3d9e3e2c3453a4c43df26d85`. Packaged production JS/CSS: 333,067 bytes. Both APKs are below 20 MiB; production JS/CSS is below 750 KiB. Device startup/PSS/soak remain unrun.

Ready for independent A1 review and serialized coordinator commit. No known build blocker; no commit or full-project/device acceptance claim.

## Serialized checkpoint commit

Coordinator granted an A1-only checkpoint commit before fresh review. Committed exactly 28 Android source/configuration/wrapper/test files plus the build script (29 total changed paths) as `4a88b40ba278086620ca66a457783bf96b5e275a` — `feat: add trusted Android dashboard host`, parent `03847a332284d6f574b5de3029f04ac486f2a50d`. No coordinator records, dashboard, desktop, ignored build output, local.properties, or private material were staged. Existing user Git identity was used, with no extra attribution.

The generated Windows wrapper uses standard CRLF. Default `git diff --cached --check` reported each CR as whitespace; `git -c core.whitespace=cr-at-eol diff --cached --check` passed without rewriting the generated wrapper or changing Git configuration. Fresh Astra/high review remains pending; this is a checkpoint, not a reviewed/final completion assertion. Unchanged tests were not rerun for this commit-only step.
