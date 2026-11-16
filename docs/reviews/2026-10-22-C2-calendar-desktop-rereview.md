# C2 Desktop Calendar Independent Rereview — 2026-10-22

- **Date:** 2026-10-22
- **Scope:** Fresh independent rereview of Task C2 (desktop Google Calendar connection, bounded API collector, caching service, CLI, routes, and regression tests) in `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`.
- **Reviewer / Harness Model Note:** Executed within the Antigravity harness on the active harness model (**`Gemini 4 Argon (High)`**) rather than the Codex `gpt-6.1-sol` runtime alias.
- **Prior Reviews Inspected:**
  - `docs/reviews/2026-10-22-C2-calendar-desktop-review.md`
  - `docs/reviews/2026-10-22-calendar-astra-feature-review.md`
- **Artifacts Inspected:**
  - `docs/reports/C2-calendar-desktop.md`
  - `.superpowers/sdd/2026-10-21-calendar-agenda/task-2-diff.md`
  - `desktop/src/calendar/api.ts`, `desktop/src/calendar/service.ts`, `desktop/src/calendar/connection.ts`, `desktop/src/calendar/oauth.ts`, `desktop/src/calendar/cli.ts`, `desktop/src/main.ts`, `desktop/src/server.ts`
  - `desktop/test/calendar-review-regressions.test.ts`, `desktop/test/calendar-service.test.ts`, `desktop/test/calendar-api.test.ts`, `desktop/test/calendar-oauth.test.ts`, `desktop/test/calendar-connection.test.ts`, `desktop/test/server.test.ts`

---

## Verdict

- **Specification compliant: YES.** All 7 consequential findings from `docs/reviews/2026-10-22-C2-calendar-desktop-review.md` (including `A2` and the 6 `C2-*` rows in `docs/reviews/2026-10-22-calendar-astra-feature-review.md`) are completely resolved in production code and covered by deterministic regression tests in `desktop/test/calendar-review-regressions.test.ts`.
- **Code quality approved: YES.**
- **Verification scope:** Software verification only (synthetic fixtures, fake HTTP handlers, fake timers, and temporary directories). No live Google OAuth/account/named-label parity, actual phone behavior, or physical device acceptance is claimed by this rereview.

---

## Verification of Prior C2 Findings

### 1. [P1] `A2` / Finding 1 — Validate the combined retained-and-refreshed range before publishing
- **Status:** **RESOLVED**
- **Implementation (`desktop/src/calendar/api.ts:691–698`, `desktop/src/calendar/service.ts:162–169, 631–647, 843–882`):**
  - `fetchCalendarSourceEvents` accounts for both normalized event bytes and raw label-reference entry bytes (`[id, ref]`) in `RangeStagingBudget`.
  - `sourceWindowBytes` sums both `win.events` and `[...win.rawLabelRefs]` across all source windows in a candidate map.
  - Both `executeRangeSync` and `executeMetadataSync` construct a candidate `proposed` map merging newly fetched source windows with retained prior source windows from failed sources, then check combined occurrence count (`<= 10,000`) and combined byte size (`<= 16 MiB`) **before** mutating `rangeEntry.bySource`, `rangeEntry.lastSuccessAtEpochMs`, or `this.sourceStates`.
  - On a capacity breach, the previous complete range and its `lastSuccessAtEpochMs` remain intact and `state: 'capacity'`, `errorCode: 'CALENDAR_CAPACITY'` are published. Because no single range can be published above `MAX_CACHE_BYTES`, `evictRangesIfNeeded` cannot leave a sole pinned range above the 16 MiB ceiling.
- **Regression coverage (`desktop/test/calendar-review-regressions.test.ts:38–60`):**
  - Parameterized test covers both combined occurrence overflow (`initial: 5000, fresh: 10000, labelLength: 0` with source B returning 503 -> 15,000 combined occurrences rejected) and combined byte overflow including label references (`initial: 2500, fresh: 4500, labelLength: 2000`), verifying `state === 'capacity'`, `errorCode === 'CALENDAR_CAPACITY'`, preserved `lastSuccessAtEpochMs`, and intact prior events across all pages (`count === initial * 2`).

