# Planning review — 2026-10-14

## Verdict

**Request changes before freezing the implementation baseline.** The proposed architecture is feasible and the PRD covers the requested product. Five P2 planning defects below need concrete decisions and matching tests before separately assigned implementers can reliably produce compatible behavior. None requires changing the product scope, accessing provider secrets, or modifying the ESP32 firmware. Two smaller refinements follow.

This is a review of planning artifacts only. No application implementation, build, test suite, or hardware behavior was verified. No phone is attached. Review references identify the document line numbers as read on this date; later edits may move them.

Reviewed all of `docs/PRD.md`, `docs/superpowers/specs/2026-10-14-phone-monitor-design.md`, and the four `docs/superpowers/plans/2026-10-14-*.md` plans. Inspected the sibling firmware read-only for state, history, and write semantics. Checked relevant official Claude and Android documentation; ran only a read-only `busctl --version` capability check, without monitoring notifications or launching a provider.

## Required corrections

### R1 — P2: Expiry-only Claude events can falsely refresh the source and erase the required last value

**References:** design lines 130–134, especially 132; desktop plan lines 102–109 and 121–129; PRD lines 50, 62, 74; dashboard plan lines 114 and 127–136.

The design advances report time whenever API counters **or quota/reset values** change. Claude also invokes the status line at a reset deadline and removes expired windows from its input. Therefore, a five-hour window disappearing while API counters remain unchanged satisfies the proposed signature-change rule even though there is no new upstream report. It can refresh the age of the surviving weekly value and replace the expired value with unknown, contradicting the instruction to retain usage and show “Reset due; waiting for update.” This behavior is documented in [Claude's status-line update and available-data documentation](https://code.claude.com/docs/en/statusline).

**Remedy:** distinguish a new response, a genuinely changed supplied quota, and expiry-only removal. Expiry-only removal must not advance the report timestamp; preserve the last known expired window with its original timestamp/reset until a new report replaces it. A window never observed remains unknown. Also specify which retained per-session observation supplies the single public Claude source: an unchanged old session must not overwrite a newer session's quota merely because its wrapper ran later. The current bounded per-session state is useful but does not define that arbitration.

**Required tests:** five-hour expiry with unchanged counters and a surviving weekly window; both windows disappearing at expiry; initially absent windows; old session A timer firing after a newer observation from session B; hub restart/reload preserving the original observation time. No inference calls are needed.

### R2 — P2: Native setup operations conflict with the universal ten-second bridge deadline

**References:** design lines 106–114 and 158–160; Android plan lines 109, 132, 144 and 193–205; dashboard plan lines 45–49 and 127.

Every bridge request has a ten-second timeout, but `app.setupHub` returns the final `PairResult` after a person enters a code, and Wi-Fi setup includes human credentials/permissions/system approval. These actions routinely exceed ten seconds. The plans do not say whether timeout cancels the native dialog/network operation, allows it to finish with an ignored reply, or permits a second setup request while the first is active. A person can see a failure while pairing actually succeeds, or open duplicate native flows. The lifecycle instruction to retain approval overlays does not resolve the reply contract.

**Remedy:** choose one consistent contract. Prefer immediate acknowledgment of a single native setup session and a typed nonsecret setup state returned by `app.status`, with explicit completion/cancellation/failure and no credential data; alternatively define operation-specific human-interaction deadlines and late-completion reconciliation. Define exact argument/reply schemas for all `app.*` operations, including the brightness and screen-on argument keys, rather than leaving `app.status` as unspecified metadata. Freeze these schemas in D1 before A1/W1 consume them.

**Required tests:** user takes 30 seconds to enter the code; approval takes more than ten seconds; a duplicate setup tap; cancel; pairing expires while the dialog is open; renderer teardown; completion after a UI deadline. None should report an inaccurate paired state, create a second dialog/request, or expose credentials.

### R3 — P2: Replacing the latest light patch can lose independent intents; reconciliation ownership is unspecified

**References:** dashboard plan lines 90–92, 127 and 136–138; Android plan lines 169, 172–189 and 205–217; design lines 92–95, 114 and 166.

`LightPatch` is partial, yet the UI queues one “latest patch” by replacement. While a request is slow, a queued brightness change followed by a mode or power change can discard the brightness intent. Timer operations need ordering too: they must neither disappear under a later slider patch nor become part of an automatically resent accumulated desired state. This matters with the actual firmware: `/api/set` changes only present keys, `power=0` cancels a timer, and each positive `timer` value creates a fresh deadline (sibling firmware lines 453–478).

Separately, a timed-out `esp.set` returns an unconfirmed generation, while later `esp.state` replies contain no generation or command outcome. The plans say reconciliation resolves the marker, but do not specify who compares the read to the desired patch, whether/when a non-timer patch is retried, or how that decision reaches the UI. Independent implementations can leave “Unconfirmed” permanently or clear a newer intent using an older read.

**Remedy:** define per-field merging for unsent ordinary patches, preserving the latest desired value for each touched field without resending untouched fields. Define timer operations as ordered, once-only barriers or a separate bounded operation slot, including mixed-patch rejection/splitting and what happens on explicit power-off. Specify one owner for reconciliation, the exact generation outcome delivered to the UI, and a bounded non-timer retry policy or an explicit user-retry-only policy. A state read may confirm a matching latest intent only after the relevant dispatch and without superseding a newer intent. Timer completion remains uncertain if state cannot prove it; it is never replayed.

**Required tests:** brightness then mode while an earlier write is pending; timer then slider; slider then timer; power-off with timer pending; timeout followed by matching/mismatching state; older poll completing after a new intent; teardown/reconnect with a timer pending. Preserve the four-writes-per-second bound and final release value.

### R4 — P2: Cached hub responses need an explicit sampled-time rule

**References:** design lines 88–99, 114 and 183–185; Android plan lines 109, 112 and 144; dashboard plan lines 91, 114–122 and 138.

Native failed requests return the last cached `HubSnapshot` with an increasing `LinkSnapshot.ageMs`. The dashboard clock helper receives only `serverNowEpochMs` and the WebView receipt time; the plan does not explicitly distinguish the time the cached hub data was originally obtained from the time the bridge returned it again. Reanchoring to the unchanged server timestamp on every failed poll makes reset countdowns and notification expiry move backward or stall during USB loss. Re-fetch after renderer recreation is especially important because JS has no prior baseline then.

**Remedy:** define the connection between these existing fields. For example, on receipt use `serverNowEpochMs + ageMs` as the estimated laptop time at that receipt, then advance it with WebView monotonic elapsed time; `ageMs` must refer to that exact cached payload's native receipt. Or retain an explicit immutable sample identity/baseline and update it only on a new successful hub payload. Compute local source staleness as time advances as well, rather than trusting a previously serialized `stale:false` forever. Do not invent a baseline when no valid hub sample exists.

**Required tests:** repeated cached bridge returns through at least a 30-minute USB outage; notification expiry during that outage; reset countdown never moving backward; source staleness crossing its threshold; renderer recreation while native retains old data; phone wall-clock changes. Use synthetic clocks.

### R5 — P2: The Claude passthrough needs cancellation and child-stream semantics, not only byte-copy tests

**References:** design lines 130–134; desktop plan lines 121–129 and 142.

The wrapper spawns the existing status-line shell and forwards stdin, but the plan's preservation tests cover only input/output bytes, overflow, and installer ownership. Claude cancels an in-flight status-line invocation when another update arrives, per its [status-line lifecycle documentation](https://code.claude.com/docs/en/statusline). A new intermediary process needs an explicit cancellation/reaping policy so a terminated wrapper does not leave the previous shell or its descendants running and writing late output. A previous command that exits without consuming all stdin also creates a normal early-pipe-close case that monitoring must not turn into a wrapper crash.

**Remedy:** define how the original shell is determined to preserve the installed Claude command semantics; do not silently substitute an arbitrary login shell. Preserve exit status and signal/cancellation behavior, handle stdin backpressure/early EPIPE without suppressing the user's output, and terminate/reap only the wrapper-owned child/process group on cancellation. Define bounded cleanup without killing unrelated processes. Include the selected absolute Node executable in wrapper installation so it does not depend on an interactive version-manager environment.

**Required tests:** cancellation during a long-running previous command; a child that spawns a descendant; early stdin close; nonzero exit; exact stdout with collector errors; repeated replacement invocations leaving no owned processes. All use synthetic commands and temporary settings.

## Minor refinements

### C1 — P3: Correct the Wi-Fi permission version boundary

Android plan line 193 names location permission on API 29/30 and nearby Wi-Fi on newer APIs. State the supported branches explicitly: fine-location compatibility through API 32, and `NEARBY_WIFI_DEVICES` from API 33, with the required manifest declarations, `neverForLocation` where applicable, and location-services-off handling for applicable older devices. API 31/32 must not fall between branches. This follows [Android's Wi-Fi permission documentation](https://developer.android.com/develop/connectivity/wifi/wifi-permissions). Add API-boundary permission tests; the actual Redmi behavior still needs observation.

### C2 — P3: Define the over-budget bucket behavior

PRD P04 (line 26) promises every returned Codex bucket/window; design line 101 caps the entire snapshot at 64 windows. Set a deterministic over-budget behavior, such as keeping last good data and showing an explicit unsupported/over-capacity source error, and test it. Do not silently truncate while claiming the displayed list is complete. This is a bounded-input refinement, not a request for unbounded rendering.

## Coverage and consistency conclusions

- **Product coverage:** P01–P12 and A01–A16 have identifiable implementation/review tasks. The layout, climate history, all nine modes, explicit light controls, selected notifications, offline shell, independent connection failures, setup, and packaging are accounted for. The first-release scope is appropriately limited.
- **Topology and feasibility:** native HTTP plus packaged WebView assets avoids the firmware's lack of CORS. Per-connection Wi-Fi binding leaves USB loopback independent. No-internet readiness, manual fallback, loss handling, approval overlays, and MIUI discovery are acknowledged. No attached-device result is implied. The specified JDK 17/Gradle 9.6.0/Build Tools 36.0.0 combination matches [AGP 9.4 compatibility documentation](https://developer.android.com/build/releases/agp-9-4-0-release-notes); actual downloads/builds remain execution work.
- **Privacy/security:** loopback-only authenticated snapshots, explicit limited pairing, strict origin/main-frame bridge checks, no remote assets, native-only credentials, bounded inputs, empty notification allowlist, safe errors, and provider-managed authentication form a sound baseline. No need to add credential extraction, account connectors, or general shell/network bridge access.
- **Contracts/task ordering:** D1 precedes contract consumers; D3 precedes the USB client; A3 precedes functional controls; the hardware checkpoint can remain unrun without stopping mock-verifiable work. Cross-file task links and model identifiers are consistent. R2–R4 are the remaining contract decisions needed before this becomes a safe independently delegated plan.
- **Nonfunctional requirements and evidence:** byte/size/time/resource targets and software-versus-device completion levels are explicit. Temp-file installer tests, fake provider children/ADB, parser/clock/queue tests, browser layout checks, Android tests, and physical acceptance are appropriate. The plans correctly avoid pretending mocks prove radio routing or MIUI behavior.
- **Agent/release policy:** assignments scale from mechanical Luna tasks through Sol implementation/review to Astra for Android/trust boundaries. Sequential implementation avoids shared-tree conflicts. A final fresh `gpt-6-astra` at `high` for the finished project is explicit in the PRD, design, main plan, and packaging task. Preserve that gate after fixing these planning findings.

Re-review should verify the five required decisions are reflected consistently in the design and affected task tests. Hardware absence alone is not a planning blocker; it remains a blocker to claiming the eventual software is device-accepted or fully finished.

## Scoped re-review — 2026-10-14

**Final planning verdict: approved for user review.** All five required findings and both minor refinements are **ADDRESSED in the planning baseline**. No blocking planning issue remains from this scoped re-review, and no concrete new blocking defect was found in the amendments. This supersedes the initial request-changes verdict above while preserving its history. It does not constitute the user's implementation approval, software verification, device acceptance, or the later finished-project review.

Scope: read the resolution record, amended PRD/design sections, corresponding D1/D2/A1/A2/A3/W1/W2 interfaces and planned regression cases, and the new portable handoff records/rules. References below use the amended documents' line numbers. No product code, builds, product tests, hardware checks, or private account data were involved.

| Finding | Result | Amendment and verification coverage |
|---|---|---|
| R1 — Claude expiry/session freshness | **ADDRESSED** | Design lines 58–67 and 164–168 define per-window report time, expiry-only preservation, conservative first-seen data, locked genuine-report ordering, and restart behavior. Desktop D2 lines 99–110, 130–132 and 145 require expiry, old-session, initial-sample, reload, and ordinal tests. Dashboard W2 lines 94 and 114 preserve row age independently of source updates. |
| R2 — Setup deadline and exact schemas | **ADDRESSED** | Design lines 101–144 define immediate SetupResult, exact app operation args/replies, one native flow, duplicate/competing requests, typed completion, and renderer/Activity separation. Android A1 lines 45, 61 and 93 and A2 lines 112 and 132 cover long human interaction, cancel/expiry and native token ownership. Dashboard W1 line 46 and W2 lines 94, 127 and 138 use status outcomes rather than treating acknowledgment as success. D1 line 44 freezes the schemas before consumers. |
| R3 — Merged intents, timer isolation and reconciliation | **ADDRESSED** | Design lines 92–100, 129, 144 and 200–202 define separate command kinds/outcomes, per-field ordinary merging, timer-only barriers, bounded queues, power-off cancellation, native post-dispatch reconciliation, and explicit-only retries. The native generation floor prevents reuse after renderer recreation. Android A3 lines 169, 172 and 207 and dashboard W2 lines 91–94, 127 and 136–138 carry the contract and cross-field/order/timeout/generation regression cases. |
| R4 — Cached sampled time | **ADDRESSED** | Design line 114 explicitly binds age to the exact native cached payload and anchors time with serverNowEpochMs plus ageMs, including renderer/native-process recreation and absent samples. Android A2 lines 112 and 144 preserve that baseline. Dashboard W2 lines 91, 94 and 114–121 update the helper and require the 30-minute outage, expiry, threshold and clock tests. |
| R5 — Passthrough cancellation and streams | **ADDRESSED** | Design lines 160–162 require declared/verified shell compatibility, absolute Node execution, preserved stream/exit behavior, EPIPE/backpressure handling, owned process-group cleanup, and a check of actual normal cancellation semantics. D2 lines 99, 125–130 and 145 include those requirements and synthetic descendant/cancellation/exit/overflow tests. The plan correctly avoids claiming hard-kill cleanup is possible. |
| C1 — Wi-Fi permission boundary | **ADDRESSED** | Design line 194 and Android A3 lines 172 and 193 explicitly cover fine location through API 32 and nearby Wi-Fi from API 33, with older location-services state and API-boundary/denial tests. |
| C2 — Capacity overflow | **ADDRESSED** | PRD P04 now qualifies supported capacity. Design line 116 reserves two Claude and 62 Codex windows and defines explicit unsupported/SOURCE_CAPACITY_EXCEEDED behavior with retained stale or empty data. D1 line 85, D2 lines 102 and 145, and W2 lines 94 and 114 require capacity/error behavior without silent truncation. |

### Portable handoff assessment

**Accepted.** Root AGENTS.md lines 14–18 and 32–50 establish a resume procedure, evidence checks, one coordinating writer, checkpoint triggers, sanitized content, and separate completion gates without requiring access to this conversation. HANDOFF.md records the objective, verified/unverified context, current phase, exact next action, and links to the authoritative documents. STATUS.json makes implementation/task/review gates machine-readable; PROGRESS.md preserves the initial findings and subsequent decisions as append-only history. The main plan's lines 95–99 and 108 require checkpoint updates after tasks/reviews and before yielding, plus consistency at final review. D1 line 37 preserves these existing records rather than recreating or discarding them.

The additional user requirement is also traceable through PRD P13 (line 35), acceptance A17 (line 125), and the W3 A01–A17 procedure (dashboard plan line 190). A17 requires an independent agent to locate the actual first incomplete task and verify files/reports/gates without chat history; disagreement must be detected instead of silently repeating work. The PRD agent policy and ledger carry maintenance/ownership and the added acceptance requirement. This turns the handoff into an explicit maintained deliverable with a reviewable resume check.

At inspection, the checkpoint correctly still described this re-review as pending and retained open findings; that was accurate before the verdict was issued. The coordinator should now append this outcome to PROGRESS, mark R1–R5/C1–C2 closed and the planning review approved in STATUS, update HANDOFF and the resolution record to point to this section, and set the next action to user review of the concrete planning baseline. Keep planUserApproved, productImplementationStarted, softwareVerified, deviceAccepted, and finalProjectReviewed false until their respective events actually occur. This is the normal required checkpoint update, not another product-planning blocker.

The complete finished-project review by a fresh `gpt-6-astra` at `high` remains a mandatory later execution gate (main plan lines 103–111). The planned regression tests described here must still be implemented and run; reviewing their specifications supplies no passing product-test evidence.
