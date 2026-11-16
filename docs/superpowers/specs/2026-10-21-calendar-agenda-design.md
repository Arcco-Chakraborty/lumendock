# Google Calendar agenda: proposed design

Date: 2026-10-21, Asia/Kolkata. Status: design approved by the user (“good works”, 2026-10-21); implementation-plan review active. No calendar account setup has been performed.

## Request and intent

The user requested a reminders section that imports Google Calendar effectively, then clarified: **“all of the events with labels”**. They also requested a mockup. The goal is a useful desk agenda with identifiable event labels, rather than a one-time calendar export.

The following defaults are design recommendations, not decisions already approved by the user: name the section **Agenda**; show a next-event summary and date-grouped list; connect one Google account on the laptop; make the first version read-only. Google Tasks and background alarms are separate features, not implied by the clarification about events.

## Current source and constraints

- Canonical execution root: `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`, detached HEAD `8e8ddcc`. The original project directory is a launcher/checkpoint mirror with no current product sources.
- Current source includes Monitor, Deck and Laptop tabs, electric-cyan/dark styling, an auto-hide overlap dock, and Windows/Linux support. Preserve existing uncommitted 1.3.2 pairing/launcher/version work and screenshot changes. Earlier UI-only task scope is historical; this request proposes a new calendar integration.
- The phone uses USB for the laptop hub and Wi-Fi for an ESP32 AP without internet. The laptop retains its internet connection. Calendar sync must not depend on the phone obtaining Google access over that AP.
- Hub and Android validation are strict, and responses have a 256 KiB cap. Old APKs reject unknown snapshot fields. Do not put an unbounded archive into the two-second hub snapshot or change its shape for this feature.
- Existing Android clients/cache are foreground-owned. No claim of background reminders or durable phone cache follows from that architecture.

## Recommended integration

Use the official Google Calendar API from the desktop hub. The user signs in through the laptop's normal browser; the laptop fetches calendar data and labels and delivers a normalized agenda over the existing authenticated USB connection. No hosted backend or phone Google login is required.

Connection is opt-in and scoped to one account initially. The connection flow enumerates calendars, including hidden calendars, and shows the inclusion list before sync. Default all readable subscribed calendars on, with the ability to deselect. Calendar inclusion is independent of Google's `selected` or `hidden` flags. Show inaccessible/free-busy-only sources explicitly rather than imply all details were imported. The human chooses the actual Google account; agents must not inspect account profiles or auth files.

Use a Desktop OAuth client, PKCE S256, random state, offline access, and a short-lived callback bound to an ephemeral `127.0.0.1` port. The existing hub rejects query strings and browser origins: keep those checks and use a separate callback listener. No embedded Google sign-in or general URL proxy in the WebView.

Request only `calendar.events.readonly`, `calendar.calendarlist.readonly`, and `calendar.calendars.readonly`. The third scope is required to read calendar metadata containing label definitions. Tokens and OAuth client configuration remain in private desktop storage, separately from event cache. Runtime code may use the explicit new grant; agents must never open, print or copy real tokens. Do not reuse unrelated Google/AI credentials. Review Windows file ACL behavior; POSIX mode bits alone do not establish Windows privacy.

Google Cloud Calendar API/OAuth client configuration is a real setup prerequisite. Prefer the user's own Desktop client for this personal installation; document the setup before asking them to connect. External OAuth projects in Testing have a seven-day authorization/refresh-token lifetime for Calendar scopes. Describe the production/verification alternatives honestly; do not promise indefinite unattended access, silently create a Cloud project, change publishing state, or configure billing.

## Events and labels

“All events” means all accessible, non-deleted event occurrences from included calendars in the displayed date range, not only the primary calendar or labelled events. Default to the current week with Today and Upcoming views; allow browsing earlier/later dates in bounded windows. Infinite recurrence cannot be loaded as an infinite list. Always show the loaded date range and provide paging; no silent first-page/first-N truncation.