### 2. [P2] `C2-auth-concurrency` / Finding 2 — Drain or cancel the old request batch before retrying after 401
- **Status:** **RESOLVED**
- **Implementation (`desktop/src/calendar/api.ts:260–287`, `desktop/src/calendar/service.ts:538–595, 753–782`):**
  - `runWithConcurrency` sets `failed = true` on the first error so runners stop taking additional items, and awaits `Promise.all(runners)` to drain all in-flight runners before throwing `firstError`.
  - `callWithTokenRefresh` aborts the first attempt's `AbortController` before refreshing tokens and allocates a fresh `AbortController` for the retry attempt.
  - `executeRangeSync` allocates a fresh `RangeStagingBudget` inside the `callWithTokenRefresh` callback so staging counts and bytes from the aborted/failed attempt are isolated from the retry.
- **Regression coverage (`desktop/test/calendar-review-regressions.test.ts:62–85`):**
  - Tests 3 sources (`['a', 'b', 'c']`) where `/a/` returns 401 with the old token while `/b/` is held open on a gate, confirming token refresh does not start until `/b/` drains (`refreshedBeforeDrain === false`), concurrent upstream `/events` requests never exceed 2 (`maxActive <= 2`), and per-attempt staging resets cleanly.

### 3. [P2] `C2-queued-backoff` / Finding 3 — Honor `Retry-After` before dispatching already queued work
- **Status:** **RESOLVED**
- **Implementation (`desktop/src/calendar/service.ts:500–536, 885–910`):**
  - `runWorkerLoop` checks `this.nowMs() < this.backoffUntilMs` at the top of every iteration and after initial `!this.metadataLoaded` metadata sync before dispatching `pendingRangeRequest`, retaining `this.pendingRangeRequest` when backoff is active.
  - `maybeSchedulePeriodicSync` (invoked by the 2s service watchdog and read paths) checks `now >= this.backoffUntilMs` and calls `ensureWorkerRunning()` when `pendingMetadataSync` or `pendingRangeRequest` is waiting, resuming queued work after the backoff deadline expires.
- **Regression coverage (`desktop/test/calendar-review-regressions.test.ts:87–101`):**
  - Verifies that when manual `refresh: true` queues metadata + range sync and metadata returns HTTP 429 with `Retry-After: 600`, zero `/events` requests are dispatched during the 600-second window (`events === 0` at +20s and +599s) and the queued range sync executes once the 600-second deadline passes (`events === 1`, `state === 'available'`).

### 4. [P2] `C2-metadata-backoff` / Finding 4 — Preserve retry guidance from per-calendar metadata failures
- **Status:** **RESOLVED**
- **Implementation (`desktop/src/calendar/api.ts:446–461`, `desktop/src/calendar/service.ts:615–621`):**
  - `fetchCalendarSourcesAndMetadata` rethrows `CALENDAR_CAPACITY` in addition to `CALENDAR_AUTH_REQUIRED`, and on nonfatal per-calendar metadata errors records `labelMetadataErrorCode = 'CALENDAR_UNAVAILABLE'` and `labelMetadataRetryAfterMs = err.retryAfterMs`.
  - `executeMetadataSync` inspects `source.labelMetadataRetryAfterMs` across all discovered sources, updates `this.backoffUntilMs = Math.max(this.backoffUntilMs, finishNow + source.labelMetadataRetryAfterMs)`, and sets `this.pendingMetadataSync = true` so metadata recovery is scheduled after the backoff window.
- **Regression coverage (`desktop/test/calendar-review-regressions.test.ts:87–101`):**
  - The `'metadata'` mode of the `Retry-After` regression test returns HTTP 429 (`Retry-After: 600`) from `/calendars/a` after `/calendarList` succeeds, confirming `backoffUntilMs` blocks the queued `/events` request for the full 600s and recovers afterward.

### 5. [P2] `C2-label-status` / Finding 5 — Expose unsupported or unavailable named-label reads to the phone
- **Status:** **RESOLVED**
- **Implementation (`desktop/src/calendar/api.ts:424–461`, `desktop/src/calendar/service.ts:370–374, 410–412, 450–453, 637–639, 853–854, 1346–1347`):**
  - Readable calendars with an array `labelProperties.eventLabels` (including `[]`) set `labelMetadataAvailable = true` with no error code.
  - Readable calendars where `labelProperties.eventLabels` is absent set `labelMetadataErrorCode = 'CALENDAR_UNSUPPORTED'`.
  - Readable calendars where `/calendars/{id}` fails set `labelMetadataErrorCode = 'CALENDAR_UNAVAILABLE'`.
  - Event fetches that fall back from `eventLabelVersion=1` on HTTP 400 set `labelOptInFallback = true`, which `executeRangeSync` maps to window `state: 'partial'`, `errorCode: 'CALENDAR_UNSUPPORTED'`.
  - `recomputeRangeFromSources`, `toProtocolSource`, and `sources()` propagate `state: 'partial'` and `CALENDAR_UNSUPPORTED` / `CALENDAR_UNAVAILABLE` to both source status entries and the page-level state/errorCode while preserving all events and calendar badges.
