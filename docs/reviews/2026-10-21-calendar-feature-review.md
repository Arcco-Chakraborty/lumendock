# Whole-Feature Independent Review: Google Calendar Agenda (Tasks C1–C5)

- **Date:** 2026-10-21 (Asia/Kolkata)
- **Canonical Root:** `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor` (detached `HEAD` at `8e8ddccd73dcc05ed673f1aabbf9a3048cca5d71`, pre-existing dirty `1.3.2` baseline preserved)
- **Scope:** End-to-end whole-feature specification compliance, cross-layer contract alignment, security/privacy boundaries, and code quality across C1 (`@phone-monitor/protocol`), C2 (`@phone-monitor/desktop` + `docs/CALENDAR.md`), C3 (`android`), C4 (`@phone-monitor/dashboard`), and C5 integration (`README.md`, `docs/PRD.md`, root `package.json`).

> **MANDATORY HARNESS & MODEL DISCLOSURE (`AGENTS.md`):**
> `AGENTS.md` states: *"The final PRD/plan pass and final finished-project pass must use `gpt-6-astra` with `high` reasoning effort, as the user explicitly requested. Do not silently substitute another model or claim that review occurred if the current harness cannot run it."*
> This independent whole-feature review was executed within the **Antigravity harness** on its active inherited model (**`Gemini 4 Argon (High)`**) because the Codex `gpt-6-astra` runtime alias is unavailable in this harness. **This review does NOT claim that the Codex `gpt-6-astra` review occurred**, nor does it claim live Google account label-parity acceptance or physical Redmi + ESP32 device acceptance.

---

## Verdicts

- **Specification compliant:** **YES** (for all software-verifiable requirements across Tasks C1–C5)
- **Code quality approved:** **YES**
- **Consequential findings:** **None.** Zero blocking or non-blocking defects found across the 48 changed/created files in `.superpowers/sdd/2026-10-21-calendar-agenda/feature-diff.md`.
- **Model & hardware gates remaining:** Final Codex `gpt-6-astra` (`high`) review gate (unavailable in this harness), human-assisted live Google OAuth + synthetic labelled-event parity check, and physical Redmi 9A USB + ESP32 Wi-Fi simultaneous routing acceptance.

---

## Cross-Layer Verification Against Plan Review Focus Items

### 1. Cross-Layer Protocol, Route, Transport, and Store Agreement (`C1` ↔ `C2` ↔ `C3` ↔ `C4`)

- **Protocol (`packages/protocol/src/calendar.ts:1–86`, `packages/protocol/src/schema.ts:2, 14–22, 98–99, 110–151`):**
  - Defines strict Zod schemas and inferred TypeScript types for `CalendarRangeRequest`, `CalendarSourcesRequest`, `CalendarSelectRequest`, `CalendarErrorCode`, `CalendarState`, `CalendarMoment`, `CalendarEvent`, `CalendarSource`, `CalendarPage`, `CalendarSourcesPage`, and `CalendarSelectReply`.
  - Composes `CalendarLinkSnapshotSchema = LinkSnapshotSchema(CalendarPageSchema)` and `CalendarSourcesLinkSnapshotSchema = LinkSnapshotSchema(CalendarSourcesPageSchema)` in `schema.ts` with no reverse import from `schema.ts` into `calendar.ts`.
  - Wires `hub.calendar`, `hub.calendarSources`, and `hub.calendarSelect` into `BridgeArgsSchemas`, `BridgeOpSchema`, `BridgeRequestSchema`, `BridgeReplyDataSchemas`, `BridgeReplySchemaFor`, and `BridgeReplySchema`.
