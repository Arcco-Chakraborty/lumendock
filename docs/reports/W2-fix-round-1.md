# W2 task report

Original implementation report: `docs/reports/W2-implementation.md`. This file records subsequent scoped fixes without overwriting the original evidence.

## Fix round 1 — 2026-10-15

Scope: W2-R1, W2-R2 and the adjacent W2-M1 visual follow-up from `task-2-review.md`. Prior implementation evidence remains in [docs/reports/W2-implementation.md](../../../docs/reports/W2-implementation.md). The coordinating agent owns checkpoint records and independent re-review. No staging or commit performed for this fix round.

### W2-R1: retained outcomes and fresh observations

- Added per-kind consumed generation/outcome tracking. Repeated retained outcomes and duplicate bridge replies no longer replace a newer observed sample. A native confirmed transition remains terminal even when the UI retains another uncertain field.
- Consume outcome transitions before applying `EspSnapshot.data`, so a snapshot's current observation wins over the historical `CommandResult.state`. Keep the generation check that rejects genuinely pre-command polls; older generations still cannot clear a newer desired intent. Unconfirmed-to-confirmed native reconciliation remains supported.
- Three new regressions cover: confirmed brightness 25/timer 0 followed by observed brightness 50/timer 120 with the same retained generation; first encountering confirmation in a later snapshot whose data has already changed; and timer confirmation 300 followed by observed countdown 270 then 267. Both state/timer cases also replay the duplicate reply.
- RED: `npm run test --workspace @phone-monitor/dashboard -- lightIntent.test.ts` — 17 tests, 3 failed / 14 passed; observed failures were `25` versus expected `50` (two cases), and `300` versus expected `270`.
- GREEN: the same command — 17/17 passed. Existing old-poll, newer-intent, ordinary/timer separation, cross-field uncertainty, queue and teardown cases remain passing.

### W2-R2: actual primary window identity and duration

- Primary cards now show the actual server label and actual `windowDurationMins`. A nonshrinking duration stays visible; unusually long identity text may ellipsize, with full text retained in the title/details sheet. Reset countdown and report age share one compact line to make room without reducing 32px primary values or 14px secondary text.
- Browser RED before the CSS repair: at 740x320, the Codex `.quota-label` contained `Synthetic custom bucket 45 minutes` but `isVisible()` was false.
- Browser GREEN using `?demo=over-limit`: actual `45 minutes` and the server identity are visible at both 740x320 and 800x360. The full label is retained in DOM/title, with ellipsis at the smaller width. Percentage remains `120% used`, independently of its clamped graphic.
- Actual Playwright assertions checked visible identity/duration, page bounds, card/footer separation, and visible controls' minimum 44x44 targets. At 740x320, page was 740x320, card bottom 267, footer top 275, small targets 0. At 800x360, page was 800x360, card bottom 307, footer top 315, small targets 0.
- Screenshots: `dashboard/evidence/w2-fix1-740-nonstandard.png` and `dashboard/evidence/w2-fix1-800-nonstandard.png`. Both were captured from actual browser rendering and the 740px image was inspected visually.

### W2-M1: narrow notification evidence

- Kept source/age and title on separate lines and added a 3px title margin at narrow widths. Refreshed `dashboard/evidence/w2-fix1-360-notifications.png` from final CSS/markup; full-page portrait width is 360px. Browser measurement: source bottom 1059.453125, title top 1062.453125, gap 3px. The refreshed image was inspected; source and title are separated.

### Final scoped validation

All commands used the explicit user-local Node24.22.0 path in PATH; system defaults unchanged.

- `npm run test --workspace @phone-monitor/dashboard` — exit 0; 7 files, **53/53 tests passed** (the original 50 plus the three retained-outcome regressions).
- `npm run typecheck --workspace @phone-monitor/dashboard` — exit 0.
- `npm run build --workspace @phone-monitor/dashboard` — exit 0; Vite7.3.7, 135 modules. JS `index-iWVfUVKH.js` **325973 bytes**, CSS `index-Bt43Yx0H.css` **10582 bytes**; combined **336555 bytes**, below 750 KiB.
- Build still emits the two previously tracked upstream Zod misplaced `@__PURE__` annotation warnings in `zod/v4/core/util.js:400` and `regexes.js:74`. No suppression or dependency change; W1-R2 remains W3/final triage.
- `git diff --check -- dashboard` — no whitespace errors.
- No aggregate workspace checks repeated during this scoped repair; desktop/Android remain under separate owners. No device, real WebView/native bridge, ESP32, provider/account capture, APK/PSS/startup, or simultaneous USB/Wi-Fi acceptance ran. This is dashboard software evidence, not device acceptance or final project approval.

Status: **READY for independent scoped re-review; no fix-round commit yet.**

### Serialized checkpoint

Coordinator authorized the scoped W2 fix commit from baseline `8e13952e7baed6e6579b10376bee11f45cdf195e`. Committed only four dashboard repair source/test files and three synthetic screenshots. Exact HEAD: `571d45d244a410bac37340d38264afc1f50ed011` (`fix: preserve observed light state and show quota windows`). Ignored build output, dependencies, coordinator records and other owners' files were excluded. The validation above is unchanged; independent scoped re-review remains pending.
