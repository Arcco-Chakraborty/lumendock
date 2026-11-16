# Monitor next-event addition — independent review

Date: 2026-10-23. Reviewer: gpt-6-astra, high reasoning (fresh independent task reviewer).

## Scope and verdict

**Preliminary verdict: changes requested. One P2 finding; no P1 findings.** This is a narrow review of the Monitor next-event addition, not approval of the full Calendar feature or finished project. Fix rereview is pending.

Canonical checkout: `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`, detached baseline `8e8ddcc`. Reviewed `.superpowers/calendar/monitor-next-review.diff` against `.superpowers/calendar/monitor-next-baseline`, plus required dependency code. The updated 443-line task diff and all ten entries in `.superpowers/calendar/monitor-next-review-hashes.json` matched current bytes at initial review completion, including the author's long-label boundary correction. Unrelated pre-existing dirty Calendar/1.3.2 work was not treated as this task's diff.

Read root instructions/checkpoints, PRD Monitor addition, original Calendar design, implementation report, and relevant store/time/native dependency paths. Reviewed new row rendering, App lifecycle/navigation, compact CSS, accessibility, and targeted/full-suite evidence. Visually inspected synthetic 740×320 and 320×800 at130% text screenshots.

## P2 — Share known authorization/selection invalidations between the independent range stores

Location: `dashboard/src/App.tsx:190` (independent cache creation/lifecycle), with candidate use at `dashboard/src/components/MonitorNextEvent.tsx:19`.

The new Monitor store and Agenda store have independent cached pages but no shared invalidation signal. If Agenda learns that Calendar authorization is revoked, the account was disconnected, or selected sources changed, Monitor retains its former `available` page. A failed/USB-disconnected read on returning to Monitor preserves that page, so a known-invalid event is displayed again with only an Offline notice. Distinct date ranges are appropriate; authorization and source inclusion are shared account context.

Independent synthetic production-bundle reproduction, using installed Chrome and a separate local preview on127.0.0.1:4183:

1. Monitor receives an available candidate titled `Synthetic revoked event`.
2. Open Agenda. Supply an `auth_required` page with empty items and no nextEvent; wait until Agenda visibly says `Google authorization required`.
3. Supply `USB_UNAVAILABLE`, disconnected link, and null data.
4. Return to Monitor and advance its polling interval.
5. Actual: `Synthetic revoked event` reappears with its time/label/source and `Offline`. Expected: known authorization failure continues to suppress the event, even if the next read cannot complete.

Repro script is ignored `.superpowers/calendar/monitor-review/repro.ts`; no real data or credentials are involved. The same missing signal applies to deselection/disabled state. The inverse path also requires protection: after Agenda has cached an event, Monitor can learn the terminal state, and reopening Agenda while offline must not restore that old cache.

Requested fix: propagate authoritative selection/clear/terminal-authorization invalidation across both stores while preserving independent date ranges, and cover failed or delayed subsequent reads. Do not use a refresh alone as invalidation: connectivity failure intentionally preserves ordinary offline cache.

## Other review observations

- Whole-range `page.nextEvent` is used directly; first-page event ordering cannot hide the candidate.
- The new store follows today independently, activates only for Monitor, inherits visibility gating, and disposes with its ownership scope. Navigation resets Agenda to today and focuses the panel.
- Known local states suppress candidates appropriately; timed/ongoing/declined/expired eligibility reuses the existing helper. Empty text names the seven-day bound. Partial/stale/offline are visible.
- The row is a native button with an action name and full accessible description. The long-label correction constrains landscape metadata while preserving full accessible text. No additional consequential layout issue was found in the reviewed evidence.
- No Calendar writes, selection auto-application, new native/protocol permissions, or modified clock/climate/quota control logic appear in this task diff.
- The author reports171 dashboard tests and typecheck passing;68/68 full E2E passed before the final narrow CSS correction, followed by11/11 targeted layout cases after it. These are author evidence, not independent re-execution of the entire suite. Independent reviewer executed the additional synthetic invalidation reproduction above.

## Limits

Software review only. No live Google API call, credential access, phone/private event inspection, APK installation, device acceptance, commit, publication, or system setting change occurred. Historical full-feature review findings and model substitutions remain outside this narrow verdict. Coordinator owns HANDOFF/STATUS/PROGRESS updates.

## 2026-10-23 — Fix rereview

**Final narrow code-review verdict: approved. Original P2 resolved; zero open P1/P2 findings in this addition.** Reviewed by the same fresh independent gpt-6-astra/high reviewer. The preliminary finding and reproduction above remain as history.

The frozen task diff is now631 lines across11 files, including the scoped CalendarStore fix. Its SHA-256 is `b8a33c1149adfdd3885b6d63d346c77c1e631fc7c6bb82b7e428c10477857f9f`. All11 source/test/PRD hashes matched `.superpowers/calendar/monitor-next-review-hashes.json` on rereview. `git diff --check -- dashboard/src dashboard/test dashboard/e2e` passed.

Resolution checked:

- CalendarStore publishes deduplicated authoritative selection/access context from accepted range/source responses, successful selection, and phone authorization failure. App subscribes in both directions before activating the stores.
- A changed context invalidates the peer's event/source identities. The peer retains its own date range and current-date-following policy.
- Invalidation advances request, range, source, and dataset guards, rejecting replies that began under the previous context. It does not publish another context notification, avoiding feedback between stores. Ownership cleanup unsubscribes observers and disposes the Monitor store.
- Successful source deselection and both directions of terminal authorization clearing have explicit synthetic browser regressions. Held-next-read coverage verifies clearing occurs before a replacement response; the direct store test covers an already-pending obsolete response after invalidation.

Independent verification: reran the original synthetic Chrome reproduction against the final production bundle on separate local port4183. Agenda visibly confirmed `Google authorization required`; the next Calendar read failed with USB unavailable. Returning to Monitor displayed `Connect laptop for calendar` / `Offline`, and the revoked synthetic event title count was0, compared with1 before the fix. The local reviewer preview was stopped afterward. No screenshot evidence was overwritten.

Author evidence for the frozen fix:172 dashboard tests, dashboard/E2E typecheck, and production build passed; seven targeted browser cases passed after five fail-first invalidation reproductions. Coordinator's complete final E2E run is separate integration evidence and was still pending when this code-review outcome was written. The review does not replace that required run or device acceptance.

The original scope/limits continue to apply: approval covers only this Monitor addition and its scoped cross-store fix, not historical full Calendar/project findings, authenticated label parity, or physical phone/ESP32 acceptance.
