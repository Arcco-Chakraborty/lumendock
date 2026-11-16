# C4 Fresh Independent Dashboard Fix-Wave Rereview

- **Date:** 2026-10-22
- **Canonical Worktree:** `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor` (detached HEAD `8e8ddccd73dcc05ed673f1aabbf9a3048cca5d71`, pre-existing dirty 1.3.2 state preserved)
- **Reviewer Runtime Disclosure:** Within this Antigravity harness, this independent C4 rereview ran on the active harness model (`Gemini 4 Argon (High)`) rather than the Codex `gpt-6.1-sol` runtime alias.
- **Prior Reviews Checked:** `docs/reviews/2026-10-22-C4-calendar-dashboard-review.md` and `docs/reviews/2026-10-22-calendar-astra-feature-review.md`
- **Artifacts Inspected:** `docs/reports/C4-calendar-dashboard.md`, `.superpowers/sdd/2026-10-21-calendar-agenda/task-4-diff.md`, `dashboard/src/calendar/store.ts`, `dashboard/src/calendar/time.ts`, `dashboard/src/components/AgendaView.tsx`, `dashboard/test/calendar.test.ts`, and `dashboard/e2e/calendar.spec.ts`.

## Verdicts

- **Specification compliant:** **YES** — All 7 prior C4 findings (`C4-R1` through `C4-R7`) and the coordinated cross-layer items (`A1` receipt-age vs. upstream sync age and `C2-label-status` honest label-fallback wording) are completely resolved and backed by unit and E2E regression tests.
- **Code quality approved:** **YES** — Zero remaining blockers or defects in the C4 dashboard scope.
- **Device accepted / live Google labels verified:** **NOT ASSESSED** — Software verification only. Physical Redmi 9A USB + ESP32 Wi-Fi acceptance and live authenticated Google Calendar label parity remain separate hardware/account gates.

## Verification of Prior Findings

### 1. `C4-R1` — [P1] Reject an obsolete pagination response against the current accepted revision (`RESOLVED`)
- **Implementation (`dashboard/src/calendar/store.ts:85, 208, 253, 266, 279–290, 315, 329, 388, 422, 634–637`):**
  - `CalendarStore` tracks `datasetVersion` and increments it whenever the range changes (`changeRange`), selection changes (`selectSources`, `loadSources` revision change), or `readPage` accepts a new `revision`, new `selectionRevision`, or clearing state (`disabled` / `setup_required`).
  - `loadMore()` captures both `reqGen = this.generation` and `datasetVersion = this.datasetVersion` (plus `expectedRev` and `expectedSel`) before awaiting `hub.calendar`. If a normal poll replaces the dataset while `loadMore()` is in flight, `datasetVersion !== this.datasetVersion` rejects the obsolete pagination response before it can merge items or roll back `page.revision` / `selectionRevision`.
  - If the returned page itself reports `CALENDAR_CURSOR_EXPIRED`, `CALENDAR_SELECTION_CHANGED`, or a mismatched `revision` / `selectionRevision`, `loadMore()` clears `nextCursor` and `hasLoadedMore` and restarts cleanly from page 1 via `await this.readPage(false)`.
- **Regression Coverage:**
  - `dashboard/test/calendar.test.ts:27–36` (`"rejects a delayed second page after a newer poll replaces its dataset"`).

### 2. `C4-R2` — [P2] Keep deselected rows suppressed while the selection transaction is pending (`RESOLVED`)
- **Implementation (`dashboard/src/calendar/store.ts:230, 246, 337, 421–496, 516, 577`):**
  - `selectSources()` bumps `generation` and `datasetVersion`, cancels any active poll timer (`this.clearTimer()`), sets `this.selecting = true`, and optimistically filters `items`, `page`, `enumeratedSources`, and `pageSources`.
  - While `this.selecting` is `true`, `schedule()`, `readPage()`, `refresh()`, `loadMore()`, and `loadSources()` all fence out new reads so background polling cannot restore deselected rows before `hub.calendarSelect` resolves.
  - On success, `requiredSelectionRevision` is installed before `readPage(false)` and `schedule()` resume in `finally`. On failure, `selectSources()` clears `selecting` and explicitly reconciles with the hub via `await this.readPage(false)` and `await this.loadSources()`.
- **Regression Coverage:**
  - `dashboard/test/calendar.test.ts:37–42` (`"does not restore deselected rows while the selection reply is pending"`).

