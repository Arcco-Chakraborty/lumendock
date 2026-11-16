# Clock menu, date and centering refinement — 2026-10-24

The user accepts the improved display/timer layout and requested a better menu, moved date and centered clock. Implemented a restrained grouped palette with labeled modes and Back/Appearance icon actions, plus one44px show/hide menu button exposing expanded state. Removed duplicate Focus/hide controls. Date is below the cards; actual card union stays centered on both viewport axes, including when controls or statuses appear. Metadata uses available display width independently of saved narrow stacked cards. Timer body/form dimensions and all timing/audio/native behavior remain unchanged.

Canonical detached8e8ddcc checkout at `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`; prior dirty work preserved. Baseline current files/checkpoints and340 PNGs saved in ignored `.superpowers/clock-menu-2026-10-24/baseline`. Product files: ClockView.tsx and clock.css only; new clock-menu.spec.ts plus PRD/brief. No commit/staging/push/publication.

## Verification and retained findings

- Fail-first740px test established the old card union10.99px below vertical center. New tests check within1px on both axes, date below/centered/one line, menu disclosure/unified actions and unchanged reveal geometry.
- First combined47-case attempt43passed/4failed: new portrait palette overlapped idle circle. Palette chrome height reduced, preserving timer size; targeted4/4 passed. Initial full121/121 passed, but independent review found a saved-layout case outside the initial8 new tests.
- Independent P2: saved-stacked landscape metadata inherited narrow face width. Date wrapped2 lines below320px viewport (321.296875px bottom); normal paused Focus status truncated. Root added failing saved-stacked130% test, reproduced exact result, then widened/centered metadata independently of cards. Both saved layouts now covered in16 new tests, with explicit one-line date/full normal paused status checks. Prior manifests/diff retained with `.before-stacked-fix`; original failure/report history retained.
- Final source/E2E TypeScript and production build pass; dashboard **209/209 unit tests** pass. Final complete production browser suite **129/129 pass**, including16 new menu/centering tests and all113 prior tests. Synthetic bridge, disabled audio, installed Chrome; no real account/phone capture.
- Fresh independent **gpt-6.1-sol high scoped review approved after correction**, no open actionable/P1/P2 findings. Independent112 state checks across16 viewport/text/layout combinations, personal screenshot inspection, keyboard/Appearance/Back/disclosure checks pass. `docs/reviews/2026-10-24-clock-menu-review.md` retains finding/resolution and harness corrections. Whole-project Astra/physical approval is not claimed.
- All5 frozen source/spec hashes and5 reviewed production files match before/after signed build. All340 baseline PNGs unchanged. Task evidence/logs/manifests remain ignored.

## Package and phone

Signed build/release lint passed:76 tasks,9 executed/67 up-to-date,11s. Native unit task UP-TO-DATE; cached XML150 tests with0 failures/errors/skips, not freshly rerun. No native source changes.

Artifact `artifacts/lumendock-1.3.2.apk`, SHA256 `1531a1d3f15b57bda16dd0a69bf42874f172bdba91878ea8306cc7551ff46c82`. Certificate matches prior installed release; all5 reviewed bundle files equal APK assets. Current accepted pre-menu APK privately backed up, immediate installed hash confirmed unchanged. Authorized selected-phone `install -r` succeeded, MainActivity launched, pulled installed APK exactly matches candidate SHA256. No OS grants, uninstall/wipe, private capture, real audio/lamp/host action, commit or publishing.

**Software verified and installed; physical acceptance unobserved for this refinement.** Existing foreground/session timing limits and whole-project hardware/Astra review remain separate. Private selected-device identifier and rollback APKs remain ignored in task deploy storage.
