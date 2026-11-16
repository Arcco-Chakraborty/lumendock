# C1 independent protocol review

Date: 2026-10-21. Review scope: specification compliance and code quality for Task C1, using the binding task brief, implementation report, and baseline-relative review diff. Execution root is the canonical phone-monitor-build worktree, detached HEAD `8e8ddcc`; the existing dirty 1.3.2 changes remain present.

## Verdicts

- **Specification compliant: YES for C1.**
- **Code quality approved: YES.**
- **Consequential findings: none.** C1 is suitable for coordinator-owned contract freeze and dependent implementation. This is a scoped task review, not the required final Astra-high feature/project review or account/device acceptance.

## Review evidence

Read the Task C1 brief/shared wire contract, implementation report, and supplied snapshot-relative diff. Checked current `calendar.ts` with line numbers and verified actual Git status/history against the checkpoint. Consulted the approved PRD, original system design, and calendar implementation plan for compatibility and task boundaries. The initial attempt to open `docs/SYSTEM_DESIGN.md` found no such file; the actual system design is `docs/superpowers/specs/2026-10-14-phone-monitor-design.md`.

Reviewed the following changed surfaces:

- `packages/protocol/src/calendar.ts:3`: display bounds count code points; opaque IDs/revisions are nonempty ASCII identifiers of at most 80 characters; safe cursor grammar is bounded to 256 characters. Gregorian date checks include leap-year rules, reject year zero and invalid month/day values, and preserve date-only values. Time-zone validation uses Intl and rejects fixed-offset inputs. Epochs, days, counts and reminders have the required integer/nonnegative/range bounds; nonfinite values cannot pass these numeric schemas.
- `packages/protocol/src/calendar.ts:30`: strict range/source/selection request schemas have the exact contract fields. Refresh true excludes a cursor. Selection IDs are unique and capped at 100. Exact state/error enums include setup_required and all six calendar transport codes.
- `packages/protocol/src/calendar.ts:36`: strict moment/event/source shapes match the contract. Matching endpoint kinds and positive duration are required; all-day exclusive ends stay dates; timed zones survive parsing. Empty titles normalize; cancelled rows are rejected; invitation response remains separate from event status. Label and calendar identity/color remain independent, with nullable unknown label metadata.
- `packages/protocol/src/calendar.ts:55`: page/source page shapes, strict nested range, 50-row/source limits, 100-source count limits, safe revisions/cursors and 128 KiB serialized UTF-8 limit are present. Item source identities must be covered on their page. An off-page nextEvent remains valid because it carries inline metadata; its eligibility excludes all-day, declined and ended rows.
- `packages/protocol/src/schema.ts`: all three new operation args, request union branches, per-operation reply maps and generic reply members align. Calendar read/source replies use the existing LinkSnapshot composition, preserving the nonnull payload age requirement; selection has its exact raw reply. Calendar domain has no reverse import, so no schema cycle is introduced. Existing HubSnapshot declarations and fixtures are preserved in the review diff; the intentional global safe-error enum extension is the specified change.
- `packages/protocol/src/index.ts`: domain schemas and every corresponding inferred domain type are exported. Existing schema exports remain available.
- Synthetic fixtures and tests cover strict objects, Unicode/serialized-byte budgets, invalid date/zone/duration/selection cases, setup state, off-page/eligible nextEvent, operation/reply mismatch, native age, and old snapshot compatibility. Compile-time contracts additionally protect the two linked reply payloads, selection reply and range args.

The compile-time test addition to the existing `type-contract.test-d.ts` is a small validation-only extension beyond the brief's named edit list. It supports the expressly requested exact typing check and does not widen product behavior; no corrective action is needed.

## Verification assessment and limits

Accepted the scoped report's recorded evidence: expected initial missing-feature failure; subsequent two failing relational tests before their refinements; final protocol **60 tests passed** (41 calendar plus 19 existing); protocol typecheck and build passed; diff whitespace check passed; old HubSnapshot declarations and pre-existing fixture bytes matched the saved baseline. I did not rerun those package checks because the diff presented no specific untested doubt requiring a focused reproduction, as requested by the coordinator. Current-source inspection agrees with the reviewed implementation.

Whole-range deterministic ordering and correct nextEvent choice, upstream/range capacity accounting, refresh throttling/backoff, cursor invalidation, connection-generation safety, account lifecycle, transport behavior, UI freshness and source-review gating remain C2/C3/C4 integration responsibilities. A structural protocol schema alone cannot establish those runtime behaviors. The reviewed nextEvent refinement enforces eligibility, not global optimality; the implementation report accurately distinguishes this.

No edits to production code, index/HEAD changes, commits, subagents, Google/account/auth access, device actions, host actions, live-service operations or external writes were performed by this reviewer. The only written artifact is this sanitized review report. The coordinator retains checkpoint ownership.
