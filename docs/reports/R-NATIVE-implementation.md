# R-NATIVE implementation report — READY

Date: 2026-10-15. Canonical execution root `~/.codex/worktrees/phone-monitor-build/Phone_monitor`; baseline `87bd88d`. Exclusive product edits under `android/**`; no staging, commits, pushes, subagents, phone installs/actions, global settings changes, or other owners' edits. Coordinator owns checkpoint and acceptance. Final palette instruction applied: window/root/WebView background **#191a18**.

## Change

- `MainActivity.kt`: delegates display policy to Activity-owned `DashboardWindow`; onResume/onPause/window-focus/configuration callbacks affect display policy only. Removes custom orientation listener and hold-to-unlock logic. Root and WebView fit the display; native cutout padding keeps controls safe. Window/root/WebView have the same ink background.
- `DashboardWindow.kt` (new): API29 immersive-sticky layout/hide flags; API30+ platform WindowInsetsController with transient system bars by swipe. Explicit edge-to-edge on API30–34, already enforced for target SDK on API35+. No dependency changes. Reapply only while resumed/focused, without visible native setup dialog or visible IME; one posted restoration after IME dismissal, removed on pause/close. No polling or inset-driven hide loop. API29 retains adjustResize; newer APIs apply explicit IME bottom padding. Cutout padding is recomputed, never accumulated; keyboard and cutout bottom use max, not sum. Insets remain unconsumed for platform/WebView handling.
- `DashboardWindowPolicy.kt` (new): small pure state/inset policy used by actual window controller and JVM regression tests.
- Manifest uses normal `sensor` portrait/landscape rotation; configChanges preserved. `OrientationPolicy.kt` and five obsolete unlock-policy tests removed. Manifest regression expectation updated to new approved rotation policy.
- Native secure pairing/Wi-Fi dialogs, renderer bridge/security, caches, transport routing, NativeSession/SessionLifecycle approval ownership, background cancellation, brightness and screen-on behavior unchanged.

## Tests and actual evidence

Test-first red: added `DashboardWindowPolicyTest` and changed manifest rotation expectation. Ran focused Gradle JVM command against an inert policy scaffold/current manifest: **5 tests, 3 expected failures** (cutout padding, resumed/focused/dialog/IME eligibility, old sensorLandscape setting). No compile errors. Implemented behavior, then full Android checks passed.

Final command (user-local JDK17/SDK36/Gradle9.6 selected explicitly; system defaults unchanged):

```sh
JAVA_HOME=~/.local/share/phone-monitor/toolchains/jdk17 \
ANDROID_HOME=~/.local/share/phone-monitor/toolchains/android-sdk \
ANDROID_SDK_ROOT=~/.local/share/phone-monitor/toolchains/android-sdk \
PATH=~/.local/share/phone-monitor/toolchains/jdk17/bin:~/.local/share/phone-monitor/toolchains/gradle-9.6.0/bin:$PATH \
./android/gradlew -p android --offline :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest
```

Final result: **BUILD SUCCESSFUL**, 13 seconds, 84 tasks. Full Android JVM suite **113 tests, zero failures/errors** (116 previous minus 5 obsolete gesture tests plus 2 new window-policy tests). Lint **0 errors / 7 warnings**. Warning categories are existing target/version recommendations, existing render-process-handler false positive, and orientation compatibility guidance; no new lint category. Final compile emitted no Kotlin warnings. `git diff --check -- android` passed.

Artifacts at final check:
- `android/app/build/outputs/apk/debug/app-debug.apk`: **4,376,333 bytes**.
- `android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`: **2,283,634 bytes**.
- Raw sanitized build output: `.superpowers/redesign/native-final-checks.log` (ignored).

Production APK uses dashboard/dist present at this native check. Coordinator must rebuild after UI owner final bundle, then package that integrated APK. No claim this intermediate APK is final UI packaging.

## Targeted instrumentation (compiled, NOT RUN)

New `DashboardWindowInstrumentationTest` has five scenarios:
1. Full window bounds/cutout-safe WebView on cold start, then CREATED→RESUMED recovery.
2. Landscape/portrait rotation updates dimensions and preserves exact renderer identity.
3. Synthetic cutout/IME delivery replaces old padding edges; API29 does not double-pad an already-resized keyboard.
4. Actual HTML input + software keyboard reduces WebView height, keeps field visible, and restores height/fullscreen on dismissal.
5. Actual native pairing dialog remains secure, focusable, accepts text focus, and cancels back to fullscreen without entering/sending credentials.

After coordinator-authorized install of both APKs, select the already-authorized device without logging its serial. Exact runner (the shell variable is intentionally a placeholder, not a stored serial):

```sh
adb -s "$selected_device" shell am instrument -w \
  -e class com.phonemonitor.DashboardWindowInstrumentationTest \
  com.phonemonitor.test/androidx.test.runner.AndroidJUnitRunner
```

Run this class only for this task. Older instrumentation has diagnostic-UI assumptions and is not silently certified for the production dashboard.

Side effects/risk disclosure: ActivityScenario launches the **real MainActivity**, so normal startup reads its own private pairing/Wi-Fi configuration and resumes ordinary hub/ESP connections. No test reads/prints tokens/passwords, enters a pairing code, sends light commands, mutates app preferences, resets app data, or changes global rotation/settings. The foreground-return scenario triggers normal stop teardown and resume/reconnect. Rotation uses Activity.requestedOrientation within that scenario. Each scenario closes its Activity; coordinator should relaunch the dashboard after tests. Pairing test starts a native setup flow then presses Cancel, with no HTTP pairing submission. Synthetic keyboard HTML exists only in the test renderer and is removed.

## Limits / acceptance gate

**Software verified for this native scope; physical acceptance unrun.** API29 immersive flags and OEM WebView/IME resize interactions remain the key risk: the real-keyboard instrumentation deliberately requires a reduced usable WebView height and restoration, not merely matching flags. Do not waive this test based on synthetic insets/JVM success. Real Redmi cutout geometry, native Wi-Fi dialog keyboard access, transient navigation gestures, Home/return, and simultaneous USB+Wi-Fi continuity still require coordinator device acceptance. API30+ behavior is compiled and structurally covered, not runtime-tested here.

Ready for serialized native checkpoint and fresh independent Astra-high task review. No device install performed.
