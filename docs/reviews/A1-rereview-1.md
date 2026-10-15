- **A1-R1 — Active setup is not proof of an approval pause — ADDRESSED.** `android/app/src/main/java/com/phonemonitor/SessionLifecycle.kt:56` records approval ownership only for the matching live setup; `:66` classifies an ordinary stop as background, and completion/expiry/cancellation clears that ownership. `MainActivity.kt:152` uses this classification. Existing `ActivityLifecycleRegressionTest` covers active setup plus no approval/no leave hint, matching approval, and Home while approval is outstanding.
- **A1-R2 — Stopped renderer recreation reopens requests — ADDRESSED.** `SessionLifecycle.kt:119` starts request admission closed; `MainActivity.kt:80` pauses a replacement when the Activity is stopped and only foreground entry enables its scope. Existing regressions cover stopped replacement rejection followed by foreground acceptance and foreground replacement preserving setup/pairing.
- **A1-R3 — Queued replies escape epoch validation — ADDRESSED.** `android/app/src/main/java/com/phonemonitor/LifecycleReplyDelivery.kt:20` rechecks the epoch inside the main-queue delivery, converting stale results to one `SESSION_ENDED` reply. `DashboardBridge.kt:52` wires the helper into production. The three existing delivery tests cover background/return, renderer closure, and one terminal reply. A separate ownership regression introduced by delayed callback removal remains below.

## New breakage in the fix diff

- **Important A1-R6 — An old delivery can erase a newer request's cancellation callback.** `android/app/src/main/java/com/phonemonitor/LifecycleReplyDelivery.kt:21` removes the pending callback by ID alone after queueing, without checking ownership/epoch. Queue a completed request's reply, background (which clears pending callbacks), return, and register a new request with the same ID before draining the old delivery. The old delivery correctly sends `SESSION_ENDED` but also removes the new request's callback. The next background/close therefore cannot reach `RequestTask.cancel` for that new request, leaving its worker running until normal completion/deadline. Reusing an ID after its prior request/session ended is not prohibited by the protocol, and the unchanged router releases completed request IDs before delivery. This delayed stale removal is new to the fix; the previous implementation removed the callback before queueing delivery. Make callback completion conditional on the exact registration owner or matching registration epoch, and add a regression retaining the new callback across old delivery and cancelling it on the next stop.

## Checks and evidence

- Read the exact seven-file `c7f1f44..38cf1bc` fix package, original findings/brief/reports, and the changed lifecycle/bridge integration. No source/index/HEAD changes, suite reruns, subagents, device access, or external account access.
- Inspected existing JVM XML: ActivityLifecycleRegressionTest 5, LifecycleReplyDeliveryTest 3, BridgeRouterTest 6, SessionLifecycleTest 4, AssetPolicyTest 1; total 19, zero failures/errors. Existing lint XML has seven Warning entries and no Error entries. These artifacts support the recorded fix test run; they do not cover A1-R6.
- Ran one focused in-memory JShell probe with user-local JDK17 against the existing compiled Kotlin classes and cached Kotlin/Gson dependencies. The probe registered old delivery `x`, submitted its result, called `leaveForeground("background")` then `enterForeground()`, registered a new callback `x`, drained the old delivery, and stopped again. Actual output: `new registration=true`; `pending before old delivery=1`; `pending after old delivery=0`; `new request cancellation callbacks=0`; `old reply=SESSION_ENDED`. No test/source file was added or altered by this probe.
- Instrumentation and actual Redmi/MIUI lifecycle acceptance remain unrun. A1-R4 landscape policy stays deferred to the next native task/final triage; A1-R5's existing precise lint dispositions remain unchanged.

## Out-of-scope observations

- None added.

## Verdict

- **Fix round: findings remain open — new Important A1-R6.** Original A1-R1/R2/R3 are addressed; the new callback-ownership defect requires a narrow fix and scoped re-review before closing A1.