- Consume every CalendarList and Events result page. Do not set an event-type filter. Include hidden invitations and retain declined invitations with a visible declined state. Respect access restrictions; private details that Google withholds stay unavailable.
- Ask Google to expand recurring occurrences with `singleEvents=true`, handle moved/cancelled exceptions through complete window replacement, and key by calendar plus occurrence identity. Preserve independent source entries rather than accidentally deduplicating different calendars' events.
- Preserve all-day start/end as date-only strings with exclusive end semantics. Timed values retain instants and source time zones; display in the phone's chosen local zone with a visible zone label. Handle DST, cross-midnight spans and multi-day events.
- Preserve the source calendar name/color separately from event label name/color. Google now documents `Calendars.labelProperties.eventLabels[]` and `Events.eventLabelId`. Resolve labels within their owning calendar. Names may be absent; show a neutral label fallback rather than inventing categories or mapping legacy palette names to user labels.
- When no named event label exists, show the source calendar badge. Missing or unavailable label metadata must never hide the event. Preserve supported legacy event colors as a fallback, without fabricating label text.
- Google documents `eventLabelVersion=1`, but the currently published discovery document does not list that parameter for event reads. Verify read behavior against authenticated, human-provided synthetic labelled events before claiming exact label parity. Do not create real Google events as part of read-only testing. Report unresolved label support visibly and preserve source calendar badges meanwhile.
- Import event reminder settings/defaults for an informational “Reminder 10 min before” detail when supplied. Google remains responsible for actual notifications. No phone alarm scheduler, notification permissions, lamp pulses, Google writes, task completion or rescheduling is included in this version.

Google Tasks items visible inside Google's Calendar UI are not Calendar event resources. The user's clarified event scope does not authorize claiming Tasks parity. If requested later, use the separate Tasks API and disclose its date-only due-time limitation.

## Sync, paging and failure behavior

Start with complete bounded-window reads rather than mixing rolling filters with incremental sync tokens. Default refresh: every two minutes while the phone is active, every fifteen minutes idle; refresh the active range after reconnect/resume subject to rate limits. Refresh calendar/label metadata at startup and every fifteen minutes, plus explicit refresh. One sync job at a time with bounded upstream concurrency and request deadlines. Honor retry guidance/backoff for 429/5xx; auth revocation becomes a reconnect state, not a login loop.

Replace a calendar's cached date window only after all its upstream pages succeed. A failed or partially fetched calendar retains its last complete result and its own last-success timestamp. Successful calendars may advance independently; expose partial-source failure and stale state. Complete reads naturally remove deleted events. Metadata rename/removal refreshes label resolution even if event rows did not change.

Add a fixed authenticated **POST `/v1/calendar/read`** and typed **`hub.calendar`** bridge operation. A read-only POST avoids weakening the hub's no-query-string policy. Request: validated start date, bounded day count, IANA display time zone, and optional opaque app cursor. No URL, account address or upstream Google page token crosses the bridge. The handler reads a ready cache or queues a range job and returns `loading` immediately; it must not synchronously wait for all Google requests within the native transport deadline.

Reply: schema version, source state (`disabled`, `loading`, `available`, `partial`, `auth_required`, `error`), server time, range/zone, per-source sync status, normalized events, revision, next cursor, and fixed safe error code. Event fields are limited to opaque app identity, title, start/end discriminated by all-day/timed, calendar display name/color, optional event label display name/color, event type/status and optional reminder summary. Omit descriptions, attendees, emails, conference URLs/passwords and raw payloads. Render plain text only.

Include an opaque `sourceId` on each event/source status. For the invitation state, extract only the attendee marked `self` into optional `selfResponseStatus` (`needsAction`, `declined`, `tentative`, `accepted`, or unknown); event `status` is a distinct confirmed/tentative/cancelled value. Drop all attendee identities after extracting that field. An event can be confirmed while the current user declined it.

