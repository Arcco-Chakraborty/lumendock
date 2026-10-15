## Spec Compliance

- ❌ Issues found: W2-R1 lets retained command outcomes replace newer observed confirmation; W2-R2 hides the actual quota duration and row identity on the primary landscape cards. Both conflict with the required presentation/observation behavior.
- ✅ All requested implementation/test files are represented in the supplied diff. W1-R1 is addressed by merging the typed display result into the latest AppStatus (`dashboard/src/store.ts:218`), with the newer-generation/setup race regression at `dashboard/test/store.test.ts:211`.
- ⚠️ Native origin enforcement, post-dispatch read provenance, native rate limits, actual setup dialogs, packaged startup/APK/PSS limits, simultaneous USB/Wi-Fi routing, and physical acceptance span other tasks and cannot be established from this dashboard diff. Hardware acceptance remains deferred.

## Strengths

- `dashboard/src/lib/lightIntent.ts:96`: Per-field ordinary merges, timer barriers, a four-unit unsent limit, superseded callback settlement, and explicit power-off cancellation are implemented without automatically replaying actions; the targeted queue tests exercise meaningful ordering and loss scenarios (`dashboard/test/lightIntent.test.ts:43`).
- `dashboard/src/components/UsageCard.tsx:16`: Row freshness uses each row's own report timestamp; numeric zero/fractional/over-limit values remain intact while only the SVG fill clamps (`dashboard/src/components/UsageCard.tsx:53`). The unchanged store clock bodies preserve sample-plus-age anchoring and monotonic outage aging (`dashboard/src/store.ts:71`, `dashboard/src/store.ts:151`); the added 30-minute/recreated-view case is at `dashboard/test/store.test.ts:239`.
- `dashboard/src/components/NotificationStrip.tsx:24`: Notifications expire against sampled laptop time and render as escaped React text. Sensor failure remains separate from lighting, and the chart uses null gaps and bounded relative offsets (`dashboard/src/components/ClimateCard.tsx:7`).
- `dashboard/src/components/SettingsSheet.tsx:6`: Setup presentation follows typed completion/cancellation/expiry status; acknowledgments do not announce success. The added long-setup/duplicate regression exercises that distinction (`dashboard/test/store.test.ts:284`).

## Issues

### Critical (Must Fix)

- None.

### Important (Should Fix)

- **W2-R1 — Do not reapply historical result state over a fresh observation.** `dashboard/src/lib/lightIntent.ts:251` (also `:186`): `applySnapshot` first accepts fresh `snapshot.data`, then replays each retained command result through `ack`; equality with `confirmedGeneration` permits its historical `result.state` to overwrite that fresh data on every poll. A focused replay of this exact diff confirmed: generation 10 confirms brightness 25/timer 0; a later poll observes brightness 50/timer 120 and retains that generation's outcome; the resulting desired brightness is 50 but confirmed brightness is 25 and confirmed timer is 0, still marked confirmed. This breaks the observed/confirmed display and freezes or regresses timer remaining after ordinary physical changes or normal countdown. Consume outcome transitions without repeatedly replacing newer observation data, while retaining the existing protection against genuinely pre-command polls. Add a regression with a retained confirmed result and later changed observed fields/timer.
- **W2-R2 — Keep the actual window duration visible on landscape usage cards.** `dashboard/src/styles.css:459`: The compact-card rule hides the entire `.quota-label`, including the only actual `windowDurationMins` text rendered at `dashboard/src/components/UsageCard.tsx:25`. Both supplied 800×360 and 740×320 screenshots show only provider, percentage, reset countdown and age. A reset countdown is not the window length, so an arbitrary Codex bucket cannot be interpreted without opening its sheet; its server row label is also hidden. The PRD explicitly requires the usage cards to show actual window length (PRD:51), and W2 requires actual duration/server labels. Retain a compact visible duration/identity for the primary row, with longer lists/details in the sheet, and verify both target landscape sizes with a nonstandard bucket duration.

### Minor (Nice to Have)

- **W2-M1 — Refresh the narrow notification evidence after the spacing rule.** `dashboard/src/styles.css:731`: The supplied 360px screenshot still joins `0s ago` directly to `Synthetic title`; the final added block-display rule appears intended to address it. The image therefore does not demonstrate that final rule's result. Refresh this synthetic screenshot during W3's browser verification and retain a small separation between source/age and title. This is visual polish, not a blocking product failure.
- **W1-R2 remains deferred:** `docs/reports/W2-implementation.md:13` records the same two upstream Zod annotation warnings. They remain W3/final triage, as assigned; this review does not reopen that scope or recommend blanket suppression.

## Assessment

**Task quality: Needs fixes.**

**Reasoning:** The component boundaries, bounded intent queue, safe text rendering and typed setup flow are sound, but historical command-state replay produces an incorrect confirmation view, and the primary landscape cards omit a required quota dimension. Resolve W2-R1/R2 before closing the W2 gate.

## Checks and evidence limits

- Reviewed the supplied exact `cae591476b971e4c45368858092cd86c87a0f276..57bb5c5d1f0d5036a7aa4617902a8a8a71f18680` package once in contiguous chunks; extracted line references from its hunk metadata. Read the brief, implementer report, W1 review and checkpoint records.
- Focused contract check: design:129/202 and PRD:51/73 establish retained per-kind outcomes, fresh physical observations, and the actual-duration requirement. Focused omitted-hunk check: read the unchanged clock/snapshot/applyHub bodies in `store.ts:45–190` because the supplied store hunk starts inside `snapshot()` and does not include its clock implementation; this checked monotonic outage aging rather than broadening the review.
- Ran one focused in-memory Node 24/TypeScript replay of the controller reconstructed from the exact diff, with synthetic protocol fixture data and an injected clock; observed W2-R1 output `{observedBright:50, desiredBright:50, confirmedBright:25, observedTimer:120, confirmedTimer:0, outcome:"confirmed"}`. No checkout source/test, index, HEAD or branch mutation; no suite rerun.
- Inspected supplied synthetic 800×360, 740×320, 360px portrait and expanded-light screenshots. Static render tests do not establish live focus/drag behavior; W3 should verify those interactions in-browser. The reported 50 dashboard tests/131 workspace tests, typecheck, build and 335540-byte JS/CSS total remain implementer execution evidence, not independently rerun results.
- No subagents, provider inference, credentials, private captures or physical device operations used. Only this requested review report was written.
