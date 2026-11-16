# Desk clock repair — independent review, 2026-10-23

Reviewer: actual `gpt-6-astra`, high reasoning effort. Scope: the current desk-clock repair only, against preserved task-start baseline at `.superpowers/clock-repair-2026-10-23/baseline`; detached canonical checkout at `8e8ddcc`. This is not a finished-project or physical-device acceptance review.

## Stage 1 — logic/audio, changes requested

Reviewed the task brief, PRD, system design, checkpoint records, logic-only diff/hash manifest, TimeStore and audio source, regression tests and worker report. Independently ran `npm test --workspace @phone-monitor/dashboard -- test/timeStore-regressions.test.ts` with the pinned Node 24 runtime: 18/18 passed. The UI remains in progress; final approval is withheld until its frozen scope and integration evidence arrive.

### P2 — Suspended audio retains unbounded scheduled alarm nodes

`dashboard/src/lib/clockAudio.ts:67`–`73`: the repeating callback creates two oscillators on every interval regardless of AudioContext state. A context can remain suspended when automatic playback/resume is denied, or be suspended later by the platform. Its audio clock does not progress, so scheduled stop/onended cleanup does not run. Each callback then retains another pair in `activeAlarmOscillators`; eventual resume can play the accumulated tones together. This remains a resource leak despite successful ended-node cleanup in the ordinary running-context test.

Independent synthetic reproduction: transpile the exact source into an isolated VM; supply a fake AudioContext with `state='suspended'`, fixed `currentTime=0`, rejected resume and normal node constructors; invoke `startAlarm()` and 100 captured interval callbacks. Observed 202 allocated and 202 retained oscillators after the equivalent of 140 seconds. No real audio was exercised. Skip allocation until the context runs and ensure resource retention stays bounded through later suspension; add tests for denied resume and running-to-suspended transition.

No additional P1/P2 finding established in the reviewed TimeStore paths at this stage. Scheduling, snooze, queue, once-disable, storage validation, elapsed-time handling and snapshot changes were inspected. Disclosed current-session/foreground limitations remain applicable; this review does not establish native background alarms or process-death recovery.

## Pending

- Audio finding fix and independent rereview.
- Frozen Clock UI/App/CSS/tests, synthetic visual/interaction evidence and full dashboard verification.
- Final task-only verdict. No commits, deployment, real account payload reads, phone operations, or real audio/lamp tests were performed by this reviewer.

## Stage 1 rereview — audio finding resolved

The refrozen audio implementation skips every repeating beep while context state is not `running`, disconnecting any still-scheduled alarm tones during suspension. A later successful unlock can resume the pending alarm without replaying a backlog. Inspected the corresponding denied-resume and later-suspension regression; independently reran the targeted suite: **19/19 passed**. Verified all three file hashes against the refreshed manifest: TimeStore `5dc817f8…`, audio `90cf1623…`, regression tests `820fb602…`.

The Stage 1 P2 is resolved. No open P1/P2 remains in the frozen logic-only scope. Final task approval still depends on Stage 2 UI and integration review.

## Final scoped review — 2026-10-24

Actual independent review executed with `gpt-6-astra`, high reasoning effort, after the interrupted review session. The coordinator confirmed that exact model/effort selection for this resumed reviewer. This section completes the clock repair review; it does not retroactively claim the interrupted Stage 2 had delivered approval.

**Verdict: approve the frozen desk-clock repair scope. No unresolved P1/P2 findings in that scope.** The original Stage 1 audio P2 and its resolution above remain part of the record. Full dashboard verification and signed APK/device checks remain coordinator gates; this is not broad finished-project or physical-device acceptance.

### Scope and evidence

