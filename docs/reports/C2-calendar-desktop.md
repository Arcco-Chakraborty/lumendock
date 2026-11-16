# Task C2 Report: Desktop Google Calendar Connection, Collection, and Routes

## Summary

Implemented the desktop Google Calendar connection store, Desktop OAuth 2.0 loopback PKCE flow, bounded Google Calendar API v3 collector/normalizer, in-memory range/source caching service (`CalendarService`), laptop CLI (`calendar connect --client FILE | disconnect | status | help`), authenticated Fastify routes (`POST /v1/calendar/read`, `POST /v1/calendar/sources`, `POST /v1/calendar/select`), hub lifecycle wiring, and user setup documentation (`docs/CALENDAR.md`).

All tests use synthetic fixtures, fake HTTP handlers, and temporary directories. No real Google requests, provider credential reads, host actions, or live hub restarts were performed.

---

## Changed and Created Files (C2 Scope)

- `desktop/src/calendar/connection.ts` — Atomic connection-generation state, selection revision persistence, private credential storage (`0700`/`0600` on POSIX, verified current-user DACL via PowerShell on Windows), and generation-checked token rotation/invalidation.
- `desktop/src/calendar/oauth.ts` — Desktop OAuth client parser (ignoring embedded file URLs in favor of fixed Google endpoints `https://accounts.google.com/o/oauth2/v2/auth` and `https://oauth2.googleapis.com/token`), PKCE `S256`, `state`, ephemeral `127.0.0.1` callback server, system browser launcher, exact 3-scope verification (`calendar.events.readonly`, `calendar.calendarlist.readonly`, `calendar.calendars.readonly`), token refresh preserving omitted `refresh_token`, and `invalid_grant` invalidation.
- `desktop/src/calendar/api.ts` — Bounded Google Calendar v3 collection across all `calendarList` pages (`showHidden=true`) and `events` pages (`singleEvents=true`, `showHiddenInvitations=true`, no `eventTypes` filter, explicit IANA time-zone midnight boundaries), calendar metadata label discovery (`labelProperties.eventLabels[]`) with `eventLabelVersion=1` opt-in and automatic HTTP 400 fallback, deterministic opaque SHA-256 base64url `sourceId`/`id` hashing, identity stripping, `selfResponseStatus` extraction, default reminder resolution, 2 MiB upstream response cap, and max 2 concurrent upstream requests.
- `desktop/src/calendar/service.ts` — `CalendarService` implementing `read`, `sources`, `select`, and `stop`:
  - Immediate cache-based responses and asynchronous background collection.
  - Connection state synchronization on every operation and via a 2s watchdog while work is active.
  - Initial connect/reconnect enters `setup_required`, enumerating sources/metadata only with readable sources defaulted `selected: true` and making zero event requests until `select()` is applied; newly discovered sources after initial selection default `selected: false`.
  - Per-source atomic window replacement, partial-failure retention with prior `lastSuccessAtEpochMs`, independent metadata/label re-resolution on cached events, and `Retry-After` backoff.
  - Range-global deterministic sort (occurrence start in display time zone with all-day events ordered at display-zone midnight, then `sourceId`, then `id`) and range-global `nextEvent` across the full range (ongoing eligible timed events prioritized ahead of earliest future start, excluding self-declined and all-day events).
  - Capacity and pagination bounds: 100-source cap, 3 cached ranges / 16 MiB total cache, 10,000 occurrences / 16 MiB staging per range, 1 active + 1 latest pending range job, 50 items / 128 KiB per page, 10-minute cursor TTL bound to range + revision + selectionRevision, 15s manual refresh coalescing, and 2m active / 15m idle periodic event refresh + 15m metadata refresh.
- `desktop/src/calendar/cli.ts` — `runCalendarCommand` for `calendar connect --client FILE`, `calendar disconnect`, `calendar status`, and `calendar help`.
- `desktop/src/server.ts` — Added `POST /v1/calendar/read`, `POST /v1/calendar/sources`, and `POST /v1/calendar/select` through optional `HubOptions.calendar`, returning default `disabled` replies when absent, enforcing bearer auth and existing Host/Origin/query checks, and keeping `GET /v1/snapshot` byte-for-byte unchanged.
- `desktop/src/main.ts` — Wired `calendar` CLI subcommand and `CalendarService` startup/shutdown with `store.isPhoneActive`.
- `desktop/test/calendar-connection.test.ts` — 4 tests for cross-instance connection generations, token rotation/disconnect races, and Windows ACL verification.
- `desktop/test/calendar-oauth.test.ts` — 6 tests for client parsing, loopback PKCE S256 OAuth callback, state mismatch/cancellation/timeout/partial grant rejection, token refresh/revocation, CLI commands, and platform browser launchers.
- `desktop/test/calendar-api.test.ts` — 4 tests for DST midnight calculation, multi-page `calendarList` and label metadata normalization, recurring/cancelled/all-day/self-declined event normalization, metadata re-application, `eventLabelVersion=1` HTTP 400 fallback, and 2 MiB upstream response cap.
- `desktop/test/calendar-service.test.ts` — 6 tests for opt-out/setup_required lifecycle, >50 event pagination and range-global `nextEvent` ordering, partial failure retention, independent label refresh, new-source default-off behavior, mid-sync deselection/disconnect cancellation, 100-source and 10,000-occurrence capacity preservation, 401 refresh retry, 15s manual refresh coalescing, 2m/15m periodic refresh, and 1-active/1-pending range queue replacement.
- `desktop/test/server.test.ts` — Added 2 tests (total 19 tests) verifying default `disabled` calendar replies, snapshot byte-for-byte invariance, bearer/origin/query checks, strict payload validation, and end-to-end `/v1/calendar/{read,sources,select}` routing.
- `docs/CALENDAR.md` — User-facing setup, OAuth client creation, 7-day Testing token lifetime vs. production choices, CLI commands, label fallback notes, and capacity/disconnect behavior.

