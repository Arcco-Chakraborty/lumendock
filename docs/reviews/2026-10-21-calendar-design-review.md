# Calendar agenda design review

Date: 2026-10-21, Asia/Kolkata. Scope: `docs/superpowers/specs/2026-10-21-calendar-agenda-design.md`, source inspected at `8e8ddcc` plus existing uncommitted 1.3.2 changes. This is a design review, not a product or device acceptance review.

Required reviewer: `gpt-6-astra`, `high` reasoning effort, fresh independent review task `calendar_design_review` in the current session. First verdict: **needs_fixes**. Scoped second verdict after corrections: **suitable_for_user_review**, no residual design blockers. User approval remains pending.

## Findings and resolution

1. P2: the promised inclusion sheet lacked source identifiers/enumeration/selection operations. Resolved with opaque source IDs, fixed authenticated source/selection POST endpoints and typed bridge operations, paginated enumeration, desktop-persisted inclusion, duplicate-name suffixes, and selection-generation rejection of late results. Initial inclusion and future-calendar opt-in are explicit.
2. P2: response pages were bounded, but aggregate range cache, staging and job queue were not. Resolved with 1–31-day ranges, at most three ranges/16 MiB cache, 10,000 occurrences per range, 16 MiB staging, 2 MiB upstream response limit, bounded upstream concurrency and one active/one latest pending job. Capacity failures preserve complete old results and explain narrower-range recovery.
3. P2: declined invitations were promised without a distinct self-attendee response field. Resolved with optional `selfResponseStatus`, kept separate from event status; attendee identities are discarded. Added confirmed-event/self-declined fixtures.

The rereviewer confirmed all three changes and the corresponding verification requirements. Desktop-owned OAuth, separate calendar endpoints for old-APK compatibility, and cautious handling of documented Google event labels were accepted for user review.

## Remaining evidence gates

- The user must review the concrete proposed feature and mockup before implementation, per AGENTS.md.
- Google OAuth client/consent setup has not been performed. No Google account, event or token was read.
- Named-label read behavior has a guide/discovery-document mismatch; authenticated human-provided synthetic fixtures are required before claiming parity.
- No calendar product code, APK build/install, product tests, device acceptance, commit, push or release occurred in this task.
- Mockup-only browser checks are recorded separately in the progress checkpoint; they do not establish calendar sync behavior.