- Read the current instructions, HANDOFF/STATUS/PROGRESS, PRD, system design, desk-clock brief, worker reports, task-only diff and current implementation. Verified detached baseline `8e8ddcc` and the dirty working tree. All **14/14 SHA-256 values** in `.superpowers/clock-repair-2026-10-23/review-hashes.json` matched at start and again immediately before this verdict. The pre-task dirty work is the review baseline, not the Git HEAD diff.
- Inspected ClockView, ClockAlert, TimeStore, clockAudio, scoped App integration, replacement CSS and tests. The clean clock/date, optional status, deliberate timer focus, stable display tracks, reveal controls and Appearance sheet satisfy the task brief. Saved valid stacked preferences remain intact; fresh/invalid preferences use horizontal layout. App changes preserve underlying Monitor/Agenda/Deck behavior and return to the actual opener. A single native alert keeps alarm priority and pending timer completion visible from every view.
- Independently ran `npm test --workspace dashboard -- test/timeStore-regressions.test.ts test/clock.test.tsx` with the pinned Node 24 runtime: **35/35 passed** (22 logic/audio regressions and 13 clock/UI tests), exit 0. Inspected the coordinator's fresh full dashboard unit/typecheck logs: **207/207 passed**, dashboard/source and E2E TypeScript commands completed without errors.
- Independently exercised the current production bundle in installed Chrome on a separate local preview at port 4183, with fresh synthetic browser state, synthetic native bridge and audio disabled. Reran the prior four browser probes: focused +1 Min remains visible/focused after seven seconds; completion on Monitor restores opener focus; Appearance Escape leaves Clock open; next alarm selection correctly prefers Saturday's daily alarm over Monday's weekday alarm. The old probe's descriptive name says Monday, but its fixture and correct observed result are Saturday 09:00.
- Additional Deck scenario passed: two simultaneous once alarms appear sequentially and both persist disabled; snoozing the first leaves the independent countdown running (03:59 remaining); the snoozed alarm later appears with “Timer complete also waiting”; dismissing it reveals Timer complete, and final dismissal clears the alert. No uncaught page errors. Evidence: ignored `reviewer-alerts-2026-10-24.mjs` and `reviewer-alerts-results-2026-10-24.json` under the task evidence directory.
- Additional nested-modal scenario passed: Tab/Shift+Tab does not reach the underlying application; alarm/timer alert Escape restores the focused Done control in Appearance; another Escape closes only Appearance. A Friday-night weekday-only alarm advertises Monday 08:00, and the date updates to Saturday across midnight. No uncaught page errors. Evidence: `reviewer-modal-2026-10-24.mjs` and `reviewer-modal-results-2026-10-24.json`. An initial stricter probe rejected Chrome's normal browser-chrome focus boundary (`activeElement=BODY`, `document.hasFocus()=false`); diagnostic tracing showed the next Tab returns to the active modal, so the final assertion allows browser chrome while rejecting underlying app focus. No product change was made for that harness assumption.
- Personally inspected all eight existing repair images in `evidence/clock-repair`: desk and focus at 800×360, 740×320, 360×800 and 320×800. Digits and controls are readable, steady and unclipped, with the restrained presentation requested. Reviewed the focused matrix tests for all modes, 130% text, saved stacked layout, long countdown, keyboard ownership and control/readout geometry. No original screenshot was overwritten by this reviewer.

### Separate verification gate observed

The coordinator's fresh complete browser run recorded **88 passed / 1 failed**. The failure is `dashboard/e2e/calendar.spec.ts:343`, where the preexisting Agenda paging test expected the synthetic second-page item after switching Today back to Upcoming. It must be investigated/resolved or explicitly ruled on with evidence before claiming the complete regression suite passes or deploying. The failed test and Agenda implementation are outside the clock repair diff; that alone does not establish that the failure is harmless. This review approves the clock code, not an unqualified all-checks-green release.

### Limits and ownership

Alarms, countdowns, stopwatch and snooze retain the documented foreground/current-session limits. These checks establish neither native background/process-death behavior nor actual chime output, WebView rendering, Redmi USB/Wi-Fi routing or ESP32 light behavior. No real audio, lamp, phone, account/provider payload or private capture was tested; no product source edit, commit, publication or deployment was performed. The coordinator owns checkpoint updates, the full-suite failure disposition and the signed in-place installation/device checks.

## Coordinator regression disposition — 2026-10-24

The initial full browser run completed with 88 passed / 1 failed at the Agenda paging expectation above. The exact failing test passed in isolation (1/1, exit 0); a second complete production run then passed **89/89**, exit 0, without any product or test changes between runs. Preserve the original failure as an intermittent Agenda test result, rather than claiming the first run was green. Synthetic historical time, initial server-time anchoring and Today range rebasing are plausible timing-sensitive contributors, but a root cause was not established. This is a separate residual test-flakiness limitation, not an open clock review finding. No unrelated Agenda implementation was changed to force a pass. The deployment regression gate is cleared by the complete clean final run, the isolated pass, unchanged reviewed sources and the independent clock review.

Coordinator independently confirmed **207/207 dashboard unit tests**, source and E2E TypeScript checks, and the clean **89/89** production browser run. Logs remain in ignored `.superpowers/clock-repair-2026-10-23/{final-unit.log,final-typecheck.log,final-e2e.log,agenda-rerun.log,final-e2e-repeat.log}`. All 14 reviewed source/test/spec hashes still match, and all 163 pre-task PNGs are byte-identical to baseline. Signed build/install evidence follows in the live checkpoint; physical device acceptance remains separate.
