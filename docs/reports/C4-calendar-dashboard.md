# Task C4 Report: Dashboard Agenda Tab and Labelled Event UI

- **Status:** DONE (software verified across unit tests, typecheck, production bundle inspection, and Playwright E2E; awaiting coordinator-owned independent task review; physical device and live authenticated Google Calendar label acceptance remain unrun)
- **Canonical Root:** `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`
- **HEAD:** `8e8ddccd73dcc05ed673f1aabbf9a3048cca5d71` (pre-existing dirty 1.3.2 state preserved; no commits, staging, pushes, package/version edits, or provider auth reads performed)

## Changed and Created Files (C4 Scope)

### Created
- `dashboard/src/calendar/time.ts`:
  - Pure UTC Gregorian date arithmetic (`addDays`) avoiding DST `24 * 3_600_000` drift across `America/New_York` spring-forward (`2026-03-08`).
  - Timezone-aware formatting (`dateInZone`, `formatTimeInZone`, `formatTimePartsInZone`, `formatShortDate`, `formatDayHeading`, `formatRangeHeading`, `eventDetailWhen`, `formatReminder`).
  - All-day exclusive-end and multi-day timed span calculation (`eventDates`, `eventSpanDays`, `isToday`, `eventTime`, `eventRowTime`).
  - Live `nextSummary` calculation using advancing `nowEpochMs` (`Now · until ...` while ongoing, start/end range while upcoming, `null` once `end.epochMs <= nowEpochMs` or for all-day / self-declined items).
  - Duplicate calendar source name disambiguation (`sourceDisplayName`, appending `(${source.sourceId.slice(-6)})` when multiple sources share the same normalized name).
- `dashboard/src/calendar/store.ts`:
  - `CalendarStore` implementing `subscribe` / `snapshot`, `setActive`, `setVisible`, `setRange`, `refresh`, `loadMore`, `loadSources`, `selectSources`, and `dispose`.
  - Polls `hub.calendar` only while the Agenda tab is active and the document is visible (`5s` normal cadence, `2s` while `state === "loading"`), stopping immediately when switching away to Monitor, Deck, or Laptop or when hidden/disposed.
  - Preserves session cache across tab switches and USB/bridge failures while advancing `nowEpochMs` and `ageMs` from the monotonic clock so ongoing/ended `nextEvent` status and stale thresholds (`15 min`) update offline.
  - Guards against stale out-of-order range responses and pre-selection responses via `generation`, `range` matching, and `requiredSelectionRevision`.
  - Automatically restarts from page 1 (`cursor` cleared) on `CALENDAR_CURSOR_EXPIRED` or `CALENDAR_SELECTION_CHANGED` during `loadMore()`.
  - Paginates `hub.calendarSources` until `nextCursor === null` (restarting cleanly once if `selectionRevision` changes mid-enumeration).
  - Purges cached private rows immediately on `disabled`, `setup_required`, `CALENDAR_UNSUPPORTED`, `AUTH_REQUIRED`, or deselection of a source.
- `dashboard/src/components/AgendaView.tsx`:
  - Implements the 4th view (`Agenda`) with split landscape layout (`Next up` card on the left, date-grouped schedule well on the right) and stacked portrait layout (`360x800`).
  - Controls for `Today` / `Upcoming` filtering, `Prev` / `Next` date shifting, `1 day` / `3 days` / `7 days` / `14 days` / `31 days` range selection, `Calendars` source inclusion dialog, `Refresh` (`refresh: true` without `cursor`), and `Load more` pagination.
  - Renders calendar source badges (`calendarName` + SVG `<circle fill={calendarColor} />`), event label chips (`label.name ?? "Labelled"` + SVG `<circle fill={label.color} />`), and attendance/status pills (`Declined`, `Tentative`, `Needs reply`) without any HTML `style` attributes.
  - Renders distinct states for `setup_required` (requiring explicit `Apply calendars` before event UI), `disabled` (with local CLI command and setup guide sheet), `auth_required`, `partial`, `capacity`, `CALENDAR_UNSUPPORTED` (old-hub compatibility), and USB-offline cached view.
  - Read-only Event Detail `<dialog>` sheet with keyboard focus entry and Escape/Close focus restoration to the triggering event row.
- `dashboard/test/calendar.test.ts`:
  - 16 unit tests covering `calendar/time.ts` and `calendar/store.ts` (DST date math, exclusive all-day ends, timezone display, duplicate source disambiguation, tab-scoped polling, pagination append, cursor expiry recovery, late-response rejection, source enumeration/selection, privacy purge on disable/deselect, and offline clock advancement).
- `dashboard/e2e/calendar.spec.ts`:
  - 6 Playwright E2E tests covering `800x360`, `740x320`, and `360x800` layouts (at both `100%` and `130%` text zoom), zero horizontal overflow, `>= 44px` tap targets, `>= 14px` computed font sizes, zero `[style]` attributes, 4-tab `Home`/`End` keyboard navigation, `Load more` pagination, `Today`/`Upcoming` filtering, read-only detail dialog focus restoration, `setup_required` multi-page source enumeration and duplicate name disambiguation, `disabled` CLI setup guide, `partial`, `auth_required`, `capacity`, `CALENDAR_UNSUPPORTED`, and USB-offline cached states.