---

## Red / Green TDD Evidence

1. **`desktop/test/calendar-oauth.test.ts`:**
   - **Red:** `npm --workspace @phone-monitor/desktop run test -- test/calendar-oauth.test.ts` failed with `Error: Cannot find module '../src/calendar/oauth.js'`.
   - **Green:** Implemented `desktop/src/calendar/oauth.ts` and `desktop/src/calendar/cli.ts`; all 6 tests in `test/calendar-oauth.test.ts` passed.
2. **`desktop/test/calendar-api.test.ts`:**
   - **Red:** `npm --workspace @phone-monitor/desktop run test -- test/calendar-api.test.ts` failed with `Error: Cannot find module '../src/calendar/api.js'`.
   - **Green:** Implemented `desktop/src/calendar/api.ts`; all 4 tests in `test/calendar-api.test.ts` passed.
3. **`desktop/test/calendar-service.test.ts`:**
   - **Red:** `npm --workspace @phone-monitor/desktop run test -- test/calendar-service.test.ts` failed with `Error: Cannot find module '../src/calendar/service.js'`.
   - **Green:** Implemented `desktop/src/calendar/service.ts`; all 6 tests in `test/calendar-service.test.ts` passed.
4. **`desktop/test/server.test.ts`:**
   - **Red:** `npm --workspace @phone-monitor/desktop run test -- test/server.test.ts` failed (2 failed, 17 passed) with HTTP 404 on `/v1/calendar/read`, `/v1/calendar/sources`, and `/v1/calendar/select`.
   - **Green:** Implemented the three POST routes in `desktop/src/server.ts`; all 19 tests in `test/server.test.ts` passed.

---

## Verification Commands and Pass Counts

Executed with the local Node 24 toolchain (`$HOME/.local/share/phone-monitor/toolchains/node-v24.22.0-linux-x64/bin`):

1. **Full Desktop Test Suite:**
   ```bash
   npm --workspace @phone-monitor/desktop run test
   ```
   - **Result:** `27 passed (27)` test files, `276 passed (276)` tests (including 22 new calendar tests across `calendar-connection.test.ts`, `calendar-oauth.test.ts`, `calendar-api.test.ts`, `calendar-service.test.ts`, and `server.test.ts`).

2. **Desktop Typecheck:**
   ```bash
   npm --workspace @phone-monitor/desktop run typecheck
   ```
   - **Result:** `tsc --noEmit` exited `0` with zero errors.

3. **Desktop Build and CLI Smoke Check:**
   ```bash
   npm --workspace @phone-monitor/desktop run build --ignore-scripts
   node -e "require('node:fs').copyFileSync('desktop/src/win/host-helper.ps1','desktop/dist/win/host-helper.ps1')"
   node desktop/dist/main.js calendar help
   ```
   - **Result:** `tsc` exited `0`; `node desktop/dist/main.js calendar help` printed the expected CLI usage and exited `0`.

---

## Concerns and Known Limitations

- **Real-account label verification gate:** Google's documentation specifies `Calendars.labelProperties.eventLabels[]` and `eventLabelVersion=1`, while public discovery documents omit `eventLabelVersion=1`. The collector implements `eventLabelVersion=1` with automatic fallback on HTTP 400 and legacy `colorId` fallback; exact named-label parity remains a human-assisted real-account acceptance gate.
- **Disconnected phone cache clearing:** Running `calendar disconnect` immediately clears laptop credentials and in-memory cache; the phone clears its state on its next authenticated hub poll, or when the foreground app session ends if USB is unplugged at the time of disconnect.

---

## 2026-10-22 Fix-Wave Evidence

Addressed all 7 consequential desktop Calendar findings from `docs/reviews/2026-10-22-C2-calendar-desktop-review.md` and `docs/reviews/2026-10-22-calendar-astra-feature-review.md`:

