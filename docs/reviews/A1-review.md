# Spec compliance: issues found

- **Spec verdict: needs fixes.** The packaged host, narrow protocol bridge, safe unavailable A1 service seams, setup acknowledgment model, and reproducible build are implemented. Three lifecycle boundary defects below prevent approving the A1 trust/lifecycle gate.
- **Scope:** reviewed the supplied full `03847a332284d6f574b5de3029f04ac486f2a50d..4a88b40ba278086620ca66a457783bf96b5e275a` package once in consecutive sections; all 29 listed changed paths are represented. No changed source file was separately reread; a small diff parser subsequently extracted exact finding line numbers. No Git operation, source edit, suite rerun, subagent, hardware access, or transport implementation was performed. This report is the only written artifact.
- **Cannot verify from this diff:** actual WebView origin enforcement, crash recovery, MIUI approval behavior, orientation/insets, device startup/soak, and dual USB/Wi-Fi routing. Instrumentation was compiled, not executed. A2/A3 own real native credentials and transports; their absence is not an A1 finding.

## Strengths

- `android/app/src/main/java/com/phonemonitor/BridgeRouter.kt:38` rejects the wrong origin/frame, oversized input, unknown schema fields, duplicate live IDs/operations, and invalid operations before services; response validation at line 75 prevents open-ended credential-bearing objects from reaching JS.
- `android/app/src/main/java/com/phonemonitor/ProtocolValidator.kt:17` rejects duplicate JSON keys, excessive nesting and nonfinite numbers. The focused **Kotlin/TypeScript contract-drift check** compared this validator with `packages/protocol/src/schema.ts`: operation arguments, response shapes/refinements, error enumeration, safe-integer limits, uppercase normalized ESP colour, timer-only patches, and setup states agree materially with the reviewed D1 contract.
- `android/app/src/main/java/com/phonemonitor/MainActivity.kt:100` and `AssetPolicy.kt:4` combine local-path interception, restrictive CSP, denied navigation/permissions, and exact-origin web messages. `DashboardBridge.kt:23` feature-checks the listener without an unrestricted fallback.
- `android/app/src/main/java/com/phonemonitor/SessionLifecycle.kt:28` correctly separates setup acknowledgment from human interaction, returns the same active setup ID, prevents competing flows, and preserves pairing across renderer teardown. Generation reservation at line 69 avoids reuse and overflow.
- `android/app/build.gradle.kts:24` explicitly fails absent dashboard assets; diagnostic packaging is opt-in. Backup exclusion, private-native service seams, and production/diagnostic separation fit the task.

## Important findings

### A1-R1 — Active setup is not proof that an Activity stop is an approval pause

**Location:** `android/app/src/main/java/com/phonemonitor/MainActivity.kt:151`; `SessionLifecycle.kt:105`.