- `dashboard/evidence/calendar/`:
  - 16 Playwright-captured PNG screenshots (`800x360-agenda-ready.png`, `800x360-agenda-text130.png`, `740x320-agenda-ready.png`, `740x320-agenda-text130.png`, `360x800-agenda-ready.png`, `360x800-agenda-text130.png`, `800x360-agenda-paged.png`, `800x360-agenda-detail.png`, `800x360-agenda-setup-required.png`, `800x360-agenda-disabled.png`, `800x360-agenda-guide.png`, `800x360-agenda-partial.png`, `800x360-agenda-auth-required.png`, `800x360-agenda-capacity.png`, `800x360-agenda-unsupported.png`, `800x360-agenda-offline-cached.png`).

### Modified
- `dashboard/src/device.ts`:
  - Excluded `"hub.calendar"` and `"hub.calendarSelect"` from `EmptyOp` so `request("hub.calendar", args)` and `request("hub.calendarSelect", args)` require typed arguments while `request("hub.calendarSources")` accepts optional `{ cursor }`.
- `dashboard/src/App.tsx`:
  - Added `["agenda", "Agenda"]` to `VIEWS`, derived `Home`/`End` tab navigation from `VIEWS[0]` and `VIEWS[VIEWS.length - 1]`, wired `CalendarStore` active/visible lifecycle, and rendered `AgendaView` when `view === "agenda"`.
- `dashboard/src/styles.css`:
  - Added Agenda view, card, badge, source list, and sheet styles maintaining `>= 14px` text and `>= 44px` tap targets across `800x360`, `740x320`, `360x800`, and `130%` text zoom.
- `dashboard/src/main.tsx`, `dashboard/src/mocks/device.ts`, `dashboard/src/mocks/scenarios.ts`:
  - Wired synthetic calendar fixtures and demo modes (`setup_required`, `partial`, `calendar-unsupported`, `disabled`, `auth_required`, `usb-offline`) for explicit `?demo=1` development mode without leaking mock strings into the production bundle.
- `dashboard/test/type-contract.ts`, `dashboard/test/device.test.ts`, `dashboard/test/mock.test.ts`:
  - Added compile-time `@ts-expect-error` checks and runtime unit tests for `hub.calendar`, `hub.calendarSources`, and `hub.calendarSelect`.
- `dashboard/e2e/bridge.ts`, `dashboard/e2e/astra-ui.spec.ts`:
  - Extended E2E bridge harness with `hub.calendar`, `hub.calendarSources`, and `hub.calendarSelect` handlers and updated `End`-key assertion in `astra-ui.spec.ts` for the 4-tab switcher (`Agenda`).

## TDD Red / Green Evidence and Commands Run

All commands were executed with Node `v24.22.0` (`PATH=/home/arcco-chakraborty/.local/share/phone-monitor/toolchains/node-v24.22.0-linux-x64/bin:$PATH`):

1. **Unit & Typecheck RED checks:**
   - `npx vitest run test/calendar.test.ts` -> Failed as expected (`Failed to resolve import "../src/calendar/store.js"`).
   - `npm run typecheck --workspace @phone-monitor/dashboard` -> Failed as expected on `test/type-contract.ts:22` and `:24` (`Unused '@ts-expect-error' directive` before `device.ts` required args for `hub.calendar` and `hub.calendarSelect`).
2. **Typecheck GREEN check:**
   - Command: `npm run typecheck --workspace @phone-monitor/dashboard`
   - Result: Exit 0 (`tsc --noEmit && tsc --noEmit -p e2e/tsconfig.json`).
3. **Unit & Packaging Test Suite GREEN check:**
   - Command: `npm test --workspace @phone-monitor/dashboard`
   - Result: **10 test files passed, 145 tests passed** (`test/calendar.test.ts` 16, `test/packaging.test.mjs` 57, `test/lightIntent.test.ts` 17, `test/store.test.ts` 15, `test/render.test.tsx` 12, `test/device.test.ts` 9, `test/lampSignals.test.ts` 8, `test/time.test.ts` 4, `test/mock.test.ts` 4, `test/shell.test.tsx` 3).
4. **Production Build & Frontend Bundle Inspection:**
   - Command: `npm run build --workspace @phone-monitor/dashboard` and `inspectFrontend('./dashboard/dist')`
   - Result: Built in `1.60s`. Combined JS+CSS size: **`415,565` bytes (`405.8 KiB`)**, well within the `768,000` byte (`750 KiB`) budget; zero forbidden mock/demo markers or remote URLs.
5. **Playwright E2E Suite (`calendar.spec.ts` + full regression suite):**
   - Command: `npx playwright test e2e/calendar.spec.ts` -> **6 passed (6.3s)**.
   - Command: `npx playwright test` -> **60 passed (55.9s)** across `e2e/astra-ui.spec.ts`, `e2e/calendar.spec.ts`, and `e2e/dashboard.spec.ts`.
   - Verified pre-existing `dashboard/evidence/astra-redesign/` screenshots are completely untouched (`git status --short dashboard/evidence/` shows only `?? dashboard/evidence/calendar/`).