- **Desktop Hub (`desktop/src/server.ts:20–25, 78–124`, `desktop/src/calendar/service.ts:873–1348`):**
  - Exposes fixed `POST /v1/calendar/read`, `POST /v1/calendar/sources`, and `POST /v1/calendar/select` behind existing `Host: 127.0.0.1:8765`, `Origin === undefined`, query-string rejection, 16 KiB body limit, and bearer token authentication.
  - Validates request bodies with `CalendarRangeRequestSchema`, `CalendarSourcesRequestSchema`, and `CalendarSelectRequestSchema`, marks phone activity, and returns raw `CalendarPage`, `CalendarSourcesPage`, and `CalendarSelectReply` payloads (or `409`/`503` `{v:1,error:{code}}` on select errors).
- **Android Native (`CalendarValidator.kt:1–285`, `CalendarClient.kt:1–495`, `ProtocolValidator.kt:38, 58–61, 130–133`, `BridgeRouter.kt:17–19, 29–31, 70–72`, `LaptopClient.kt:30–36`):**
  - `CalendarValidator` enforces identical rules to `calendar.ts`: 10-char ASCII Gregorian dates with leap-year rules, IANA `timeZone` membership (`ZoneId.getAvailableZoneIds() + "UTC"`, rejecting `+`/`-` offsets), opaque IDs `[A-Za-z0-9_-]{1,80}`, cursors `[A-Za-z0-9._~-]{1,256}`, `#RRGGBB` colors, code-point limits (`256`/`120`/`50`/`40`), `refresh: true` + `cursor` mutual exclusion, unique `sourceIds` (max 100), empty-title normalization (`""` -> `"Untitled event"`), page `sources` coverage of `items`, `nextEvent` eligibility, strict key sets, and 128 KiB UTF-8 byte budgets.
  - `CalendarClient` posts to fixed `HubPath.CALENDAR_READ`, `CALENDAR_SOURCES`, and `CALENDAR_SELECT`, wraps read/sources replies in `LinkSnapshot` with monotonic `ageMs`, and returns raw `{selectionRevision}` for `hub.calendarSelect`.
- **Dashboard (`dashboard/src/device.ts:26–36`, `dashboard/src/calendar/store.ts:237–242, 325–327, 418–421`, `dashboard/test/type-contract.ts:18–28`):**
  - Excludes `"hub.calendar"` and `"hub.calendarSelect"` from `EmptyOp` so compile-time callers must pass typed arguments while `"hub.calendarSources"` accepts optional `{ cursor }`.
  - Validates every bridge reply with `BridgeReplySchemaFor(item.op)`.

### 2. Concurrent Calendar Deselection and Auth Disconnect (`C2` ↔ `C3` ↔ `C4`)

- **Desktop (`desktop/src/calendar/connection.ts:46–51`, `desktop/src/calendar/service.ts:252–341, 758–762, 1015–1060, 1239–1268`):**
  - `select()` atomically persists the new `selectionRevision` under `connection.lock`, immediately clears `rangeCursors` and `sourceCursors`, deletes deselected source entries from `rangeEntry.bySource` across all cached ranges, and recomputes `rangeEntry.events` and `rangeEntry.revision`.
  - Any in-flight `executeRangeSync` checks `this.currentGeneration !== generation || this.currentSelectionRevision !== selectionRevision` upon completion (`service.ts:760`) and discards late upstream results from older generations or selections.
  - `disconnect()` installs a fresh random disconnected `generation` and `selectionRevision` under lock before unlinking `client.json` and `tokens.json`; `syncConnectionState()` aborts `activeAbortController` and wipes all in-memory caches and cursors within at most 2 seconds (or immediately on the next request).
- **Android (`CalendarClient.kt:222–233, 357–418`):**
  - `select()` mutates state only after a validated HTTP 200 `{selectionRevision}` reply, increments `selectionEpoch`, clears `pageCache` and `sourcesCache`, and cancels all in-flight `readAndSourceCalls`. Pre-selection `read()` and `sources()` calls check `selectionEpoch == callSelectionEpoch` before caching.
  - `storePage` clears `pageCache` when `selectionRevision` changes or when `state` transitions to `disabled`, `setup_required`, or `auth_required` with empty items.
