# Flip desk clock and circular timer — independent review, 2026-10-24

Reviewer: independent review pass following the task-specific brief `docs/superpowers/specs/2026-10-24-flip-clock-brief.md`. Scope: reference split-flap clock presentation and circular countdown timer visual revision against preserved baseline at `.superpowers/flip-clock-2026-10-24/baseline`; canonical checkout at detached `8e8ddcc`. This is not a broad whole-project or physical-device acceptance review.

## Review and geometry findings

Initial UI worker implementation delivered two split-flap hour/minute cards, 3D page folding on value change, reduced-motion suppression, and a circular timer ring. Verification probes (`.superpowers/flip-clock-2026-10-24/reviewer-probes.mjs`) identified geometry regressions across target viewports and 130% text scaling:

1. **Landscape card overflow with active status (740×320 and 800×360)**:
   - When timer status was active on the clock screen, stacked layout exceeded `.clock-body` bounds because `.has-clock-status .wallpaper-stacked-digits` was sized at `13vh` or `16vh` and `max-height: 340px` omitted 800×360.
   - Long 80-character status labels in horizontal layout also pushed `.wallpaper-status-row` outside the 196px body height at 740×320.
   - Fixed by expanding the landscape media query to `(min-width: 601px) and (max-height: 420px)`, reducing horizontal clock font-size with status to `min(20vw, 22vh)`, reducing stacked clock font-size with status to `min(24vw, 10vh)`, tightening container gap to 2px, and padding the status pill at `3px 8px`.

2. **Timer ring movement on control reveal (320×800 text130)**:
   - On narrow portrait screens under 130% text scaling, revealing controls caused the circular timer ring to shift upward by 9.2px.
   - Investigation revealed that "+1 Min" wrapped to two lines inside the action button under 19.5px font-size, expanding the action row from 44px to 62.4px and displacing the vertically centered flex layout.
   - Fixed by setting `white-space: nowrap` on `.timer-actions-row button` and adjusting narrow-screen button padding to `6px 8px` at `max-width: 400px`, keeping the action row height strictly at 44px whether controls are hidden or shown.

3. **Small-viewport 740×320 default clock height at text130**:
   - The default horizontal digits box font size was set at `min(24vw, 37vh)` (up from baseline `34vh`), causing date and detail rows to overflow the 196px body by 3.3px each under 130% zoom.
   - Fixed by restoring the baseline's `min(24vw, 34vh)` font-size.

## Verification results

- All 11 reviewer probes in `.superpowers/flip-clock-2026-10-24/reviewer-probes.mjs` passed cleanly:
  - `actual fold stages, changed values, settling and reduced motion`: PASS (matrix3d 3D fold, aria-hidden leaves, 640ms cleanup, instant update under reduced motion).
  - `24h timer and geometry 740x320 text100`: PASS.
  - `24h timer and geometry 740x320 text130`: PASS.
  - `24h timer and geometry 320x800 text100`: PASS.
  - `24h timer and geometry 320x800 text130`: PASS (zero ring or readout movement on control reveal).
  - `24h timer and geometry 800x360 text100`: PASS.
  - `24h timer and geometry 800x360 text130`: PASS.
  - `24h timer and geometry 360x800 text100`: PASS.
  - `24h timer and geometry 360x800 text130`: PASS.
  - `maximum label on clock 740x320`: PASS (80-character status label contained within bounds).
  - `maximum label on clock 320x800`: PASS.
- Full workspace unit tests: **556/556 passed** (protocol 60, desktop 287, dashboard 209).
- Workspace typecheck: clean across all packages.
- Full Playwright E2E suite: **93/93 passed** against production bundle in installed Chrome.
- Production signed release build: `artifacts/lumendock-1.3.2.apk` verified with apksigner (v2 scheme, certificate SHA-256 `595f8aa4be43bad2cbe532ac06a9e811d0b1f8eb81f4d8d68b76a11c67f63933`).

## Verdict

**Approved for installation.** All geometry regressions resolved with zero open P1/P2 issues. Software verified; device acceptance remains separate pending physical phone usage.