Complete the inclusion UI with fixed authenticated POST `/v1/calendar/sources` and `/v1/calendar/select` endpoints, mirrored by typed `hub.calendarSources` and `hub.calendarSelect` operations. Sources are paginated, include opaque source ID, display name/color, inclusion state and readable/free-busy/unavailable capability; never expose an account address as an ID. Duplicate names remain distinguishable by a stable short source suffix. Selection accepts validated opaque IDs and expected selection revision, persists only this app's local preferences, and performs no Google writes. Deselection removes that source's cached/published rows, invalidates range cursors, advances the selection generation and discards late upstream results from older generations. New calendars are reported as newly available and require explicit inclusion after initial setup; do not silently expand an existing grant's displayed scope.

Default page maximum 50 events, response target <=128 KiB including status; enforce serialized byte limits as well as item limits. Use finite string bounds and paging for source status if necessary. Return an explicit capacity/error state for excessive source responses, never silently drop records. Cursor binds range/zone/calendar selection/revision with a ten-minute lifetime; an invalidated cursor restarts pagination safely without presenting a mixed revision as complete. Google pagination stays inside the collector. Keep the existing snapshot unchanged so an upgraded desktop remains usable by old APKs; a new APK against an old hub shows Calendar unavailable without affecting other tabs.

Bound aggregate work: a request spans 1–31 days; retain at most three complete ranges and 16 MiB of normalized cache, with a 10,000-occurrence limit per range. Collect at most two upstream calendar requests concurrently within the single sync job. Stage at most 16 MiB/10,000 normalized occurrences for a range and at most 2 MiB per upstream JSON response; request narrow fields and modest page sizes. A limit breach fails that proposed range explicitly and preserves the previous complete range, with guidance to narrow dates or included calendars. Keep at most one active job and one pending latest-range request; coalesce repeats and replace obsolete pending work. Cancel obsolete active browsing work when safe, and use range/selection generations to reject late results. Refresh jobs cannot accumulate behind navigation. Evict least-recently-viewed unpinned ranges; include all staging/cache allocations in resource evidence. These are product capacity limits, not permission to return a silently incomplete range.

Initially keep only an in-memory range cache on the laptop and the current foreground native session on the phone. USB loss or laptop internet loss leaves previously received events visible with last sync and stale/offline wording. Cold start without data shows an honest unavailable/setup state. No durable phone offline guarantee is included. Disconnect clears tokens/config and calendar cache; the next authenticated read clears the phone's calendar state. A disconnected phone cannot receive remote cache clearing, so previously rendered data can remain until session end/reconnection; document this limit.

## Proposed section

Add Agenda as a fourth tab in the existing overlap dock. Preserve auto-hide/on-demand access and make Home/End keyboard movement derive from the actual tab list rather than the currently hardcoded Laptop end tab. Verify all four tabs remain reachable at narrow widths.

The recommended landscape arrangement puts the next timed event on the left and a date-grouped agenda on the right. All-day events appear in their own row. Portrait stacks those elements. Each row shows a readable title, actual time or All day, source calendar badge, and named event label when present. Selecting a row opens a read-only detail sheet with full title, times, source and reminder summary. Date controls and a calendar inclusion sheet make the imported scope visible. Long lists scroll inside the agenda; they must not shrink text or cover dock controls. This is an explicit allowance for agenda content, not a change to the existing Monitor/Deck layout rules.

Match existing app tokens (`#0b0d0f` housing, `#050607` wells, `#e6edf0` text, `#8b98a0` secondary, `#22d3ee` active accent), Archivo/system fallback typography and >=44px interactive targets. Google label colors encode category, paired with text; do not replace the app's accent theme. Meet 800x360, 740x320, 360x800 and 130% text requirements. Empty, loading, no-events, partial, reconnect and old-hub states are distinct. Preserve focus/scroll across refreshes.

The requested mockup uses recognizably synthetic sample events only. It demonstrates the proposed section; it is not connected to Google and is not product code.

## Alternatives considered

| Approach | Fit |
|---|---|
| Desktop OAuth/API | Recommended: works with the existing USB/offline-phone topology and exposes documented Google labels. Requires explicit OAuth setup. |
| Android CalendarProvider | Useful for locally synced calendars, but local sync range/freshness varies and Google named labels have no documented provider mapping. Adds calendar permission/account-sync prerequisites. |
| Private ICS feed/export | Simpler import, but private URL is a credential and event-label fidelity/update behavior is weaker. A static file is not ongoing sync. |
| Embedded Google Calendar page | Conflicts with the offline phone topology and packaged WebView restrictions. |