- **Dashboard (`dashboard/src/calendar/store.ts:380–451, 506–521, 560–586`):**
  - `selectSources()` increments `this.generation`, immediately filters deselected `sourceId`s out of `this.items`, `this.page.items`, and `this.page.nextEvent`, and records `this.requiredSelectionRevision = reply.selectionRevision` so any late pre-selection poll response is dropped.
  - `disabled`, `setup_required`, `CALENDAR_UNSUPPORTED`, and `AUTH_REQUIRED` immediately clear `items`, `page`, and `nextCursor`.
  - `loadMore()` automatically resets `nextCursor` and restarts from page 1 (`readPage(false)`) on `CALENDAR_CURSOR_EXPIRED`, `CALENDAR_SELECTION_CHANGED`, or a mid-pagination `revision`/`selectionRevision` change (`store.ts:256–267, 294–303`).

### 3. All-Day, DST, Overnight, Ongoing, and Confirmed-but-Declined Events & `nextEvent` Ordering (`C1` ↔ `C2` ↔ `C4`)

- **All-day and DST handling (`desktop/src/calendar/api.ts:76–125, 527–535, 567–570`, `dashboard/src/calendar/time.ts:24–31, 69–104`):**
  - All-day events retain `{kind: 'date', date: 'YYYY-MM-DD'}` with exclusive end (`start.date < end.date`). `eventDates` subtracts 1 day from `end.date` (`addDays(event.end.date, -1)`) using pure UTC `Date.UTC` calendar arithmetic so DST spring-forward/fall-back transitions (`2026-03-08` in `America/New_York`) never cause date drift.
  - Display-zone midnight boundaries on the desktop (`zonedMidnightEpochMs`, `api.ts:118–125`) use two-pass `Intl.DateTimeFormat` offset resolution across DST transitions.
  - Overnight and multi-day timed events compute covered dates from `start.epochMs` through `Math.max(start.epochMs, end.epochMs - 1)` in the requested display time zone (`time.ts:74–79`), and `eventDetailWhen` appends `(source: ${event.start.timeZone})` when the event's source zone differs from the display zone (`time.ts:195–199`).
- **Confirmed-but-self-declined invitations (`api.ts:492–505, 648–649`, `service.ts:71`, `AgendaView.tsx:58–74, 658–699`):**
  - `selfResponseStatus` is extracted solely from the attendee with `self: true` before all attendee records are stripped; event `status` (`confirmed | tentative`) remains distinct.
  - Confirmed events declined by the user remain visible in the agenda schedule with a `Declined` badge and strike-through title (`.agenda-event.is-declined`), while being excluded from `nextEvent` across protocol (`calendar.ts:67`), desktop (`service.ts:71`), Android (`CalendarValidator.kt:247`), and dashboard (`time.ts:212`).
- **Range-global sort and whole-range `nextEvent` (`service.ts:46–113, 363, 1012`, `time.ts:204–222`, `AgendaView.tsx:249–255, 541–626`):**
  - `sortRangeEvents` orders all range events deterministically by occurrence start in the display time zone (all-day dates at display-zone midnight), then `sourceId`, then `id`.
  - `computeNextEvent` scans the entire range cache (`rangeEntry.events`, independent of the 50-item page slice), selecting eligible timed events (`kind === 'time'`, `selfResponseStatus !== 'declined'`, `end.epochMs > serverNowEpochMs`) and prioritizing ongoing events (`start.epochMs <= serverNowEpochMs`) ahead of earliest future start.
  - Dashboard `nextSummary` uses the advancing monotonic `snapshot.nowEpochMs` to transition upcoming events to `Now · until ...` (`In progress`) and drop them once `end.epochMs <= nowEpochMs` even while offline.

### 4. Capacity Bounds, Rapid Date Navigation, and Snapshot Isolation (`C1` ↔ `C2` ↔ `C3` ↔ `C4`)

