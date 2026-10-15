# R-NATIVE review — stopped before verdict

Date: 2026-10-15. **Informational; outside the current UI-only scope.** The user narrowed the active task to the dashboard and Deck UI. Native investigation stopped immediately. No spec-compliance or quality approval is issued.

The partial read covered the native review package for baseline `87bd88d`, including fullscreen checkpoint `649e9f2` and subsequent uncommitted action routing. No tests, device actions, settings changes, or source fixes were performed. Reported builds and instrumentation compilation were not independently rerun; physical acceptance remains separate.

## Observations already established from the supplied diff

- **Medium, informational — fixed action IDs are not enforced at the native boundary.** `android/app/src/main/java/com/phonemonitor/ProtocolValidator.kt:58` (`args`, added `hub.action` branch) accepts any nonempty action string up to 80 characters. It does enforce the exact single `action` argument shape, but does not restrict the value to the requested fixed action IDs. The downstream hub's independent validation was outside this review; this observation does not establish arbitrary command execution.
- **Medium, informational — malformed HTTP 200 responses can become success.** `android/app/src/main/java/com/phonemonitor/LaptopClient.kt:289` (`action`) returns `{success:true}` when parsing returns null or the response lacks `data`. The supplied code therefore acknowledges an action without a valid success payload. These are diff-based locations for the enclosing functions; active parallel edits may shift them.

## Unfinished review and cross-task acceptance

The fullscreen diff contains separate API29/API30+ paths, cutout/IME policy, focus/resume gating, and normal sensor rotation. Inspection stopped before a verdict on their correctness, action lifecycle/cancellation, response/error mapping, or preservation of independent USB/Wi-Fi trust.

When native acceptance is explicitly resumed, retain the planned physical checks: keyboard resize and dismissal on API29; native secure pairing/Wi-Fi dialog focus and keyboard access; cutout safety in both orientations; transient navigation gestures; Home/return; and simultaneous USB/Wi-Fi continuity. Compiled instrumentation and APK builds do not establish those outcomes. Dashboard/native background-color alignment is a later narrow integration check.

Coordinator: preserve this stopped status in the checkpoint; these observations are not authorization to expand the current UI-only task or perform native fixes.
