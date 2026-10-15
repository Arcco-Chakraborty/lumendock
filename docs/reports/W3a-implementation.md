# W3a - Android-independent packaging, accessibility and e2e

Date: 2026-10-15. Author: Claude Code (claude-sonnet-5-5). Status: implemented, uncommitted; independent review pending. Scope: no `android/**`, `scripts/build.mjs`, `scripts/workspace.mjs`, `desktop/src`, `packages/**` or handoff docs touched.

## Files
- Dashboard e2e: `dashboard/playwright.config.ts`, `dashboard/e2e/{dashboard.spec.ts,bridge.ts,harness.ts,tsconfig.json}`, 15 screenshots `dashboard/evidence/w3a-*.png` (synthetic only).
- Packaging: `scripts/package.mjs`, `scripts/lib/{run,frontend,rules,archive,package-build}.mjs`; tests `dashboard/test/packaging.test.mjs` (57 tests; `.mjs` so vitest runs it without type shims).
- Fixes in `dashboard/src`: `App.tsx`, `styles.css`, `components/ClimateCard.tsx`; config: `dashboard/vite.config.ts` (vitest excludes `e2e/`), `dashboard/package.json`, root `package.json` (+`test:e2e`), `package-lock.json`; docs: appended section in `docs/TESTING.md`.

## Commands (Node 24.22.0; all run 2026-10-15)
- `npm run typecheck`: pass (dashboard now also typechecks `e2e/`).
- `npm test`: protocol 15, desktop 180, dashboard 110 (53 pre-existing + 57 packaging) - all pass.
- `npm run build`, `npm run verify`: pass (JS+CSS 336704 B of 768000 B budget).
- `npm run test:e2e`: 18/18 pass, three consecutive runs (about 11 s). Chrome 155 via `channel: "chrome"`, no browser download.
- `npm run package`: pass; `sha256sum -c` OK; two runs byte-identical (also unit-tested); `-- --build` and bad-argument exit code (2) exercised.
- Clean-install proof: extracted the tarball in a scratch dir, `npm ci --omit=dev --workspace @phone-monitor/desktop` succeeded (51 packages, 0 vulnerabilities) and `npm run doctor -- --json` ran from it.

## Dependency
`@playwright/test` 1.63.0 (released 2026-09-04), exact-pinned in `dashboard` devDependencies. `npm audit`: 0 vulnerabilities. Install had network access. Lockfile gained 3 packages (@playwright/test, playwright, playwright-core).

## Design decisions
- The e2e tests the production bundle (`vite build` then `vite preview`). The fake bridge lives only in `e2e/bridge.ts` (`addInitScript`); every payload is parsed with the shared protocol schemas first. A test asserts dist has no mock/demo/synthetic markers or non-allowlisted URLs, `?demo` is inert in production, and every test fails on console errors or non-local requests.
- Layout checks use real bounding boxes (inside viewport, >= 44 px), clipping, region overlap, control-over-text overlap, and font size floors (14 px text, 32 px numbers).
- "Increased text" is emulated by scaling every authored px `font-size` by 1.3 (WebView `textZoom` approximation).
- Package contents: `desktop/dist` and `packages/protocol/dist` (no `.d.ts`), workspace manifests plus root lockfile (so `npm ci --omit=dev --workspace @phone-monitor/desktop` is exact), `docs/SETUP.md`, `docs/TESTING.md`, the thin setup wrappers `scripts/{workspace,doctor,connect,install-hub,uninstall-hub,claude-*}.mjs` + `scripts/lib/dist.mjs` (SETUP.md commands need them), `.nvmrc`, generated `INSTALL.txt`. Dashboard assets are verified but not shipped (they belong in the APK).
- Exclusion is fail-closed: a secret-like name, `.config`, `node_modules`, Node binary, toolchain path, private key or absolute home path among the inputs aborts packaging rather than being silently dropped. APK is read from `artifacts/phone-monitor-*.apk` (nothing copies it there yet); absence is recorded in the manifest.
- `npm run verify` unchanged: e2e needs a local Chrome, so it is a separate documented command (`npm run test:e2e`).

## Defects found and fixed
1. 740x320: the 44 px "..." details button covered the bucket duration text ("300 minutes"); found by the new control/text overlap check. CSS reserves 44 px on the label row (long bucket names now ellipsize at 740 px).
2. Sheet reopen race: the queued dialog `close` event ran `setSheet(null)` and `opener.focus()` after a new sheet had opened or focus had moved, intermittently closing the new sheet or stealing focus (reproduced about 1 in 3 runs by fast keyboard use). `onClose` now only resets state when the dialog is not open; the open/close effect restores focus. Stable over 40+ open/close cycles.
3. 360x800 at 130% text: the two link-status chips left the viewport (horizontal overflow); `.connections` now wraps.
4. Room history read "1 minutes ago"; now pluralizes.

## Observations (not changed)
- When USB drops, retained quotas are marked stale only after their own freshness limit (Claude 5 min, Codex 2 min); the header shows "Laptop disconnected" immediately and each row shows its report age.
- At 740x320 the compact usage label truncates (e.g. "Synthetic fiv..."); full text is in the Windows sheet.
- The two upstream zod `@__PURE__` Rollup warnings during `vite build` remain (W1-R2/W3 triage not done).

## NOT verified
Real Redmi WebView/viewport, Android `textZoom`, bridge implementation on Android, APK build/size/startup, Gradle asset wiring (`build.mjs`, Android tasks), device rows of the acceptance matrix (A01-A17 device parts), soaks, and any ESP32 behaviour. The packaged APK path is untested with a real APK (only synthetic files). Diagnostic-marker scan is regex based and could false-positive if a dependency starts containing the word "diagnostic".
