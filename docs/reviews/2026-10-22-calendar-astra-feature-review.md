# Calendar feature independent Astra-high review

Date: 2026-10-22. Reviewer: required `gpt-6-astra`, reasoning effort `high`, running in the Codex harness. This is a fresh review of the actual Calendar implementation, including the C3 native scope and integrated C1–C5 behavior; it does not substitute the previous Antigravity review for this gate.

Execution root: `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`. HEAD: `8e8ddccd73dcc05ed673f1aabbf9a3048cca5d71`, with the recorded dirty pre-feature 1.3.2 baseline. Reviewed the snapshot-relative feature package, current source, approved Calendar design/plan, PRD/system design, live checkpoints, and prior reports as claims to verify. No product source, Git index or HEAD was changed by this reviewer.

## Verdict

- **Specification compliance: needs fixes.** Consequential software requirements are not met.
- **Code quality/release readiness: needs fixes.** Do not install the current candidate as a reviewed, finished Calendar feature. Fix the findings below, run focused regressions and integration checks, and obtain a scoped Astra-high rereview.
- **Native C3 review: needs fixes for the age contract below.** The inspected fixed transport, strict validation, bearer confinement, localized unsupported handling, foreground cancellation, selection epoch checks and renderer reply gating otherwise have no additional consequential C3 finding from this pass.
- **The required model review has occurred; approval has not been granted.** Earlier zero-findings reports are superseded for the issues identified here. This is a Calendar feature verdict, not a reopened review of unrelated historical pairing/backend tasks or a final physical product acceptance.

## Direct Astra findings

### A1 — P2: Separate cached response receipt age from upstream Calendar sync age

Locations: `android/app/src/main/java/com/phonemonitor/CalendarClient.kt:243–255`, `CalendarClient.kt:137–141`, `CalendarClient.kt:335–350`, and `dashboard/src/calendar/store.ts:484–503`.

Native `storePage` subtracts `serverNowEpochMs - lastSuccessAtEpochMs` from the receipt baseline, so `LinkSnapshot.ageMs` contains the age of the last Google sync. The dashboard then adds that entire age to `serverNowEpochMs`, treating it as elapsed time since the response was generated. A perfectly healthy response fetched 60 seconds after Google sync advances the displayed clock by 60 seconds and reports the sync as 120 seconds old. An ongoing event ending in 30 seconds vanishes from Next up early. `Math.max` in the dashboard anchors that erroneous future clock even after a fresh sync. Source enumeration can push it forward further because its source timestamps may be older. Native also applies the ordinary six-second snapshot stale threshold to upstream Calendar age despite a normal two-minute Calendar refresh interval, so healthy Agenda data becomes stale almost immediately.

Focused synthetic reproduction ran the actual `CalendarStore` and `nextSummary` with the protocol fixture, a fake adapter returning the age that current native code computes, and an injected monotonic clock. Result:

```text
actual sync age = 60000 ms
estimated clock ahead = 60000 ms
reported sync age = 120000 ms
event ends in 30000 ms of real server time
nextSummary = null
```

Define one consistent receipt-age contract across native/dashboard, keep source timestamps separate, and preserve their age on failure. Add an integration regression with nonzero upstream age, offline cached reads, source enumeration, and the ongoing-to-ended boundary. Merely raising the stale threshold does not fix the clock error.

### A2 — P1: Enforce capacity against the proposed merged range, including retained failed sources

Locations: `desktop/src/calendar/service.ts:797–838`, `service.ts:343–365`, and `service.ts:660–679`.

Staging limits count only newly fetched records. A refresh then combines successful new windows with old complete windows retained for failed sources without checking the resulting occurrence or byte total. Thus the published range can exceed the approved 10,000-occurrence/16 MiB bounds. Eviction also permits the sole pinned range to exceed the cache byte ceiling. This violates the explicit product capacity contract and permits larger native/UI workloads than the tested limit.

Focused reproduction used actual `CalendarService`, an in-memory synthetic connection store and fake paginated HTTP responses; no account files or network were accessed:

```text
initial source A = 5000, source B = 5000: 10000 cached occurrences
refresh source A = 10000, source B = HTTP 503
published cache = 15000 occurrences, state = partial
approved range limit = 10000
```

Build and check the candidate merged result before publication. On a breach, preserve the previous complete range and return explicit capacity state. Include retained source windows and label-reference allocations in bounded-cache accounting.

## Integrated scoped-review findings

The coordinator forwarded these fresh Sol-high C2/C4 findings before this verdict. This reviewer also read their final reports and inspected the implicated production paths; the specialized reviewers own their detailed reproductions. Reports: `docs/reviews/2026-10-22-C2-calendar-desktop-review.md` and `docs/reviews/2026-10-22-C4-calendar-dashboard-review.md`. Each remains a required fix rather than a reason to accept the current candidate. In total this pass identifies **15 distinct consequential findings: two P1 and thirteen P2**, counting A2 once rather than duplicating the C2 report's capacity finding.