- **Explicit bounds enforced:**
  - **100 sources max:** `MAX_SOURCES_CAPACITY = 100` (`api.ts:6, 344`), `CalendarSelectRequestSchema` max 100 unique IDs (`calendar.ts:33`, `CalendarValidator.kt:144`). Discovery beyond 100 sources fails explicitly with `CALENDAR_CAPACITY`.
  - **50 items / 50 sources / 128 KiB per page:** `MAX_PAGE_ITEMS = 50`, `MAX_PAGE_SOURCES = 50`, `MAX_PAGE_SERIALIZED_BYTES = 128 * 1024` (`service.ts:42–44, 1109–1138`, `calendar.ts:24–28, 59–60, 70–73`, `CalendarValidator.kt:13, 231–235, 261–264`).
  - **3 cached ranges / 16 MiB total cache:** `MAX_CACHED_RANGES = 3`, `MAX_CACHE_BYTES = 16 * 1024 * 1024` with LRU eviction of unpinned ranges (`service.ts:38–39, 660–680`).
  - **10,000 occurrences / 16 MiB per-range staging:** `MAX_RANGE_OCCURRENCES = 10_000`, `MAX_STAGING_BYTES = 16 * 1024 * 1024` (`service.ts:40–41, 703–708, 775–795`, `api.ts:675–681`). Breaching staging or upstream capacity transitions the range to `capacity` (`CALENDAR_CAPACITY`) while preserving any previous complete `bySource` and `events` data in `rangeEntry`.
  - **2 MiB upstream Google response cap:** `MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024` enforced via streaming reader and `Content-Length` check (`api.ts:5, 141–177`).
  - **1 active + 1 latest pending range job & max 2 concurrent upstream reads:** `activeRangeKey` + `pendingRangeRequest` (`service.ts:201–202, 449–462, 484–500`) replaces obsolete pending range requests during rapid date navigation; `MAX_CONCURRENT_UPSTREAM = 2` (`api.ts:7, 373`, `service.ts:717`) bounds concurrent Google API fetches.
- **Zero leakage into `GET /v1/snapshot`:**
  - `HubSnapshotSchema` (`packages/protocol/src/schema.ts:81–82`), `ProtocolValidator.hub` (`ProtocolValidator.kt:116–118`), and `GET /v1/snapshot` (`desktop/src/server.ts:51–56`) are completely untouched.

### 5. Old/New APK & Hub Compatibility, USB Loss, and Pairing Isolation (`C2` ↔ `C3` ↔ `C4`)

- **New APK with old hub (`404 -> CALENDAR_UNSUPPORTED`):**
  - An old hub without `/v1/calendar/*` routes returns HTTP `404` (`server.ts:49`).
  - `CalendarClient.interpretNon200` maps `response.status == 404` to `Outcome.Failure("CALENDAR_UNSUPPORTED")` (`CalendarClient.kt:421`) without affecting `LaptopClient`'s snapshot state or revoking the bearer token.
  - `AgendaView` renders `"Calendar unavailable on this hub version"` (`AgendaView.tsx:480–487`) while Monitor, Deck, and Laptop remain fully functional.
- **Old APK with new hub:**
  - `GET /v1/snapshot` wire shape and behavior are byte-for-byte unchanged (`desktop/test/server.test.ts`).
- **USB loss and monotonic cache aging:**
  - `CalendarClient` maintains per-page `baselineMonoMs` and never resets it on transport failures or upstream `error`/`partial` pages whose `lastSuccessAtEpochMs` did not advance (`CalendarClient.kt:243–255, 335–350`).
  - `CalendarStore.applyLinkFailure` keeps cached `items` and `page` on `USB_UNAVAILABLE` / `HUB_UNAVAILABLE` / `REQUEST_TIMEOUT` while marking `offline = true` and `linkStale = true` and advancing `ageMs` and `nowEpochMs` monotonically (`store.ts:119–137, 522–525`).
- **Pairing isolation (`AUTH_REQUIRED` vs `CALENDAR_AUTH_REQUIRED`):**
  - `CalendarClient` revokes native laptop pairing only when an HTTP `401` carries a strictly validated `{"v":1,"error":{"code":"AUTH_REQUIRED"}}` hub envelope and the rejected bearer still matches the current stored bearer (`CalendarClient.kt:73–90, 423–426`). Domain-level `CALENDAR_AUTH_REQUIRED` never revokes native laptop pairing.