### 3. `C4-R3` — [P2] Clear enumerated source identities on authenticated disconnect/reconnect (`RESOLVED`)
- **Implementation (`dashboard/src/calendar/store.ts:86, 339, 352, 399, 406, 414, 567, 631–633, 694–700`; `dashboard/src/components/AgendaView.tsx:408`):**
  - `resetSources()` increments `sourceGeneration`, clears `enumeratedSources = null`, resets `sourcesState` and `sourcesErrorCode`, and clears `loadingSources`.
  - `resetSources()` is invoked on `AUTH_REQUIRED` (`applyLinkFailure`) and in `readPage()` whenever `selectionRevision` changes or `data.state` transitions into `disabled` or `setup_required`.
  - `loadSources()` checks `sourceGen !== this.sourceGeneration` across awaits so late enumerations from a prior connection cannot repopulate `enumeratedSources`.
  - Both `store.selectSources()` and the `Apply calendars` button in `AgendaView.tsx:408` are disabled while `loadingSources` is true (`disabled={snapshot.selecting || snapshot.loadingSources}`).
- **Regression Coverage:**
  - `dashboard/test/calendar.test.ts:43–51` (`"purges old enumerated identities on authenticated %s and rejects a late enumeration"` for both `disabled` and `setup_required`).

### 4. `C4-R4` — [P2] Close or invalidate an open detail sheet when its connection is cleared (`RESOLVED`)
- **Implementation (`dashboard/src/components/AgendaView.tsx:144–174, 808`):**
  - `isSelectedEventValid` verifies that `selectedEvent !== null`, `state !== "disabled"`, `state !== "setup_required"`, `!hubUnsupported`, `snapshot.errorCode !== "AUTH_REQUIRED"`, the event's source remains selected in `sources`, and (unless `snapshot.offline`, `page === null`, or `page.state === "loading"`) the event still exists in `items` or `page.nextEvent`.
  - When `isSelectedEventValid` becomes `false`, `validSelectedEvent` immediately becomes `null` and the cleanup `useEffect` clears `selectedEvent` and closes the detail modal (`setModalKind(null)`).
  - Ordinary USB-offline cached views (`snapshot.offline === true`) preserve the open detail sheet and cached event details.
- **Regression Coverage:**
  - `dashboard/e2e/calendar.spec.ts:461–500` (verifies open event detail modal remains visible with `"Synthetic DST review"` across `USB_UNAVAILABLE` offline state, then closes and purges when an authenticated `disabled` state arrives).

### 5. `C4-R5` — [P2] Display and rebase the actual requested range across tab remounts and midnight (`RESOLVED`)
- **Implementation (`dashboard/src/calendar/store.ts:89, 100, 187–195, 578–584`; `dashboard/src/components/AgendaView.tsx:272–275, 436`):**
  - Removed component-local `rangeShifted` state; `.agenda-subtitle` unconditionally renders `formatRangeHeading(range.startDate, range.days)` from the store's actual range across tab switches/remounts and server-date differences.
  - Clicking `Today` calls `store.setToday()`, which sets `followToday = true` and rebases `range.startDate` to `dateInZone(this.snapshot().nowEpochMs, this.range.timeZone)`.
  - While `followToday` is active (by default or after clicking `Today`), `readPage()` checks whether `dateInZone(this.snapshot().nowEpochMs, this.range.timeZone) !== this.range.startDate` and automatically rolls the range forward across local midnight.
- **Regression Coverage:**
  - `dashboard/test/calendar.test.ts:73` (`"rebases a shifted range on setToday and rolls over across local midnight"`).
  - `dashboard/test/calendar.test.ts:82–87` (`"renders the actual requested range even when server today differs or the view remounts"`).
  - `dashboard/e2e/calendar.spec.ts:388–407` (shifts to `Mar 15 to Mar 21`, switches to `Monitor` tab and back to `Agenda`, verifies heading stays `Mar 15 to Mar 21`, clicks `Today`, and verifies heading rebases to `Mar 8 to Mar 14`).

### 6. `C4-R6` — [P2] Group an overlapping multi-day event at its first visible day (`RESOLVED`)
- **Implementation (`dashboard/src/calendar/time.ts:83–104`; `dashboard/src/components/AgendaView.tsx:315–328`):**
  - `groupedDays` in `Upcoming` mode computes `dayKey` using `eventSpanDays(item, range.startDate, range.days, range.timeZone)[0] ?? range.startDate`, clamping multi-day events that started prior to `range.startDate` to their first visible occupied day in the active range while preserving exclusive all-day ends.
