# D1 independent task review

### Spec Compliance

- ❌ Issues found: the frozen error contract cannot express the approved queue-overflow result `QUEUE_FULL`; it exports `COMMAND_QUEUE_FULL` instead (`packages/protocol/src/schema.ts:18`; design requirement at `docs/superpowers/specs/2026-10-14-phone-monitor-design.md:200`). All requested D1 product files are present in the exact diff, including the six fixtures and workspace scripts. The supplied ruling authorizes Vitest 5.0.4/Vite 7; those pins are not a finding (`package.json:26`).
- ⚠️ Cannot verify from diff: the external user-local Node archive checksum/default-runtime preservation, real-loopback smoke execution, and the reported 35 passing tests/typecheck/build are execution evidence in `task-1-report.md`, rather than independently reproduced by this review. The sanitized saved audit report was read and reports zero vulnerabilities. Physical routing/device behavior, collectors, final packaging, and the final Astra/high project gate are later work, not D1 acceptance claims.
- ✅ Scope check: the baseline ignore rules are preserved and only `*.tsbuildinfo` is added (`.gitignore:15`); coordinator checkpoint files, Android/dashboard changes, sibling firmware, and provider captures are outside the diff. Deferred connect/package commands fail explicitly when their D3 scripts do not exist (`scripts/workspace.mjs:22`).

### Strengths

- Pairing is closed initially, cryptographically generated, expires at the specified boundary, counts malformed code attempts, and closes only after successful persistence (`desktop/src/pairing.ts:4`, `desktop/src/pairing.ts:10`, `desktop/src/pairing.ts:18`, `desktop/src/pairing.ts:29`). The HTTP concurrency test proves that only one concurrent request obtains a replacement token (`desktop/test/server.test.ts:69`).
- Token replacement writes a private exclusive temporary file, flushes it, and uses rename as its commit point; bearer comparison has exact syntax and constant-time comparison (`desktop/src/config.ts:41`, `desktop/src/config.ts:58`). Focused tests cover permissions, reload, old-token invalidation, and failed-persistence retention (`desktop/test/pairing.test.ts:36`, `desktop/test/pairing.test.ts:49`).
- The HTTP surface has exact Host/Origin checks, input limits, safe fixed errors, no request logging, and authenticated activity tracking (`desktop/src/server.ts:13`, `desktop/src/server.ts:15`, `desktop/src/server.ts:32`). Tests exercise invalid authorities, origins, credentials, malformed bodies, and oversize input (`desktop/test/server.test.ts:37`, `desktop/test/server.test.ts:54`).
- The store separates last good observations from failure state, computes read-time freshness, rejects capacity overflow without truncating good windows, defaults notification forwarding to deny, and drops oldest complete notifications for response size (`desktop/src/store.ts:17`, `desktop/src/store.ts:31`, `desktop/src/store.ts:48`). The Unicode budget stress test preserves all 64 usage windows and the newest complete notification (`desktop/test/server.test.ts:111`).
- Operation-specific strict args/reply schemas, setup-state consistency, safe generations, separate timer patches, cached-payload age validation, and independent compile-time type assertions make the shared boundary useful to both downstream workers (`packages/protocol/src/schema.ts:56`, `packages/protocol/src/schema.ts:66`, `packages/protocol/src/schema.ts:69`, `packages/protocol/src/schema.ts:75`, `packages/protocol/src/schema.ts:95`; `packages/protocol/test/type-contract.test-d.ts:6`).

### Issues

#### Critical (Must Fix)

- None found in this task diff.

#### Important (Should Fix)

- **D1-R1 — Preserve the required queue-overflow error name.** `packages/protocol/src/schema.ts:18` includes `COMMAND_QUEUE_FULL`, while `QUEUE_FULL` is absent from the fixed enum. The approved design explicitly requires excess discrete actions to return `QUEUE_FULL` (`docs/superpowers/specs/2026-10-14-phone-monitor-design.md:200`). A native implementation following that requirement will emit an error that the shared reply validator rejects; one following this enum silently changes the approved contract. Add/use `QUEUE_FULL` consistently, with a regression that accepts that fixed error in a failed `esp.set` reply. If the coordinator intentionally chooses the alternative name, record an explicit contract ruling and align the authoritative design and downstream consumers before accepting D1.

#### Minor (Nice to Have)

- **D1-R2 — Enforce the normalized ESP colour format.** `packages/protocol/src/schema.ts:52` accepts lowercase hex through `[0-9a-fA-F]`, whereas the normalized `EspState` format is six-digit uppercase RGB (`docs/superpowers/specs/2026-10-14-phone-monitor-design.md:198`). This weakens the common fixture/parser boundary and allows multiple spellings of a confirmed colour. Require `[0-9A-F]` for normalized state, or explicitly normalize at this boundary and test the output. This does not require rejecting lowercase user input in `LightPatchSchema`.

### Review evidence and scope

- Reviewed exact package `.superpowers/sdd/2026-10-14-desktop-hub/review-2a8ba20..8633669.diff`, base `2a8ba20572dabb36d26cc9206e26cc907bf67f08`, head `863366909acda1c2a44d56879664bf09e7190a76`, one pass in contiguous chunks. No changed source file was separately reread; no truncated diff hunk needed recovery.
- Read the task reviewer template, D1 brief/report, handoff/status/ledger, PRD, and relevant shared-protocol/API design requirements. The only focused follow-up was the exact authoritative queue-overflow and uppercase-format wording; no broader codebase crawl or downstream worker inspection occurred.
- Read saved `task-1-audit-after.json`: vulnerabilities empty, total zero. No suites were rerun: the two findings are direct static contract mismatches and do not require regenerating the already reported suite evidence.
- No checkout, index, HEAD, branch, application source, or shared checkpoint mutation. Only this requested ignored review report was written. No subagents, hardware/provider access, or external messages were used.

### Assessment

**Task quality:** Needs fixes.

**Reasoning:** D1 is cohesive and has meaningful boundary/failure tests; the hub/pairing implementation is substantially aligned with the approved design. Resolve the fixed error-code contract mismatch before freezing D1 for Android/dashboard integration; the uppercase state validation is a small additional consistency fix.
