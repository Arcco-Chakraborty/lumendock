# C1 Calendar protocol implementation report

Status: DONE, awaiting coordinator-owned fresh independent task review and contract freeze.

Execution: `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`; detached HEAD `8e8ddccd73dcc05ed673f1aabbf9a3048cca5d71`; pre-existing dirty 1.3.2 state retained. Baseline source snapshot `.superpowers/calendar/baseline` was read only. No commits, staging, hub/device/host operations, private Google requests, auth/account reads, or external writes occurred. No subagents were created. Coordinator owns HANDOFF/STATUS/PROGRESS updates.

## Changed files

- `packages/protocol/src/calendar.ts` (new): strict Calendar domain schemas and inferred types, date/time-zone validation, code-point and serialized-byte limits, source-identity coverage and Next up eligibility.
- `packages/protocol/src/schema.ts`: imports domain schemas without a reverse dependency, composes link wrappers, extends safe errors, adds all three operation args/request branches/reply maps/generic reply union members.
- `packages/protocol/src/index.ts`: exports Calendar domain.
- `packages/protocol/test/calendar.test.ts` (new): 41 synthetic contract cases including parameterized date/zone/state/error checks.
- `packages/protocol/test/type-contract.test-d.ts`: four compile-time contracts protecting exact Calendar read/source link payloads, selection reply, and range args.
- `packages/protocol/fixtures/calendar-page.json` (new): recognizably synthetic DST-range page with native label and whole-range Next up summary.
- `packages/protocol/fixtures/calendar-sources.json` (new): synthetic paged source enumeration.
- This ignored scoped report.

## Frozen interface candidate

All exports below are available from `@phone-monitor/protocol`. Each domain `XSchema` has the corresponding inferred `X` type:

- `CalendarRangeRequestSchema` / `CalendarRangeRequest`: `{startDate, days, timeZone, cursor?, refresh?}`; real YYYY-MM-DD, days 1–31, Intl-validated IANA zone <=80 chars, refresh:true excludes cursor.
- `CalendarSourcesRequestSchema` / `CalendarSourcesRequest`: `{cursor?}`.
- `CalendarSelectRequestSchema` / `CalendarSelectRequest`: `{sourceIds, expectedRevision}`; unique opaque sourceIds, max100.
- `CalendarErrorCodeSchema` / `CalendarErrorCode`: exact six `CALENDAR_AUTH_REQUIRED`, `CALENDAR_UNAVAILABLE`, `CALENDAR_CAPACITY`, `CALENDAR_CURSOR_EXPIRED`, `CALENDAR_SELECTION_CHANGED`, `CALENDAR_UNSUPPORTED` values, also included in existing `ErrorCodeSchema`.
- `CalendarStateSchema` / `CalendarState`: `disabled | setup_required | loading | available | partial | auth_required | error | capacity`.
- `CalendarMomentSchema` / `CalendarMoment`: `{kind:'date',date}` or `{kind:'time',epochMs,timeZone}`.
- `CalendarEventSchema` / `CalendarEvent`: `{id,sourceId,title,start,end,calendarName,calendarColor,label,eventType,status,selfResponseStatus,reminderMinutes}`. `label` is null or strict `{name:string|null,color:string}`. Endpoints must share a kind and have strictly positive duration; all-day end remains exclusive. Empty title becomes `Untitled event`; confirmed-but-self-declined remains a valid row; cancelled status fails. Event text limits 256/120/50/40 code points; reminders 0–40320 or null; colors case-insensitive #RRGGBB.
- `CalendarSourceSchema` / `CalendarSource`: `{sourceId,name,color,selected,capability,state,lastSuccessAtEpochMs,errorCode}`; capability `read | busy | unavailable`; source name <=120 code points.
- `CalendarPageSchema` / `CalendarPage`: `{v:1,state,errorCode,serverNowEpochMs,range:{startDate,days,timeZone},revision,selectionRevision,lastSuccessAtEpochMs,sourceCount,failedSourceCount,sources,items,nextEvent,nextCursor}`. Counts 0–100, sources/items <=50, strict page <=128 KiB serialized UTF-8. Page sources must cover loaded items' source IDs. Next up can refer to an off-page source because it has inline metadata; when non-null it must be timed, not self-declined, and end after page serverNow. Source identity and unknown-label metadata are independent.
- `CalendarSourcesPageSchema` / `CalendarSourcesPage`: `{v:1,state,errorCode,serverNowEpochMs,selectionRevision,sources,nextCursor}`, <=50 sources and <=128 KiB.
- `CalendarSelectReplySchema` / `CalendarSelectReply`: `{selectionRevision}`.