- **Regression Coverage:**
  - `dashboard/test/calendar.test.ts:88–92` (`"groups an ongoing spanning all-day event on the first visible occupied day"`).

### 7. `C4-R7` — [P2] Keep source selection errors visible and do not close the sheet as success (`RESOLVED`)
- **Implementation (`dashboard/src/calendar/store.ts:413–497`; `dashboard/src/components/AgendaView.tsx:216–238, 356–361`):**
  - `store.selectSources()` returns `Promise<boolean>`. On error, it resets `selecting = false`, clears `enumeratedSources`, awaits authoritative `readPage(false)` and `loadSources()`, sets `errorCode` and `sourcesErrorCode` to the failure code, and returns `false`.
  - `applySourceSelection()` in `AgendaView.tsx` only closes the `Calendars` modal when `ok === true`. When `ok === false`, the sheet remains open, `draftSelected` reconciles with the authoritative `store.snapshot().sources`, and `snapshot.sourcesErrorCode` is rendered inside the sheet (`Source list notice: ...`).
- **Regression Coverage:**
  - `dashboard/test/calendar.test.ts:52–57` (`"returns failed Apply as failure and reconciles optimistic rows and checkboxes"`).
  - `dashboard/e2e/calendar.spec.ts:408–460` (unchecks `Synthetic Personal`, injects `CALENDAR_SELECTION_CHANGED` on `hub.calendarSelect`, clicks `Apply calendars`, and verifies the dialog remains open displaying `CALENDAR_SELECTION_CHANGED` and re-checks `Synthetic Personal`).

### 8. Coordinated Cross-Layer `A1` — Separate cached response receipt age from upstream Calendar sync age (`RESOLVED`)
- **Implementation (`dashboard/src/calendar/store.ts:47, 127–146, 530–551`):**
  - `recordTiming` anchors `serverNowAnchor` using `serverNowEpochMs + (ageMs ?? 0)` where `link.ageMs` is strictly the native response receipt age (0 ms on a fresh USB read).
  - `snapshot()` computes upstream sync age separately as `syncAgeMs = lastSuccessAtEpochMs === null ? ageMs : Math.max(0, nowEpochMs - lastSuccessAtEpochMs)` and evaluates staleness against `STALE_THRESHOLD_MS = 180_000` (3 minutes, accommodating the 2-minute active poll interval).
  - Normal cached reads no longer advance `nowEpochMs` into the future or prematurely drop ongoing `Next up` events.
- **Regression Coverage:**
  - `dashboard/test/calendar.test.ts:58–62` (`"keeps source sync age separate from a fresh native receipt and retains an ongoing event"`).

### 9. Coordinated Cross-Layer `C2-label-status` — Honest label-fallback wording (`RESOLVED`)
- **Implementation (`dashboard/src/components/AgendaView.tsx:90–107, 122–130, 513–529`):**
  - `sourceCapabilityText` no longer claims `"Readable · events and labels"`; it renders `"Readable · labels unavailable"` when `source.state === "partial" && source.errorCode === "CALENDAR_UNSUPPORTED"` and neutral `"Readable · events"` otherwise.
  - `hubUnsupported` is restricted to `errorCode === "CALENDAR_UNSUPPORTED" && (!page || page.state === "error")`, while partial `CALENDAR_UNSUPPORTED` renders the warning banner `"Partial sync: event label metadata is unavailable for some calendars. Events and source calendars are still shown."` without hiding event rows.
- **Regression Coverage:**
  - `dashboard/test/calendar.test.ts:93–96` (`"shows label fallback guidance without hiding partial event rows or claiming hub incompatibility"`).
  - `dashboard/test/calendar.test.ts:120–126` and `dashboard/e2e/calendar.spec.ts:412–413` (asserts `"Readable · events"` and `"Readable · labels unavailable"`, and absence of `"Readable · events and labels"`).

## Verification Commands Run by Rereviewer

- `PATH=/home/arcco-chakraborty/.local/share/phone-monitor/toolchains/node-v24.22.0-linux-x64/bin:$PATH npx vitest run dashboard/test/calendar.test.ts` -> **1 test file passed, 26 tests passed**.
- `git diff --check dashboard/` -> **Clean (exit 0)**.
