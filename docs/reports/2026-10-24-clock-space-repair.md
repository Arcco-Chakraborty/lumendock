# Clock space and clipping repair — 2026-10-24

The latest human request rejected the small clock, wasted screen space and clipped timer after a further styling pass. The repair now sizes the display from actual available space, places landscape controls beside it, stacks Fit screen cards in portrait, and fits timer/setup/alarm controls without the reproduced clipping. AM/PM and optional seconds use card corners. Reveal geometry stays steady; scheduling, audio, flip implementation and other app pages are preserved.

Execution root: `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`, detached `8e8ddcc`, preserving prior dirty source. No staging, commit, push or publication. Baseline current source/checkpoints and340 existing PNGs are preserved in ignored `.superpowers/clock-space-2026-10-24/baseline`.

## Causes and scope

Hidden navigation previously reserved100px landscape and220px narrow portrait. Fixed viewport/status clamps limited the clock, and a global max-width649 timer rule overrode the current layout around600–649px, forcing setup below its clipped scrolling ancestor. Old tests allowed vertical scroll and omitted setup inputs/overflow ancestors. Fail-first actual repro: low740px clock coverage and unreachable601px setup controls both failed before implementation (`red.log`).

Changed product files: `dashboard/src/components/ClockView.tsx`, `dashboard/src/components/clock.css`, and removal of exactly4 obsolete Clock selectors in `dashboard/src/styles.css`. Added `dashboard/e2e/clock-space.spec.ts` and current PRD/brief. Six reviewed files/hashes in ignored task manifest. Fit screen uses stored false unchanged but now adapts to orientation; explicit saved true still means stacked. This implements current human screen-use requirements without deleting preferences. TimeStore, audio, FlipCard, App, Monitor/Agenda, backend/native and dependencies are unchanged by this task.

## Evidence

- Final dashboard unit suite **209/209 pass**, source and E2E TypeScript checks pass.
- Final focused Clock browser suite **39/39 pass**, including20 new geometry/reachability checks and retained19 Clock interactions. Full dashboard production browser regression **113/113 pass**, exit0. All use synthetic bridge/disabled audio in installed Chrome.
- New checks cover actual flap union thresholds; setup/alarm form controls against viewport and every clipping ancestor; center hit targets; circular radius containment of countdown glyphs; exact stable clock/ring reveal bounds;600/601/649/650x360,740x320,800x360,320x800,360x800 at100/130% text.
- Initial full focused attempt had38/39 pass: larger text clipped the narrow portrait Stopwatch label. Content-proportioned tab widths fixed it without shrinking text; final39/39 pass. Initial E2E tuple annotations failed typecheck, corrected readonly tuples; final typecheck clean. Failure logs retained. Existing tests were not weakened.
- Actual independent **gpt-6.1-sol high scoped review** approved with no actionable/open P1/P2, `docs/reviews/2026-10-24-clock-space-review.md`. Independent16-combination probes include upcoming alarm, saved stacked,80-character labels,24h countdown, pause/reveal, rotation, fold/reduced-motion and keyboard/native modal behavior. Personally inspected10 synthetic screenshots. Earlier Astra quota failure was not approval; this is not whole-project Astra review.
- Independent actual flap union with upcoming alarm:740x320 **532.25x226.7px (71.9% width/70.8% height)**;800x360 **590.5x251.9px (73.8%/70.0%)**;320x800 **289.1x504.1px (90.4%/63.0%)**;360x800 **324.1x564.6px (90.0%/70.6%)**. These are axis/union measurements, not physical area percentages. Timer SVG diameter **288px at740x320 /328px at800x360**, previously204/244px.
- All6 reviewed source/spec hashes and5 reviewed bundle files matched before/after signed build. All340 baseline PNGs unchanged. New evidence is isolated under ignored task directory; representative quiet preview in `reviewer/quiet-clock-800x360.png`.

## Signed build and phone

`node scripts/build.mjs --release` passed, release lint/build clean,76 tasks (9 executed/67 up-to-date), existing upstream Zod annotation notices only. Native unit task was UP-TO-DATE, not freshly executed; cached XML150 tests with0 failures/errors/skips. No native changes.

Artifact `artifacts/lumendock-1.3.2.apk`, SHA-256 `9af60c9f76d1e3acbb8470c8671524bb1061e6669c3efde861801f1a4d24ce9d`. Certificate verified against the installed release; all5 reviewed dist assets matched packaged bytes. Selected authorized phone generic720x1600/320dpi metrics support360x800/800x360 CSS targets. Before-install APK saved privately and immediate pre-install hash checked unchanged. In-place install succeeded, MainActivity launched; pulled installed APK exactly matches candidate SHA-256. No OS grants, uninstall/wipe, private capture, real audio/ESP32 or host actions.

**Software verified and installed on phone; physical acceptance unobserved.** Actual desk/phone rendering and audible alarm acceptance remain for human use. Existing foreground/current-session timer/alarm limits and whole-project physical/Astra gates remain separate. Private selected identifier/rollback APKs stay ignored in task deploy storage.
