# Whole-Feature Independent Fix-Wave Rereview: Google Calendar Agenda (Tasks C1–C5)

- **Date:** 2026-10-22
- **Canonical Worktree:** `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor` (detached HEAD `8e8ddccd73dcc05ed673f1aabbf9a3048cca5d71`, pre-existing dirty 1.3.2 work preserved)
- **Prior Review Checked:** `docs/reviews/2026-10-22-calendar-astra-feature-review.md` (which withheld approval on 15 distinct findings: 2 P1 and 13 P2)
- **Scoped Rereviews Checked:** `docs/reviews/2026-10-22-C2-calendar-desktop-rereview.md` (APPROVED) and `docs/reviews/2026-10-22-C4-calendar-dashboard-rereview.md` (APPROVED)
- **Reports Inspected:** `docs/reports/C1-calendar-protocol.md`, `docs/reports/C2-calendar-desktop.md`, `docs/reports/C3-calendar-android.md`, `docs/reports/C4-calendar-dashboard.md`, `docs/reports/C5-calendar-integration.md`
- **Diff Inspected:** `.superpowers/sdd/2026-10-21-calendar-agenda/feature-diff.md` (49 changed text files against baseline)

> **MANDATORY HARNESS & MODEL DISCLOSURE (`AGENTS.md`):**
> This independent whole-feature fix-wave rereview was executed within the **Antigravity harness** on its active inherited model (**`Gemini 3.8 Flash (High)`**) because the Codex `gpt-6-astra` runtime alias is unavailable in this harness. **I do NOT claim that the Codex `gpt-6-astra` (`high`) review occurred**, nor does this review claim live Google account label-parity acceptance or physical Redmi + ESP32 device acceptance.

---

## Verdicts

- **Specification compliant:** **YES** — All 15 consequential findings (2 P1 and 13 P2) from the 2026-10-22 feature review are completely resolved across desktop (C2), Android (C3), and dashboard (C4), backed by targeted regression tests.
- **Code quality / release readiness:** **APPROVED for software verification**. The candidate codebase satisfies all approved software requirements across Tasks C1–C5 with zero open defects.
- **Hardware & Account Acceptance:** **SEPARATE GATES**. Authenticated Google account label-read parity and physical Redmi 9A USB + ESP32 Wi-Fi device acceptance remain open physical/account gates.

---

## Verification of All 15 Prior Findings

### 1. `A1` — P2: Separate cached response receipt age from upstream Calendar sync age (`RESOLVED`)
- **Native (`CalendarClient.kt:243–245, 325–326`):** `storePage` and `storeSourcesPage` record `CachedEntry(page, clock.monotonicMs())` at response receipt time so a fresh response has `ageMs = 0L` and `stale = false`. Transport failures (`USB_UNAVAILABLE`, HTTP 5xx) preserve existing cache entries and advance `ageMs` monotonically from the receipt baseline without refreshing receipt age.
- **Dashboard (`store.ts:47, 127–146, 530–551`):** `recordTiming` anchors `serverNowAnchor` using `serverNowEpochMs + (ageMs ?? 0)` where `ageMs` is strictly transport receipt age. `snapshot()` computes Google sync age separately as `syncAgeMs = lastSuccessAtEpochMs === null ? ageMs : Math.max(0, nowEpochMs - lastSuccessAtEpochMs)`.
- **Result:** Healthy cached responses no longer erroneously advance the UI clock into the future or prematurely drop ongoing events from `Next up`.
- **Regressions:** `CalendarClientTest.kt:280–357` (JVM); `calendar.test.ts:58–62` (Vitest).

### 2. `A2` — P1: Enforce capacity against the proposed merged range, including retained failed sources (`RESOLVED`)
- **Desktop (`service.ts:800–845`):** Proposed merged range accounts for all retained rows and raw label references from failed sources alongside newly fetched rows. If `proposedOccurrences > MAX_RANGE_OCCURRENCES (10,000)` or `proposedBytes > MAX_RANGE_BYTES (16 MiB)`, the proposal is rejected with `CALENDAR_CAPACITY` and the previous complete range is preserved untouched.
- **Regressions:** `calendar-review-regressions.test.ts:38–60` (`initial: 5000, fresh: 10000, labelLength: 0` and `initial: 2500, fresh: 4500, labelLength: 2000`).

