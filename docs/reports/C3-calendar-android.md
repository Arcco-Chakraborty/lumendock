# Task C3 Report: Android Fixed Calendar Transport and Validator

- **Status:** DONE (software verified; awaiting coordinator-owned independent task review; physical device and authenticated Google label acceptance remain unrun)
- **Canonical Root:** `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`
- **HEAD:** `8e8ddccd73dcc05ed673f1aabbf9a3048cca5d71` (pre-existing dirty 1.3.2 state preserved; no commits, staging, pushes, adb actions, or provider auth reads performed)

## Changed and Created Files (C3 Scope)

### Created
- `android/app/src/main/java/com/phonemonitor/CalendarValidator.kt`:
  - Strict validator mirroring C1 (`packages/protocol/src/calendar.ts`):
    - Real Gregorian `YYYY-MM-DD` validation (leap years, 100/400-year rules, ASCII digits only).
    - IANA `timeZone` validation (`ZoneId.getAvailableZoneIds() + "UTC"`, max 80 chars, rejecting fixed `+`/`-`/`UTC+`/`GMT+` offsets and unknown zones).
    - Opaque identifiers `[A-Za-z0-9_-]{1,80}`, app cursors `[A-Za-z0-9._~-]{1,256}`, case-insensitive `#RRGGBB` colors, and Unicode code-point limits (`title` <= 256, `calendarName`/`source.name` <= 120, `label.name` <= 50, `eventType` <= 40).
    - Empty event title normalization (`""` -> `"Untitled event"`).
    - Matching `start`/`end` kinds (`date` vs `time`) and strictly positive duration.
    - `refresh: true` + `cursor` mutual exclusion on `CalendarRangeRequest`.
    - Unique `sourceIds` (max 100) and `expectedRevision` on `CalendarSelectRequest`.
    - Closed `CalendarState` (`disabled`, `setup_required`, `loading`, `available`, `partial`, `auth_required`, `error`, `capacity`) and `CalendarErrorCode` (`CALENDAR_AUTH_REQUIRED`, `CALENDAR_UNAVAILABLE`, `CALENDAR_CAPACITY`, `CALENDAR_CURSOR_EXPIRED`, `CALENDAR_SELECTION_CHANGED`, `CALENDAR_UNSUPPORTED`).
    - Page source coverage of `items`, whole-range timed non-declined `nextEvent` eligibility (`end.epochMs > serverNowEpochMs`), and 128 KiB UTF-8 serialized byte budget on `CalendarPage` and `CalendarSourcesPage`.
    - Strict key sets at every object level (rejecting unknown keys, URLs, tokens, and emails).
- `android/app/src/main/java/com/phonemonitor/CalendarClient.kt`:
  - Activity-owned calendar client sharing `LaptopClient`'s unbound loopback transport (`NO_PROXY`, no redirects, fixed timeouts) and native bearer store (`PairingStore`).
  - Executes fixed `POST /v1/calendar/read`, `POST /v1/calendar/sources`, and `POST /v1/calendar/select` requests with validated JSON bodies (<= 16 KiB) and bearer token confined to the `Authorization` header.
  - Maps old-hub HTTP `404` on calendar endpoints cleanly to `CALENDAR_UNSUPPORTED` without invalidating `LaptopClient`'s snapshot cache or revoking native pairing.
  - Revokes native laptop pairing only when an authenticated hub rejects the current bearer token with a validated `401 {"v":1,"error":{"code":"AUTH_REQUIRED"}}`; Google grant errors (`CALENDAR_AUTH_REQUIRED`) and unvalidated 401 bodies never revoke pairing.
  - Maintains independent bounded caches and monotonic receipt-age baselines (`baselineMonoMs`) so failed reads or upstream error/partial pages whose `lastSuccessAtEpochMs` did not advance never refresh stale cached age.
  - `select()` succeeds only after an authoritative HTTP 200 `{selectionRevision}` reply, increments `selectionEpoch`, cancels/rejects in-flight pre-selection reads, and invalidates cached calendar/source pages.
  - Scopes in-flight calls to the foreground session (`resume()`, `pause()`, `close()`), cancels active calls on background/shutdown, and clears in-memory caches on `close()`.
- `android/app/src/test/java/com/phonemonitor/CalendarValidatorTest.kt`:
  - 15 JVM unit test methods covering shared C1 fixtures, request/response schemas, date/zone/code-point/byte limits, unknown keys, `setup_required`, `nextEvent` eligibility, and link wrappers.
- `android/app/src/test/java/com/phonemonitor/CalendarClientTest.kt`:
  - 14 JVM unit test methods covering fixed loopback POST paths, bearer confinement, echoed-token rejection, old-hub 404 -> `CALENDAR_UNSUPPORTED`, bearer 401 vs `CALENDAR_AUTH_REQUIRED`, stale 401 after re-pairing, monotonic cached age retention across transport and upstream failures, snapshot/calendar failure independence, authoritative `select` cache invalidation and race protection, pagination/empty-title normalization/`setup_required`, lifecycle cancellation, renderer recreation cache retention, and real loopback socket POST execution.

### Modified
- `android/app/src/main/java/com/phonemonitor/LaptopClient.kt`:
  - Added fixed `CALENDAR_READ`, `CALENDAR_SOURCES`, and `CALENDAR_SELECT` entries to `HubPath`.
  - Exposed internal `store`, `transport`, `clock`, `currentBearer()`, and `revokeBearer(rejected)` so `CalendarClient` shares native bearer state cleanly with `LaptopClient`.