IDs and all revisions are nonempty ASCII `[A-Za-z0-9_-]+`, max80. Cursors are nonempty ASCII `[A-Za-z0-9._~-]+`, max256, allowing base64url and safe separators; coordinator explicitly confirmed this grammar. Epoch milliseconds are nonnegative safe integers. Objects and nested range/label/moment objects reject arbitrary keys, including URL/token/email fields.

Additional schema exports: `CalendarLinkSnapshotSchema = LinkSnapshotSchema(CalendarPageSchema)` and `CalendarSourcesLinkSnapshotSchema = LinkSnapshotSchema(CalendarSourcesPageSchema)`. Shared maps/unions now recognize:

- `hub.calendar`: `CalendarRangeRequest` -> `LinkSnapshot<CalendarPage>`.
- `hub.calendarSources`: `CalendarSourcesRequest` -> `LinkSnapshot<CalendarSourcesPage>`.
- `hub.calendarSelect`: `CalendarSelectRequest` -> `CalendarSelectReply`.

Existing transport envelopes are unchanged. Domain objects do not contain a bearer, raw provider URL, raw provider ID/email, or OAuth credential. No endpoint implementation was added by C1.

## Verification and TDD evidence

Every Node command used `env PATH=/home/arcco-chakraborty/.local/share/phone-monitor/toolchains/node-v24.22.0-linux-x64/bin:$PATH` as a per-command prefix, without changing the default Node.

1. RED before production edits: `npm test --workspace @phone-monitor/protocol -- test/calendar.test.ts` -> **1 failed / 1**. Existing `BridgeRequestSchema.safeParse` returned false for the valid synthetic `hub.calendar` request; assertion expected true. Expected missing-operation failure, not an import/tooling failure.
2. Expanded the synthetic contract suite and fixtures before adding the domain implementation. First package green: `npm test --workspace @phone-monitor/protocol` -> **58 passed**, 2 files (39 Calendar + original19).
3. Added two relational contract tests before their implementation: same targeted test command -> **2 failed / 41** with **39 passed**. Missing source coverage and invalid all-day Next up were accepted; expected assertions failed. Added page refinements for those requirements.
4. Final `npm test --workspace @phone-monitor/protocol` -> **60 passed**, 2 files (41 Calendar + original19), exit0.
5. `npm run typecheck --workspace @phone-monitor/protocol` -> **passed**, exit0, including `tsconfig.type-tests.json`.
6. `npm run build --workspace @phone-monitor/protocol` -> **passed**, exit0; generated ignored `dist` is current.
7. `git diff --check` -> **passed**, no output.
8. Compared Hub snapshot declarations byte-for-byte with pre-feature source snapshot -> **exact match**. Compared all pre-existing protocol fixture bytes with snapshot -> **exact match**.

Coverage includes Gregorian invalid/leap dates, DST-valid zones and source-zone retention, all-day date retention/exclusive end, mixed/reversed/equal endpoints, safe epoch failures, state/error values, unique/oversized IDs and source selections, >50 items/sources, code-point bounds, >128 KiB escaped UTF-8 page, strict unknown fields, refresh/cursor exclusion, operation-specific args/reply mismatch, native age requirement, setup_required, whole-range/off-page Next up, self-declined event distinction, and old hub fixtures.

## Self-review and limits

Reviewed the snapshot-relative changes and shared brief field-by-field. No fields were added to HubSnapshot; the existing global safe-error enum necessarily gains Calendar errors. No circular import exists (`calendar.ts` imports only Zod; `schema.ts` composes it). Existing dirty package version and other user edits were not modified. Request selection at full100 fits the existing16 KiB bridge budget. Domain pages remain within the native256 KiB cap after link wrapping. Source enumeration's structural field limits are already below128 KiB, and it also has the explicit budget refinement.

The protocol validates eligibility of a supplied Next up and source coverage; whole-range sorting, choosing the correct eligible event, refresh throttling/backoff, cursor signing/invalidation, source-generation cancellation, OAuth lifecycle, endpoint transport, and cache collection remain the C2/C3/C4 implementation responsibility. Compile-time exact payload/args contracts pass. Full desktop/dashboard/device tests were not run by C1: owned verification is protocol package tests/typecheck/build. No account connection, authenticated label fidelity, phone routing, or physical acceptance is claimed. Fresh independent task review remains the coordinator's next gate before freezing and dispatching dependent tracks. No known C1 blockers.