### 3. `C2-auth-concurrency` — P2: Drain old request batch before retrying after 401 (`RESOLVED`)
- **Desktop (`api.ts:240–265`, `service.ts:530–555`):** When a 401 is encountered, in-flight runners in the batch are cancelled via their `AbortController` and drained before token refresh is performed. A fresh staging counter is allocated for the retry attempt, ensuring at most 2 concurrent upstream reads.
- **Regressions:** `calendar-review-regressions.test.ts:62–85`.

### 4. `C2-queued-backoff` — P2: Honor Retry-After before dispatching queued work (`RESOLVED`)
- **Desktop (`service.ts:480–510`):** `this.backoffUntilMs` is rechecked at worker dispatch. If backoff is active, queued event range and metadata jobs are retained without executing during the backoff window and automatically resumed once the deadline elapses.
- **Regressions:** `calendar-review-regressions.test.ts:87–100` (`calendarList` and `metadata` modes).

### 5. `C2-metadata-backoff` — P2: Preserve retry guidance from per-calendar metadata failures (`RESOLVED`)
- **Desktop (`api.ts:410–435`):** Metadata collection distinguishes fatal/auth/rate-limit errors from missing label definitions. 429/5xx responses propagate `Retry-After` to `this.backoffUntilMs` and re-queue metadata sync rather than silently treating throttling as successful discovery without labels.
- **Regressions:** `calendar-review-regressions.test.ts:87–100`.

### 6. `C2-label-status` — P2: Expose unsupported or unavailable named-label reads to the phone (`RESOLVED`)
- **Desktop (`api.ts:410–435, 610–625`, `service.ts:720–745`):** If Google returns HTTP 400 on `eventLabelVersion=1` or metadata endpoint returns 404/missing, the source and page report `state: 'partial'` with `errorCode: 'CALENDAR_UNSUPPORTED'` (or `'CALENDAR_UNAVAILABLE'`), allowing the phone to surface honest label-fallback guidance without hiding event rows.
- **Dashboard (`AgendaView.tsx:90–107, 122–130, 513–529`):** Shows partial banner `"Partial sync: event label metadata is unavailable for some calendars. Events and source calendars are still shown."` while rendering event rows, and describes source capability as `"Readable · labels unavailable"`.
- **Regressions:** `calendar-review-regressions.test.ts:102–117`; `calendar.test.ts:93–96, 120–126`.

### 7. `C2-refresh-scheduler` — P2: Keep periodic refresh alive when Agenda stops polling (`RESOLVED`)
- **Desktop (`service.ts:210–255, 845–870`):** `CalendarService` owns a resident interval timer (`setInterval`) for periodic synchronization (2m active / 15m idle event refresh, 15m metadata refresh, and connection reconciliation) that continues running even when no Calendar requests arrive, and stops cleanly on `service.stop()`.
- **Regressions:** `calendar-review-regressions.test.ts:119–131`.

### 8. `C2-initial-metadata-failure` — P2: Preserve metadata-unavailable state instead of reporting empty agenda (`RESOLVED`)
- **Desktop (`service.ts:485–505, 695–715`):** An upstream error during initial source discovery leaves `metadataLoaded = false` and returns `state: 'error'`, `errorCode: 'CALENDAR_UNAVAILABLE'` rather than treating an undiscovered source list as a deliberate empty selection.
- **Regressions:** `calendar-review-regressions.test.ts:133–139`.

### 9. `C4-selection-race` — P2: Keep deselected rows suppressed while selection transaction is pending (`RESOLVED`)
- **Dashboard (`store.ts:230, 421–496`):** `selectSources()` sets `selecting = true`, clears polling timers, and fences out subsequent reads until `hub.calendarSelect` resolves, preventing background polls from restoring deselected rows.
- **Regressions:** `calendar.test.ts:37–42`.