- `android/app/src/main/java/com/phonemonitor/ProtocolValidator.kt`:
  - Added `CalendarValidator.errors` to `ProtocolValidator.errors`.
  - Routed `hub.calendar`, `hub.calendarSources`, and `hub.calendarSelect` in `ProtocolValidator.args` and `ProtocolValidator.response`.
- `android/app/src/main/java/com/phonemonitor/BridgeRouter.kt`:
  - Added `hubCalendar`, `hubCalendarSources`, and `hubCalendarSelect` to `BridgeServices` and `UnavailableBridgeServices`, and routed `hub.calendar`, `hub.calendarSources`, and `hub.calendarSelect` in `BridgeRouter.execute`.
- `android/app/src/main/java/com/phonemonitor/MainActivity.kt`:
  - Wired Activity-owned `CalendarClient` into `MainActivity` (`onCreate`, `onStart`, `onStop`, `onDestroy`, `nativeSession` `onBackground`, and `BridgeServices`).

## TDD Red / Green Evidence and Commands Run

All commands were run with:
```bash
JAVA_HOME=/home/arcco-chakraborty/.local/share/phone-monitor/toolchains/jdk17 \
ANDROID_HOME=/home/arcco-chakraborty/.local/share/phone-monitor/toolchains/android-sdk
```

1. **Validator RED check:**
   - Command: `./android/gradlew -p android :app:testDebugUnitTest --tests com.phonemonitor.CalendarValidatorTest`
   - Log: `.superpowers/sdd/2026-10-21-calendar-agenda/c3-validator-red.log`
   - Result: Failed as expected (`Unresolved reference 'CalendarValidator'` at `CalendarValidatorTest.kt:18`).
2. **Client/Router RED check:**
   - Command: `./android/gradlew -p android :app:testDebugUnitTest --tests com.phonemonitor.CalendarClientTest`
   - Log: `.superpowers/sdd/2026-10-21-calendar-agenda/c3-client-red.log`
   - Result: Failed as expected (`Unresolved reference 'CalendarClient'`, `CALENDAR_READ`, `CALENDAR_SOURCES`, `CALENDAR_SELECT`, `hubCalendar`, `hubCalendarSources`, `hubCalendarSelect`).
3. **Targeted GREEN check (`CalendarValidatorTest` + `CalendarClientTest`):**
   - Command: `./android/gradlew -p android :app:testDebugUnitTest --tests com.phonemonitor.CalendarValidatorTest --tests com.phonemonitor.CalendarClientTest`
   - Log: `.superpowers/sdd/2026-10-21-calendar-agenda/c3-targeted-green.log`
   - Result: `BUILD SUCCESSFUL` (29 tests: 15 in `CalendarValidatorTest` + 14 in `CalendarClientTest`, 0 failures, 0 errors).
4. **Full Android JVM Unit Test Suite & Lint (`--rerun-tasks`):**
   - Command: `./android/gradlew -p android :app:testDebugUnitTest :app:lintDebug --rerun-tasks`
   - Log: `.superpowers/sdd/2026-10-21-calendar-agenda/c3-full-green.log`
   - Result: `BUILD SUCCESSFUL in 42s`
     - `testDebugUnitTest`: **18 test suites, 147 tests passed, 0 failures, 0 errors**
     - `lintDebug`: **0 errors** (`android/app/build/reports/lint-results-debug.html`)
5. **Formatting / Whitespace Check:**
   - Command: `git diff --check android/`
   - Result: Clean (exit 0, no output).

## 2026-10-22 Fix-Wave Update (Astra Finding A1: Receipt Age vs. Upstream Google Sync Age)

- **Finding addressed (`A1`):** Separated `LinkSnapshot.ageMs` (native transport/cache receipt age since the hub response was received) from upstream Google Calendar sync age (`serverNowEpochMs - lastSuccessAtEpochMs` and source `lastSuccessAtEpochMs`).
- **Changes:**
  - `android/app/src/main/java/com/phonemonitor/CalendarClient.kt` (`243–245`, `325–326`): `storePage` and `storeSourcesPage` record `CachedEntry(page, clock.monotonicMs())` at response receipt time so a newly received hub response has `ageMs = 0L` and `stale = false`, while transport failures (`USB_UNAVAILABLE`, HTTP 5xx, etc.) preserve the existing `CachedEntry` and advance `ageMs` monotonically without refreshing receipt age.
  - `android/app/src/test/java/com/phonemonitor/CalendarClientTest.kt` (`280–357`): Added/updated regression assertions verifying that `LinkSnapshot.ageMs` is `0L` upon fresh receipt of a hub response with nonzero upstream sync age (`lastSuccessAtEpochMs < serverNowEpochMs`) and advances monotonically across subsequent transport failures (`2000L`, `5000L`, `7500L` stale).
- **Verification:**
  - Command: `JAVA_HOME=$TC/jdk17 ANDROID_HOME=$TC/android-sdk ./android/gradlew -p android :app:testDebugUnitTest :app:lintDebug`
  - Result: `BUILD SUCCESSFUL` — 18 test suites, 147 JVM unit tests passed, 0 lint errors.

## Remaining Gates and Limitations

- Software-verified only in JVM unit tests and Android Lint; physical device acceptance (simultaneous Redmi USB + ESP32 Wi-Fi AP routing) and live Google Calendar label parity remain unrun acceptance gates.
- Calendar cache is in-memory and scoped to the current foreground Activity/process session as specified; no durable offline phone cache or background alarm scheduling is included.