Every stop with an active setup and no `onUserLeaveHint` is classified as `approval_pause`. Android explicitly documents an unrelated incoming-call Activity as a background transition that does **not** invoke that hint ([Activity API](https://developer.android.com/reference/android/app/Activity#onUserLeaveHint())). Thus, starting hub/ESP setup and then receiving such a full-screen interruption leaves native foreground state, callbacks, and subsequently owned network work active even though the app is truly stopped. `SessionLifecycle.leaveForeground` returns immediately for this inferred reason. The existing test only supplies the desired reason string directly, so it does not test the incorrect Activity classification.

Track a specific outstanding OS approval/permission interaction separately from generic setup progress, and make genuine background transitions cancel view work and release the native session resources. Add a focused regression for active setup plus a non-approval stop without a leave hint, alongside the real approval-pause case. Keep device verification explicitly pending.

### A1-R2 — Renderer recreation while stopped reopens the request boundary

**Location:** `android/app/src/main/java/com/phonemonitor/SessionLifecycle.kt:96`; `MainActivity.kt:111`, `MainActivity.kt:79`.

`onRenderProcessGone` always schedules `createDashboard`, including after `onStop`. Creation is guarded only against finishing/destroyed Activities. The replacement scope initializes `acceptsRequests=true`; skipping `enterForeground()` when `activityStarted` is false does not close that gate. A renderer killed while the Activity is stopped therefore gets a fresh loaded bridge that accepts service work while the native session is backgrounded, undoing the earlier cancellation. The replacement WebView also has not received the earlier view's `onPause()`.

Initialize renderer scopes inactive and enable them only through the actual foreground lifecycle, and defer crash recreation until `onStart` (or explicitly keep the replacement paused and request-ineligible). Test stop → renderer replacement → request rejection → start → request acceptance. Normal foreground crash recovery must still preserve Activity-owned setup/pairing.

### A1-R3 — A queued successful reply escapes the lifecycle epoch check

**Location:** `android/app/src/main/java/com/phonemonitor/DashboardBridge.kt:67`, `DashboardBridge.kt:49`.

The worker marks a task settled and removes its lifecycle callback before posting delivery onto the main queue. If `onStop`/scope close runs after the worker's final epoch check but before that runnable executes, there is no pending callback left to cancel, and the runnable unconditionally delivers the old successful result. A background/return on the same view can therefore receive a success from the previous epoch. The added `backgroundReturnCannotMakeAnOldReplyCurrentAgain` test covers backgrounding during service execution, but not this delivery interval.

Recheck the request's scope/epoch on the main thread at delivery, or retain cancellable ownership until main-thread delivery is committed. Ensure one terminal reply and return `SESSION_ENDED` for an invalidated request. Add a deterministic scheduler/dispatcher regression that queues a successful result, invalidates the lifecycle, then drains the delivery queue.

## Minor findings and warning dispositions

- **A1-R4 — Default orientation differs from the PRD:** `android/app/src/main/AndroidManifest.xml:7` selects `fullSensor`. It supports portrait and landscape, but does not establish the PRD's landscape default on a portrait-held phone. Implement a landscape-default policy that retains the requested portrait support, or have the coordinator record an explicit product ruling before claiming this requirement met. This is a startup presentation issue, not a security blocker.
- **A1-R5 — Seven lint warnings remain visible:** inspected `android/app/build/reports/lint-results-debug.txt` independently. Five are version notices: target SDK at `android/app/build.gradle.kts:11`, compile SDK at line 6, Gradle at `android/gradle/wrapper/gradle-wrapper.properties:3`, AGP at `android/gradle/libs.versions.toml:2`, and Gson at line 4. SDK/Gradle/AGP match the explicit task pins; no upgrade is required merely to quiet these notices. Gson's newer-version notice alone establishes no correctness/security defect. The orientation notice at `AndroidManifest.xml:7` concerns future large-screen behavior; it does not prove a Redmi failure and is separate from R4. Finally, `MissingOnRenderProcessGone` at `MainActivity.kt:99` is a verified false positive for the claim that the method is missing: the explicit override at line 110 and independently run `javap -p -c` show the correct public signature, teardown/recreation call, and unconditional true return. This does **not** prove crash recovery works on a device or negate R2. Preserve these precise dispositions in the tracked checkpoint; any suppression should be narrow and justified, not global.

## Evidence checked

- Read task brief/report, binding PRD/design/Android plan, and current HANDOFF/STATUS/PROGRESS; did not treat the checkpoint as test proof.
- Existing XML results show **11 JVM tests, zero failures/errors**: BridgeRouterTest 6, SessionLifecycleTest 4, AssetPolicyTest 1. Existing final diagnostic log ends `BUILD SUCCESSFUL`, 84 tasks; production script log ends `BUILD SUCCESSFUL`, 52 tasks. These substantiate reported execution; no suite was rerun.
- Existing lint report shows **0 errors, 7 warnings**, independently classified above.
- Named focused outside-diff checks: shared `schema.ts` for manual contract drift; generated lint/test/build evidence for the reported validation and warning claims; compiled `MainActivity$DashboardClient.class` disassembly for the claimed render-handler false positive; official Android Activity documentation for the leave-hint classification risk. No broader source crawl.
- Proposed regression cases in R1–R3 were **not executed** during this read-only review. Current tests do not cover those specific transition/delivery schedules.

**Task quality: needs fixes.** The trust restrictions and schema discipline are strong, and the unavailable transport seams are appropriately scoped. Foreground ownership and callback delivery must be corrected before A1 is approved; device acceptance and the final project review remain separate gates.