## Build sequence after approval

1. Define and review the normalized calendar request/reply, error vocabulary and compatibility fixtures without changing existing snapshots.
2. Desktop owner: OAuth connection/disconnect/status, Calendar API adapter, atomic range collection/cache and fixed authenticated read endpoint. Linux/Windows setup is explicitly user-triggered.
3. Android owner: fixed calendar endpoint/bridge, strict matching validation, foreground cancellation/cache and independent failure state. No Wi-Fi/process routing changes or new OS calendar permissions.
4. Dashboard owner: Agenda tab, date/group/label rendering, detail/setup states, mock scenarios and four-tab dock behavior.
5. Integrate and verify, produce a local updated APK/desktop package if authorized, run fresh independent reviews; no publish/push/release as an implicit step.

Independent owners may work in parallel only with disjoint files; serialize protocol/shared-file changes and commits. Fresh task reviewers follow AGENTS model routing. Final PRD/plan and final finished-project reviews require Astra-high. Product implementation begins only after this concrete feature description is approved; then write the detailed implementation plan.

## Required evidence

- Synthetic Calendar API fixtures: multiple/hidden/shared and identically named calendars; deselection during sync; all event types; empty intermediate pages; >50 events; label rename/missing name/metadata failure; recurrence exception/deletion; DST and all-day/multi-day boundaries; hidden invitations and a confirmed event whose self attendee declined; partial failure and auth/rate limiting; rapid range browsing and cache/upstream/staging capacity exhaustion.
- OAuth fake-server tests: state/PKCE/callback expiry, granted scopes, token refresh/revocation, secret-free failures, cancellation and private-file handling. Do not use real account payloads in fixtures or logs.
- Protocol/native tests: response/byte limits, cursor invalidation, time-zone validation, unknown-field rejection, bearer confinement, cancellation, old/new hub compatibility and independent source failures.
- Browser checks/screenshots: four-tab keyboard access, list paging/scroll, labels/details, stale/empty/error states, both orientations and 130% text. This proposal/mockup has not run product tests.
- Human-assisted Google acceptance: user provides synthetic labelled, recurring and all-day events; compare read-only results and update/delete behavior without committing private event data. Confirm label read semantics before parity claim.
- Physical acceptance: phone receives agenda over USB while still connected to the ESP32 AP; unplug/reconnect and internet outage retain correctly labelled cached rows. Build/tests alone cannot prove this.

## Primary sources checked

- [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth) and [calendar metadata authorization](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/get)
- [Named event labels](https://developers.google.com/workspace/calendar/api/guides/labels), [calendar metadata](https://developers.google.com/workspace/calendar/api/v3/reference/calendars), [event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)
- [Event list/pagination/recurrence](https://developers.google.com/workspace/calendar/api/v3/reference/events/list) and [calendar list](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list)
- [Incremental sync constraints](https://developers.google.com/workspace/calendar/api/guides/sync)
- [OAuth expiration](https://developers.google.com/identity/protocols/oauth2#expiration) and [production sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Android CalendarProvider](https://developer.android.com/identity/providers/calendar-provider) and [Instances](https://developer.android.com/reference/android/provider/CalendarContract.Instances)
- [Tasks API semantics](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks)

These sources establish documented capabilities and constraints. Authenticated label reads, account-specific availability, implementation and device behavior remain unverified.

## Implementation clarifications after approval

The technical plan defines an explicit setup_required state and source-list Apply step before event collection; connection generations and generation-checked token persistence propagate CLI disconnect/reconnect safely to a running hub. Manual refresh has a typed refresh flag, excludes cursors and refreshes event/label metadata under throttle/backoff. Each page carries a server-computed whole-range nextEvent summary, so pagination cannot hide the actual next event. Source selection is explicitly capped at 100 sources to remain within the existing 16 KiB bridge request budget; excess capacity is reported, never silently omitted. These clarify implementation of the approved behavior rather than change its read-only scope.
