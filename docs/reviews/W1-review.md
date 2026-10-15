# W1 independent task review

## Spec Compliance

- ✅ Spec compliant for W1 scaffold/transport/store scope. Reviewed `26c4e541f52050b64216b6c23c524b8c5e26b3a9..f6694f985b03bfba55a305a9989e471f50ed855c` from the supplied review package, in contiguous passes. No blocking missing, extra, or misunderstood W1 requirement found.
- ✅ Operation-specific response validation and bounded pending work are implemented at `dashboard/src/device.ts:98` and `dashboard/src/device.ts:130`; shared `SESSION_ENDED`, `QUEUE_FULL`, and uppercase fixture-state rulings are respected.
- ✅ Cached laptop time anchors to sample plus native age and cannot rewind (`dashboard/src/store.ts:137`); source polls have independent in-flight exclusion (`dashboard/src/store.ts:205`); the setup-status follow-up handles an older outstanding read (`dashboard/src/store.ts:236`).
- ✅ Explicit development fixture loading is guarded by `import.meta.env.DEV` (`dashboard/src/main.tsx:22`); production CSP is retained (`dashboard/index.html:8`), with relative assets and ES2018 configured (`dashboard/vite.config.ts:15`).
- ⚠️ Native origin/main-frame enforcement, packaged Android delivery, physical dual-link routing, real startup/resource measurements, and device acceptance span later/native tasks and cannot be verified from this diff. Full widgets, lighting intents, history, notification detail, and complete setup outcomes belong to W2; packaging/browser integration belongs to W3.
- ⚠️ Root workspace script aggregation is unchanged and not visible in the diff; report lines 47–48 record successful aggregate tests/typecheck. The lack of a root package.json edit is therefore not treated as missing functionality.

## Strengths

- `dashboard/src/device.ts:98`: Pending entries retain their expected operation, so a valid ID cannot make an unrelated payload schema acceptable. The tests exercise out-of-order replies, malformed envelopes, late callbacks, deadlines, teardown, and request capacity rather than just happy-path serialization.
- `dashboard/src/store.ts:137`: The independent link/cache model and monotonic epoch projection address outage aging without relying on phone wall time. Tests cover stale-threshold crossing, expiration during outage, and avoiding clock rewind on repeated cached samples.
- `dashboard/src/main.tsx:22` and `dashboard/index.html:8`: Synthetic fixtures have an explicit development boundary, and the production fallback explains how to connect rather than inventing live readings.
- `dashboard/src/styles.css:1`: The shell follows the requested charcoal/cyan/amber direction with system typography and compiled CSS. Inspected the supplied 800×360 ESP-offline and 740×320 USB-offline PNGs: readable independent connection states, retained room data, three columns, and a compact notification strip fit the captured viewports.

## Issues

### Critical

- None.

### Important

- None for W1 scope.

### Minor

- **W1-R1 — Preserve current app status when applying a display-setting reply.** `dashboard/src/App.tsx:241`: The screen-on handler discards the typed native reply and spreads the AppStatus snapshot captured before its await. A newer status received meanwhile can be replaced by the older setup/generation fields. Use the returned `screenOn`/`brightness` values and merge only those display fields into the latest store state, ideally through a store method. Add a focused interaction regression when W2 completes settings: deliver a newer app.status while the display request waits and ensure its non-display fields survive.
- **W1-R2 — Build output still contains dependency annotation warnings.** `dashboard/package.json:9`, `.superpowers/sdd/2026-10-14-dashboard/task-1-report.md:49`: The reported production build passes but emits two misplaced upstream Zod `@__PURE__` warnings. This is disclosed and does not imply a runtime failure; it is still non-pristine validation output. Track the exact upstream warning and remove it through a compatible dependency correction when available; do not globally suppress unrelated build warnings.

## Assessment

**Task quality: Approved, with minor follow-ups.**

The diff implements a coherent, bounded transport and independently aging source store with meaningful focused tests and an intentional shell. The report correctly keeps W2/W3 and physical acceptance unclaimed; neither minor issue blocks using this scaffold for W2.

## Checks and evidence limits

- Read the reviewer instructions, task brief, complete implementer report, supplied exact diff, and live handoff/status/progress. Used the diff as the source review input; no changed implementation file was reread separately and no other worker's implementation was inspected.
- Focused contract/lifecycle checks: PRD freshness/clock/setup expectations, design AppStatus/display-reply contract and frontend lifecycle sections, and dashboard plan W2/W3 allocations. These checks resolved whether apparent unfinished UI work was a W1 omission and whether display-setting code could overwrite status.
- Extracted precise source-line references mechanically from diff metadata; no Git commands, implementation mutations, subagents, account access, or suite reruns.
- Inspected two supplied landscape screenshots; did not rerun browser/layout checks. Asset size, zero-audit result, the reported 57-test aggregate run, typecheck/build, production asset scan, and browser smoke remain implementer-recorded execution evidence rather than independently repeated results.
- This review approves W1 only. Software integration, device acceptance, and final fresh Astra/high project review remain separate gates.