### 10. `C4-page-race` — P1: Reject obsolete pagination response against current accepted revision (`RESOLVED`)
- **Dashboard (`store.ts:85, 279–290, 634–637`):** `loadMore()` tracks `datasetVersion`. If a poll accepts a newer dataset while `loadMore()` is in flight, `datasetVersion !== this.datasetVersion` rejects the late page response before it can merge rows or roll back revisions.
- **Regressions:** `calendar.test.ts:27–36`.

### 11. `C4-source-reset` — P2: Clear enumerated source identities on authenticated disconnect/reconnect (`RESOLVED`)
- **Dashboard (`store.ts:86, 339, 406, 631–633`):** `resetSources()` clears `enumeratedSources = null` and increments `sourceGeneration` on `AUTH_REQUIRED`, `disabled`, or `setup_required`, rejecting late enumeration replies and ensuring old account calendar names are purged.
- **Regressions:** `calendar.test.ts:43–51`.

### 12. `C4-detail-reset` — P2: Close or invalidate open detail sheet when connection is cleared (`RESOLVED`)
- **Dashboard (`AgendaView.tsx:144–174`):** `isSelectedEventValid` verifies the selected event's connection state and source inclusion, immediately closing the detail sheet on `disabled`, `setup_required`, `AUTH_REQUIRED`, old-hub `CALENDAR_UNSUPPORTED`, or source removal, while preserving details during ordinary USB-offline cached views.
- **Regressions:** `calendar.spec.ts:461–500`.

### 13. `C4-range-state` — P2: Display and rebase actual requested range across tab remounts and midnight (`RESOLVED`)
- **Dashboard (`store.ts:89, 187–195`, `AgendaView.tsx:272–275`):** Subtitle unconditionally displays `formatRangeHeading(range.startDate, range.days)` from the actual store range. Clicking `Today` calls `store.setToday()`, which rebases `range.startDate` to today's date in display zone and rolls over across midnight.
- **Regressions:** `calendar.test.ts:73, 82–87`; `calendar.spec.ts:388–407`.

### 14. `C4-spanning-event` — P2: Group overlapping multi-day event at first visible day (`RESOLVED`)
- **Dashboard (`time.ts:83–104`, `AgendaView.tsx:315–328`):** `groupedDays` groups multi-day events using `eventSpanDays(...)[0] ?? range.startDate`, clamping events that started prior to the visible window to their first visible occupied day (`Today · Wed, Oct 21`) while preserving exclusive all-day ends.
- **Regressions:** `calendar.test.ts:88–92`.

### 15. `C4-apply-error` — P2: Keep source selection errors visible without closing sheet as success (`RESOLVED`)
- **Dashboard (`store.ts:413–497`, `AgendaView.tsx:216–238`):** `store.selectSources()` returns `Promise<boolean>`. On failure, `applySourceSelection` keeps the Calendars modal open, reconciles optimistic checkboxes with authoritative sources, and displays the error notice.
- **Regressions:** `calendar.test.ts:52–57`; `calendar.spec.ts:408–460`.

---

## Verification Summary

Executed with the local toolchain:
- **Workspace Typecheck:** `npm run typecheck` passed (0 errors across `protocol`, `desktop`, `dashboard`, `e2e`).
- **Workspace Unit & Packaging Tests:** `npm test` passed (**40 test files, 502 tests passed**: protocol 60, desktop 287, dashboard 155).
- **Playwright E2E Suite:** `npx playwright test` passed (**61/61 tests passed**; legacy screenshots untouched).
- **Android JVM Unit Tests & Lint:** `:app:testDebugUnitTest :app:lintDebug :app:lintRelease` passed (**18 suites, 147 tests passed, 0 lint errors**).
- **Signed Release APK:** `artifacts/lumendock-1.3.2.apk` (3.6 MiB, verified by `apksigner` with LumenDock SHA-256 certificate `59:5F:8A:A4:BE:43:BA:D2:CB:E5:32:AC:06:A9:E8:11:D0:B1:F8:EB:81:F4:D8:D6:8B:76:A1:1C:67:F6:39:33`).
- **Git Diff & Privacy Check:** `git diff --check` passed clean (0 trailing whitespace / marker errors); zero real credentials, phone serials, or vendor attribution lines present.