| ID | Priority | Location at reviewed baseline | Defect and required outcome |
| --- | --- | --- | --- |
| C2-auth-concurrency | P2 | `desktop/src/calendar/api.ts:236–252`; `desktop/src/calendar/service.ts:529–551` | `Promise.all` rejects on one 401 while the other runner continues; retry starts another batch before old work settles, exceeding the two-request ceiling. Abort/drain the failed batch before retry and keep its staging state isolated. |
| C2-queued-backoff | P2 | `desktop/src/calendar/service.ts:473–495` | Work already queued is dispatched without checking a newly established Retry-After deadline. Manual refresh can execute its event job immediately after metadata returns a 600-second backoff. Recheck at dispatch and retain only bounded coalesced work for scheduled retry. |
| C2-metadata-backoff | P2 | `desktop/src/calendar/api.ts:378–413`; `desktop/src/calendar/service.ts:603–633` | Metadata catch suppresses 429/5xx and Retry-After as unavailable label metadata, allowing subsequent requests despite backoff. Preserve retry/capacity failures so the scheduler honors them. |
| C2-label-status | P2 | `desktop/src/calendar/api.ts:408–420,605–615`; `desktop/src/calendar/service.ts:719–728`; `dashboard/src/components/AgendaView.tsx:90–100` | `labelMetadataAvailable` and `labelOptInFallback` are discarded before publication, so rejected/missing named-label support is silently shown as fully available, including “events and labels.” Surface an honest visible fallback state while retaining event/source badges. |
| C2-refresh-scheduler | P2 | `desktop/src/calendar/service.ts:207–212,233–249,464–470,841–862` | Refresh scheduling is driven only by Calendar requests; the worker watchdog stops after work finishes and does not schedule refreshes. Startup/idle fifteen-minute refresh and refresh while the phone is active on another tab do not occur as specified. Add a bounded service-owned scheduler and shutdown cleanup. |
| C2-initial-metadata-failure | P2 | `desktop/src/calendar/service.ts:484–495,691–700` and `read()` final-state override | After initial metadata failure, the empty discovered list is treated as zero selected readable calendars and returned as available/empty. Keep failed or undiscovered metadata distinct from a successfully discovered empty selection. |
| C4-selection-race | P2 | `dashboard/src/calendar/store.ts:388–424,560–588` | Polls started while selection is pending share the new generation and can restore old selected rows before the authoritative response; the required revision guard can also be cleared before a later old response returns. Serialize/invalidate read publication across selection acknowledgement and reject late old-selection pages. |
| C4-page-race | P1 | `dashboard/src/calendar/store.ts:256–290` | A late load-more response is compared only with the revision captured when it started, then merged into whatever rows now exist. A newer page-one poll can be rolled back or combined with the old revision, resurrecting events from an already removed source. Compare against current published revision as well and invalidate outstanding pagination on replacement. |
| C4-source-reset | P2 | `dashboard/src/calendar/store.ts:577–585` and source snapshot preference | Disabled/new-connection reads clear page rows but retain `enumeratedSources`, which takes precedence over new page sources. Old-account calendar selections can remain visible during reconnect. Clear source enumeration and its associated request generation on connection/reset transitions. |
| C4-detail-reset | P2 | `dashboard/src/components/AgendaView.tsx:120–123,141–151,750–761` | Open detail state retains an independent event after authenticated disconnect/source removal clears store rows. Purge or close invalid details on authenticated lifecycle changes while retaining ordinary offline cached details. |
| C4-range-state | P2 | `dashboard/src/components/AgendaView.tsx:118–119,212–221,262`; heading rendering | The displayed range/Today reset relies on component-local `rangeShifted`, which resets on tab remount, rather than the actual store range; midnight also changes the heading without moving the loaded range. Always label the actual loaded dates and make Today explicitly select today's range. |
| C4-spanning-event | P2 | `dashboard/src/components/AgendaView.tsx:264–278` | Grouping chooses from only an event's first/last covered date, placing a multi-day event that began before the range under its final day instead of its first visible day. Clamp/group spans against the loaded range and cover interior-day cases. |
| C4-apply-error | P2 | `dashboard/src/components/AgendaView.tsx:170–176`; `dashboard/src/calendar/store.ts:437–441` | Selection catches its error and resolves normally, so the UI closes the sheet even when Apply failed, leaving optimistic selection changes without an actionable error. Return explicit success/failure, keep failed selection open, and reconcile with the authoritative selection before retry. |

## Inspected boundaries that remain intact

- Calendar is opt-in and events are gated behind applied source selection. Google operations remain read-only; no Tasks, alarms, notification permission, Google writes or ESP32 changes were introduced.
- Native Calendar paths are fixed loopback POSTs reusing unbound `NO_PROXY`, no redirects, bearer-only native storage, bounded request/reply parsing and strict key/type validation. A Google grant error does not revoke the laptop bearer; only a validated current-bearer 401 does.
- Calendar caches and unsupported errors are independent of the ordinary hub snapshot. Existing snapshot schema remains unchanged for old APKs; a new APK against an old hub gets the localized Calendar unsupported state.
- Native pause/close cancels owned work, selection acknowledgement invalidates native caches, and renderer/session identities gate bridge replies. These checks do not resolve the independent dashboard ordering defects above.
- Whole-range Next up is computed server-side across cached occurrences rather than only page one, and declined events remain listed while excluded from Next up. The age defect currently undermines its display-time correctness.

## Evidence and verification limits

This review performed source/diff/history inspection and the two focused synthetic executions above. It did not rerun broad suites: the coordinator owns fresh workspace, browser, Android and packaging verification and must record its actual results after fixes. Prior test/build counts are not evidence that the uncovered scenarios pass.

No provider auth files, tokens, account emails, transcripts, private captures, real Google data, device identifiers or device state were read. No Google calls, live hub/host actions, adb operations, OS permissions, commits, pushes or publication occurred. Only this sanitized report was written by this reviewer.

Google OAuth configuration, authenticated synthetic-event named-label parity, actual phone installation and simultaneous Redmi USB/ESP32 Wi-Fi behavior remain **unverified by this review**. Software verification and device acceptance must remain separate. The coordinator reported a signing-certificate match for the candidate, but that does not establish Calendar correctness or physical acceptance.