- **Regression coverage (`desktop/test/calendar-review-regressions.test.ts:103–118`):**
  - Parameterized across `'fallback'`, `'metadataFailure'`, `'metadataMissing'`, and `'empty'`, verifying event and source badge preservation alongside exact `state` (`'partial'` vs `'available'`) and `errorCode` (`'CALENDAR_UNSUPPORTED'`, `'CALENDAR_UNAVAILABLE'`, or `null`).

### 6. [P2] `C2-refresh-scheduler` / Finding 6 — Keep periodic refresh alive when Agenda stops polling
- **Status:** **RESOLVED**
- **Implementation (`desktop/src/calendar/service.ts:221, 228–263`):**
  - `CalendarService` starts its unref'd 2-second `watchdogTimer` in the constructor and keeps it running until `stop()` is called.
  - Each tick runs `syncConnectionState()`, `maybeSchedulePeriodicSync(entry)`, and `ensureWorkerRunning()` if work is pending, enabling 15-minute idle refreshes, post-backoff resumption, and CLI connect/disconnect reconciliation without requiring incoming Calendar HTTP requests, while making zero network requests when disconnected.
- **Regression coverage (`desktop/test/calendar-review-regressions.test.ts:120–132`):**
  - Uses `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })` to verify 16-minute idle refresh execution without `read()`/`sources()` calls, cross-store disconnect and reconnect detection via the timer, and clean timer teardown (`vi.getTimerCount() === 0`) on `service.stop()`.

### 7. [P2] `C2-initial-metadata-failure` / Finding 7 — Preserve metadata-unavailable state instead of reporting an empty successful agenda
- **Status:** **RESOLVED**
- **Implementation (`desktop/src/calendar/service.ts:386–390, 514–522, 1205–1207`):**
  - `runWorkerLoop` refuses to dispatch `executeRangeSync` when `!this.metadataLoaded`, retaining `pendingRangeRequest` and breaking if initial metadata sync failed.
  - `recomputeRangeFromSources` checks `!this.metadataLoaded || this.metadataState === 'error' || this.metadataState === 'capacity'` prior to the `selectedReadable.length === 0` branch.
  - `read()` computes `finalState` and `finalError` from `this.metadataState === 'error' || !this.metadataLoaded`, returning `state: 'error'`, `errorCode: 'CALENDAR_UNAVAILABLE'`, `lastSuccessAtEpochMs: null` on cold-start metadata failure (or `state: 'partial'` when prior events exist).
- **Regression coverage (`desktop/test/calendar-review-regressions.test.ts:134–140`):**
  - Simulates cold start with an existing applied selection on disk and HTTP 503 on `/calendarList`, asserting `page.state === 'error'`, `page.errorCode === 'CALENDAR_UNAVAILABLE'`, and `page.lastSuccessAtEpochMs === null`.

---

## Independent Verification Executed

Ran the focused C2 test files and desktop typecheck using the repo-local Node 24.22.0 toolchain:

```bash
PATH="$HOME/.local/share/phone-monitor/toolchains/node-v24.22.0-linux-x64/bin:$PATH" \
  npm --workspace @phone-monitor/desktop run test -- \
  test/calendar-connection.test.ts \
  test/calendar-oauth.test.ts \
  test/calendar-api.test.ts \
  test/calendar-service.test.ts \
  test/calendar-review-regressions.test.ts \
  test/server.test.ts

PATH="$HOME/.local/share/phone-monitor/toolchains/node-v24.22.0-linux-x64/bin:$PATH" \
  npm --workspace @phone-monitor/desktop run typecheck
```

- **Test result:** `6 passed (6)` test files, `50 passed (50)` tests (including `11 passed (11)` in `test/calendar-review-regressions.test.ts`).
- **Typecheck result:** `tsc --noEmit` exited `0` with zero errors.