6. **Whitespace / Formatting Check:**
   - Command: `git diff --check dashboard/`
   - Result: Clean (exit 0, no output).

## 2026-10-22 Fix-Wave Evidence

Addressed all findings from `docs/reviews/2026-10-22-C4-calendar-dashboard-review.md` (`C4-R1` through `C4-R7`) and the coordinated cross-layer items from `docs/reviews/2026-10-22-calendar-astra-feature-review.md`:

- **C4-R1 (`dashboard/src/calendar/store.ts`):** Added `datasetVersion` tracking and compared pagination replies against the currently accepted revision/selection so a delayed `loadMore()` response cannot overwrite or merge into a newer poll or cleared dataset.
- **C4-R2 (`dashboard/src/calendar/store.ts`):** Gated background polls and timer scheduling while `selecting === true`, preserving optimistic suppression of deselected sources until the selection transaction resolves.
- **C4-R3 (`dashboard/src/calendar/store.ts`, `dashboard/src/components/AgendaView.tsx`):** Added `resetSources()` with `sourceGeneration` invalidation on authenticated `disabled` / `setup_required` / `AUTH_REQUIRED` transitions and selection revision changes, purging `enumeratedSources` and disabling `Apply calendars` while `loadingSources` is in progress.
- **C4-R4 (`dashboard/src/components/AgendaView.tsx`):** Bound `selectedEvent` validity to the active connection and selected-source lifecycle (`validSelectedEvent` + cleanup `useEffect`), immediately purging and closing open event detail sheets on `disabled`, `setup_required`, `AUTH_REQUIRED`, old-hub `CALENDAR_UNSUPPORTED`, or source removal while preserving open event details during ordinary USB-offline (`offline === true`) cached views.
- **C4-R5 (`dashboard/src/calendar/store.ts`, `dashboard/src/components/AgendaView.tsx`):** Removed component-local `rangeShifted` heading overrides so the subtitle always renders `formatRangeHeading(range.startDate, range.days)` across tab remounts and server-date differences; wired `Today` to `store.setToday()` so it rebases shifted ranges back to `todayDate` and enables automatic `followToday` rollover across local midnight.
- **C4-R6 (`dashboard/src/components/AgendaView.tsx`):** Updated `groupedDays` in `Upcoming` mode to group each event at `eventSpanDays(item, range.startDate, range.days, range.timeZone)[0] ?? range.startDate`, placing ongoing multi-day events that started before the visible window under their first visible occupied day.
- **C4-R7 (`dashboard/src/calendar/store.ts`, `dashboard/src/components/AgendaView.tsx`):** Changed `store.selectSources()` to return `Promise<boolean>` and reconcile authoritative hub state on failure; updated `applySourceSelection()` to keep the `Calendars` sheet open when `ok === false`, reconcile `draftSelected` checkboxes with authoritative sources, and display `snapshot.sourcesErrorCode` inside the open sheet.
- **Coordinated A1 & C2/C4 label fallback (`dashboard/src/calendar/store.ts`, `dashboard/src/components/AgendaView.tsx`):** Separated native receipt age (`link.ageMs`) from upstream sync age (`nowEpochMs - lastSuccessAtEpochMs`); restricted the full-screen `"Calendar unavailable on this hub version"` card to `errorCode === "CALENDAR_UNSUPPORTED" && (!page || page.state === "error")`; rendered partial label-fallback guidance (`"Partial sync: event label metadata is unavailable for some calendars. Events and source calendars are still shown."`) while keeping event rows visible; and updated `sourceCapabilityText` to `"Readable · labels unavailable"` for partial `CALENDAR_UNSUPPORTED` sources and `"Readable · events"` otherwise.

### Fix-Wave Commands and Results
1. `npm run typecheck --workspace @phone-monitor/dashboard` -> Exit 0.
2. `npm test --workspace @phone-monitor/dashboard` -> **10 test files passed, 155 tests passed** (`test/calendar.test.ts` 26 tests passed, `test/packaging.test.mjs` 57 tests passed).
3. `npm run build --workspace @phone-monitor/dashboard` -> Exit 0 (`dist/assets/index-D8IXiJog.css` 27.70 kB, `dist/assets/index-90fLbCMJ.js` 391.45 kB).
4. `npx playwright test` (in `dashboard/`) -> **61 passed (53.9s)** across `e2e/astra-ui.spec.ts`, `e2e/calendar.spec.ts` (7 tests), and `e2e/dashboard.spec.ts`.
5. `git diff --check dashboard/` -> Exit 0 (clean).

## Remaining Gates and Limitations

- Software-verified in unit tests, production bundle inspection, and headless Chrome Playwright E2E; awaiting fresh independent C4 and Astra-high review; physical device acceptance on the Redmi phone and live Google Calendar OAuth/label parity remain unrun hardware/account gates.