### 6. OAuth Security, 3 Read-Only Scopes, Generation-Checked Persistence, `setup_required` Gate, and Windows ACLs (`C2`)

- **OAuth PKCE, state, loopback callback, and fixed endpoints (`desktop/src/calendar/oauth.ts:9–15, 22–56, 93–309`):**
  - Uses fixed `GOOGLE_AUTH_URL` (`https://accounts.google.com/o/oauth2/v2/auth`) and `GOOGLE_TOKEN_URL` (`https://oauth2.googleapis.com/token`), ignoring any URLs inside the user's client JSON file.
  - Enforces PKCE `S256`, 24-byte random `state`, ephemeral `127.0.0.1:0` loopback listener with `isLoopbackRemote` check, `access_type=offline`, `prompt=consent`, and verifies all three read-only scopes (`calendar.events.readonly`, `calendar.calendarlist.readonly`, `calendar.calendars.readonly`) on both callback (if supplied) and token exchange (`CALENDAR_PARTIAL_GRANT`).
- **Generation-checked token persistence (`desktop/src/calendar/connection.ts:29–51`, `oauth.ts:387–397`):**
  - All state and credential mutations occur under `connection.lock` via `atomicWrite` with zero network I/O inside lock callbacks.
  - `saveTokens(generation, nextTokens)` re-verifies `this.credentials(generation)` under lock, preserves `refreshToken` when omitted by Google on rotation, and refuses to write `tokens.json` if a concurrent `disconnect()` or `beginConnect()` rotated the generation.
- **`setup_required` source-review gating (`connection.ts:29–33`, `service.ts:306–318, 405–406, 449–450, 484, 948–983`, `AgendaView.tsx:130–139, 282–375, 513–514`):**
  - `beginConnect`/`finishConnect` writes `applied: false`.
  - While `applied === false`, `CalendarService` enters `setup_required`, queues `executeMetadataSync()` only (defaulting readable sources to `selected: true` for review), and makes **zero** `/events` requests until the user reviews and applies selection via `select()`. Newly discovered sources after initial `select()` default to `selected: false`.
- **Windows private storage ACL verification (`connection.ts:12–19`):**
  - On `win32`, `protectWindowsDirectory` invokes PowerShell to set current-user SID ownership, enable DACL protection without inheritance (`SetAccessRuleProtection($true, $false)`), grant only current-user `FullControl` (`ContainerInherit,ObjectInherit`), and verify the resulting DACL via `Get-Acl`—failing closed with `CALENDAR_PRIVATE_STORAGE` if ACL protection cannot be verified.

### 7. Attribution, Privacy, and Styling Hygiene (`C1`–`C5`)

- **Git attribution:** Checked the entire 10,691-line `feature-diff.md` and repository files—zero `Co-Authored-By`, `Generated with Codex`, `noreply@anthropic.com`, or vendor attribution lines exist.
- **Privacy and secret confinement:** Zero real Google tokens, client secrets, account emails, phone serials, or private payloads exist in code, tests, fixtures, or screenshots. Email-like calendar summaries are sanitized (`api.ts:281–292`), attendee identities are stripped after extracting `selfResponseStatus` (`api.ts:492–505, 649`), and OAuth/CLI errors never log tokens, codes, or raw upstream bodies (`oauth.ts`, `cli.ts`).
- **UI and styling discipline:** Zero inline `style` attributes in `AgendaView.tsx` (verified by code inspection and Playwright E2E), zero em-dashes in Agenda UI copy, `>= 44px` interactive targets, `>= 14px` computed text sizes, zero horizontal overflow across `800x360`, `740x320`, and `360x800` at both `100%` and `130%` text zoom, and combined production frontend bundle size of `415,565` bytes (`405.8 KiB` <= `750 KiB` budget).
