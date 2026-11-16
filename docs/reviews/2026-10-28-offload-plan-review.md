# Phone-hub offload design and plan preflight

Date: 2026-10-28. Review configuration: independent `gpt-6-astra`, high reasoning effort.

**Verdict: APPROVED for software implementation.** No unresolved load-bearing design finding blocks H1–H4. The current human instruction permits software construction without the phone. No further general approval or device availability is required to implement and test the specified seams. This is a design/plan review, not implementation verification, hardware acceptance or the finished-project review.

## Scope and evidence

Reviewed canonical dirty detached worktree `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor` at `e59d312b0a27c9a3e8b658c34993a22a3be5645b`. Read AGENTS, HANDOFF, STATUS and PROGRESS before the PRD, original system design, new design/plan and relevant existing code. Confirmed the preserved baseline directory exists. Historical checkpoint records still describe the installed Clock and earlier exploratory offload discussion; the coordinator must checkpoint the current instruction and this verdict before handoff. Those older records do not override the current authorization.

Reviewed document SHA-256 values:

- `docs/PRD.md`: `56b3ff6697bd96c1f970607378982e3c9047801a15bb45d9910c7d65e12c6102`
- `docs/superpowers/specs/2026-10-28-phone-hub-offload-design.md`: `4ff44bf6c148dbc84fda947212029b75402bca2ad4405ac024e641bfc096089f`
- `docs/superpowers/plans/2026-10-28-phone-hub-offload.md`: `2c4173486af9d7a9fc544adc1bd8a53689348c1fefd55c51134de3aac274b578`

Source checks included `CalendarClient.kt`, `CalendarValidator.kt`, `MainActivity.kt`, `SessionLifecycle.kt`, `BridgeRouter.kt`, `desktop/src/main.ts`, `desktop/src/calendar/api.ts`, `desktop/src/calendar/service.ts` and existing Calendar API tests. Public primary-source checks covered Android authorization and upstream gnirehtet Activity/service route handling. No provider auth files, account data, private logs, real collectors, devices, network changes or firmware were accessed. No tests were rerun by this reviewer; the coordinator's baseline results are not represented as independent results.

## Findings

No open blocking or actionable design defect. The plan has concrete owners, boundaries, interfaces, preservation requirements and test gates. Routine implementation decisions can be resolved safely within them. The following are verification checkpoints for the assigned owners, not requests for more design or human permission:

1. **H2 Calendar parity must include upstream request semantics.** Existing `api.ts` requests hidden calendars/invitations, expands recurrence, reads `labelProperties.eventLabels`, opts into `eventLabelVersion=1`, and retries an unsupported label request without silently claiming complete label fidelity. Existing tests contain synthetic label, declined-event, recurrence and fallback fixtures. Reuse their meaning in native tests, including metadata-only label changes, multiple upstream pages, source selection before event reads, global next-event computation and generation-bound pagination. The design explicitly retains these requirements; merely satisfying the output validator would not establish parity.

2. **H2/H4 own the consent generation separately from ordinary network work.** Existing `NativeSession` recognizes only hub/ESP setup, and `MainActivity.onStop()` pauses clients when that session leaves foreground. The new explicit Google flow therefore needs the planned dedicated lifecycle integration. Verify successful external consent through its expected stop/resume, user cancellation, genuine backgrounding, Activity destruction and stale completion after disconnect/mode change. Ordinary reads/server sockets must still obey the foreground boundary. This is identified and assigned in the plan, not an unresolved design decision.

3. **Interpret token storage promises as application-owned storage.** Google Play services itself caches access tokens; an in-memory-only app wrapper cannot promise that the OS authorization provider never caches them. Keep tokens out of this app's files/bridge/server/logs. On invalid-token recovery, use bounded cache invalidation/reacquisition; a resolution that requires interaction becomes explicit Connect-needed state rather than launching consent from a poll. Local Disconnect must clear app state immediately even if a separate revocation call fails. These choices fit the existing scope and require no additional scopes or account-data collection. [Android authorization documentation](https://developer.android.com/identity/authorization).

4. **H3 needs exact binding and at-most-once delivery across failures.** Manual native confirmation plus interface/address lease checks is a conservative software default; it is not proof that an interface is the Redmi hotspot. Preserve that device acceptance limitation. Test lease disappearance and address reuse, pause during a client request, concurrent polls, socket-write failure after dequeuing, foreign/stale acknowledgments, and lost timer acknowledgment. A command considered delivered must never become eligible for resend; uncertainty stays visible. Keep generation reservation compatible with `NativeSession` across device/backend changes. The existing plan's no-replay and exact-bind requirements cover these cases.

5. **H1 must validate relay configuration, not assume its defaults.** Upstream gnirehtet uses `0.0.0.0/0` when its route list is empty and defaults DNS to `8.8.8.8`. Require a nonempty tested include-route set excluding the specified local ranges, and ensure any configured DNS address remains reachable through that set. Test representative boundary addresses, selected-device mapping ownership, preservation of hub mapping and cleanup of only owned state. A preexisting gnirehtet VPN is not made owned merely by sending START; upstream ignores START while already running. Detect/refuse ambiguous ownership rather than stopping another session. These are safe implementation choices within the plan's explicit ownership rules. [Upstream service](https://github.com/Genymobile/gnirehtet/blob/master/app/src/main/java/com/genymobile/gnirehtet/GnirehtetService.java), [upstream Activity](https://github.com/Genymobile/gnirehtet/blob/master/app/src/main/java/com/genymobile/gnirehtet/GnirehtetActivity.java).

6. **H1 offload preservation must be demonstrated at composition boundaries.** Current `main.ts` constructs host/vitals/Calendar eagerly and invokes `sharedHostHelper()` during shutdown. Constructor spies and helper ownership tests are therefore substantive. Preserve both quota adapters, selected notifications and explicit actions; a demand-created host helper must be tracked and cleaned up without creating a new singleton during shutdown. The plan correctly requires this rather than treating a slower poll interval as offload.

## Remaining gates

Fresh task review and full software verification remain required after implementation. Google Cloud Android registration/signing identity, real consent/refresh, simultaneous USB internet/hub loopback/hotspot sockets, MIUI lifecycle, future separately approved ESP firmware compatibility and measured laptop resource savings remain unverified. The phone is absent; no installation or device-acceptance claim is made. The existing sibling firmware stays read-only.

Only this scoped report was written. Coordinator should checkpoint this approval and dispatch the implementation owners.