1. **`A2` / Finding 1 — Validate combined retained-and-refreshed range before publishing (`desktop/src/calendar/api.ts`, `desktop/src/calendar/service.ts`):**
   - Included raw label-reference bytes (`[id, ref]`) in staging byte accounting (`fetchCalendarSourceEvents`) and cached window byte accounting (`sourceWindowBytes`).
   - Built a proposed merged `bySource` map (combining newly fetched source windows and retained prior source windows) in both `executeRangeSync` and `executeMetadataSync`, and checked combined occurrence count (`<= 10,000`) and serialized bytes (`<= 16 MiB`) before mutating `rangeEntry.bySource` or `sourceStates`. On a breach, the previous complete range data and `lastSuccessAtEpochMs` are preserved intact and `state: 'capacity'`, `errorCode: 'CALENDAR_CAPACITY'` are reported.
2. **`C2-auth-concurrency` / Finding 2 — Drain and cancel failed 401 request batch before retry (`desktop/src/calendar/api.ts`, `desktop/src/calendar/service.ts`):**
   - Updated `runWithConcurrency` so workers stop taking new items after the first failure and `await Promise.all(runners)` drains all in-flight runners before throwing `firstError`.
   - `callWithTokenRefresh` aborts the per-attempt `AbortController` before refreshing credentials and creates a fresh `AbortController` and fresh `RangeStagingBudget` inside the retry callback, guaranteeing at most 2 concurrent upstream requests and isolated staging counters across attempts.
3. **`C2-queued-backoff` / Finding 3 & `C2-metadata-backoff` / Finding 4 — Preserve metadata `Retry-After` and enforce backoff at dispatch (`desktop/src/calendar/api.ts`, `desktop/src/calendar/service.ts`):**
   - `fetchCalendarSourcesAndMetadata` rethrows `CALENDAR_CAPACITY` in addition to `CALENDAR_AUTH_REQUIRED`, and preserves `labelMetadataErrorCode: 'CALENDAR_UNAVAILABLE'` and `labelMetadataRetryAfterMs` on nonfatal per-calendar metadata errors.
   - `executeMetadataSync` records `backoffUntilMs` from both `calendarList` and per-calendar metadata `Retry-After` headers and re-queues `pendingMetadataSync = true` so transient metadata errors recover after the deadline.
   - `runWorkerLoop` checks `this.nowMs() < this.backoffUntilMs` before dispatching any queued metadata or range work (retaining `pendingRangeRequest`), and `maybeSchedulePeriodicSync` resumes pending metadata/range work via `ensureWorkerRunning()` once `now >= this.backoffUntilMs`.
4. **`C2-label-status` / Finding 5 — Surface unsupported or unavailable named-label state honestly (`desktop/src/calendar/api.ts`, `desktop/src/calendar/service.ts`):**
   - Distinguished supported-empty label definitions (`labelProperties: { eventLabels: [] }`) from missing metadata (`labelMetadataErrorCode: 'CALENDAR_UNSUPPORTED'`), failed metadata (`labelMetadataErrorCode: 'CALENDAR_UNAVAILABLE'`), and `eventLabelVersion=1` HTTP 400 fallback (`labelOptInFallback = true` -> `'CALENDAR_UNSUPPORTED'`).
   - Published affected source and range states as `state: 'partial'` with the corresponding `errorCode` (`CALENDAR_UNSUPPORTED` or `CALENDAR_UNAVAILABLE`) while preserving all events and calendar badges.
5. **`C2-refresh-scheduler` / Finding 6 — Service-owned periodic refresh and connection reconciliation scheduler (`desktop/src/calendar/service.ts`):**
   - Kept the unref'd 2s `watchdogTimer` running for the lifetime of `CalendarService` (started in constructor and cleared in `stop()`) so idle 15-minute metadata/event refreshes, backoff resumption, and cross-process CLI connect/disconnect reconciliation occur even when the phone is not polling Calendar routes.
6. **`C2-initial-metadata-failure` / Finding 7 — Preserve metadata-unavailable state instead of empty available agenda (`desktop/src/calendar/service.ts`):**
   - Guarded `executeRangeSync` and `read()` / `recomputeRangeFromSources()` so an unloaded or errored `calendarList` discovery reports `error` (`CALENDAR_UNAVAILABLE`) when no prior events exist (or `partial` when retaining prior events) rather than treating an undiscovered source list as zero selected sources.

### Fix-Wave Verification Commands and Counts

1. **Regression Suite (`desktop/test/calendar-review-regressions.test.ts`):**
   - `11 passed (11)` tests covering all 7 findings (combined retained/fresh occurrence and byte capacity, 401 batch drain and staging reset, `calendarList` and per-calendar metadata `Retry-After` dispatch hold and post-deadline resumption, `fallback`/`metadataFailure`/`metadataMissing`/`empty` label states, fake-timer idle refresh + CLI reconnect + `stop()` timer cleanup, and cold-start `calendarList` 503 error preservation).
2. **Full Desktop Test Suite:**
   ```bash
   npm --workspace @phone-monitor/desktop run test
   ```
   - **Result:** `28 passed (28)` test files, `287 passed (287)` tests.
3. **Desktop Typecheck & Build:**
   ```bash
   npm --workspace @phone-monitor/desktop run typecheck
   npm --workspace @phone-monitor/desktop run build
   ```
   - **Result:** Both commands exited `0` with zero errors.

