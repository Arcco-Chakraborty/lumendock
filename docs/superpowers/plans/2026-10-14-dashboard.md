# Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a polished, light Redmi dashboard with honest usage/freshness states, readable climate, responsive light controls, and private selected notifications.

**Architecture:** React presentation consumes a typed adapter implemented with the native WebMessage bridge. Browser tests use synthetic adapters; packaged production has no silent mock fallback. Functional state and rendering stay separate so polling cannot corrupt a user's pending input.

**Tech Stack:** React 19, TypeScript, Vite 7 targeting ES2018, system fonts, CSS, lightweight SVG, Vitest/Testing Library and Playwright; no chart/animation framework or remote assets.

**Spec:** [Dashboard specification](../specs/2026-10-14-phone-monitor-design.md#dashboard-specification), [PRD](../../PRD.md), [main plan](2026-10-14-phone-monitor.md).

## Global Constraints

- Bundled UI origin is `https://appassets.androidplatform.net`; exact origin/main-frame bridge enforcement; no remote assets or data HTML.
- Claude five-minute report staleness; Codex 120-second full-read staleness; laptop six-second link staleness; ESP nine-second link staleness.
- Laptop snapshot poll 2 seconds; ESP state poll 3 seconds; history refresh 30 seconds while open; no overlapping requests of the same operation.
- Light intents: explicit power values, brightness/speed 1–100, mode 0–8, timer 0–720 minutes; 150-ms coalescing; ≤4 dispatched writes/second; no automatic timer replay.
- Notification default deny; max 100 records, 30-minute TTL, no disk persistence; unavailable capture never disables other sources.
- Source timestamps use epoch milliseconds; quota reset fields use epoch seconds; display clock advances monotonically from laptop samples.
- No credentials in WebView, query strings, shell arguments, or logs; no sibling firmware edits/flashing.
- Primary landscape view fits 800×360 and remains operable at 740×320; touch targets at least 44 CSS pixels; normal text at least 14; primary values at least 32.
- Packaged JS/CSS ≤750 KiB uncompressed; APK ≤20 MiB excluding platform WebView; useful shell within three seconds.
- Distinguish software-verified from device-accepted; final project and PRD review uses `gpt-6-astra` at `high`.
- Other project-wide requirements in the main plan remain binding.

## Review Focus

1. Null/zero/expired/above-limit quotas and wrong wall clocks must render truthfully: W2 clock/render tests.
2. A stale poll or acknowledgement cannot cancel a new slider/power/timer intent: W2 intent-generation tests paired with A3 queue tests.
3. Failure of either link must not hide or disable the other data source: W1/W2 store tests.
4. Notification markup/links, disconnected expiration, and unsupported capture must remain plain/private/clear: W2 tests.
5. Small viewport, larger text, portrait, reduced motion, and continuously refreshing data must preserve operable controls/focus: W3 browser/device checks.

## Task 1: Dashboard shell and device adapter

**Agent:** Sol high; fresh Sol-high review. Apply frontend-design guidance when implementing, while preserving this PRD's direction and low-resource budget.

**Files:**
- Create: `dashboard/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `App.tsx`, `device.ts`, `store.ts`, `styles.css`.
- Create: `dashboard/src/mocks/device.ts` (development/test only), `dashboard/test/device.test.ts`, `store.test.ts`.
- Modify: root workspace scripts/lockfile.

**Interfaces:**
- Consumes: D1 shared schemas/types and exact app-operation table/AppStatus/SetupResult/EspSnapshot; A1 phoneMonitor.postMessage and .onmessage reply contract.
- Produces: createNativeAdapter(bridge,clock): DeviceAdapter; createMockAdapter(fixtures,clock): DeviceAdapter in dev/tests; DashboardStore.applyHub(link)/applyEsp(EspSnapshot)/applyAppStatus(AppStatus)/dispose(); reusable shell/status/settings slots. Request app.status once on startup/recreation, then every two seconds only while a native setup state is in_progress; a SetupResult acknowledgment alone does not mean paired/connected.
- `DeviceAdapter.request<T>(op,args?)` enforces typed operation/args, max pending count 16, ten-second timeout, response ID/version/schema validation, and disposal. Unknown/stale callbacks cannot resolve unrelated requests.

- [x] **Step 1: Add frontend toolchain and failing adapter/store tests.** Pin React 19/Vite 7 and compatible testing dependencies with exact saves/lockfile. Vite `base:'./'`, `build.target:'es2018'`; build to `dashboard/dist`. Test request ID matching, unsupported/no bridge, malformed reply, expired request, dispose cleanup, at most one poll of each source, visibility pause/resume, and independent source failures.

```ts
it("does not discard controller state when the laptop fails", () => {
  const store = new DashboardStore(fakeClock());
  store.applyEsp(readyEspLink());
  store.applyHub({state:"disconnected",ageMs:null,stale:true,data:null,errorCode:"USB_UNAVAILABLE"});
  expect(store.snapshot().esp.data?.temperatureC).toBe(29.8);
  expect(store.snapshot().hub.state).toBe("disconnected");
});
it("rejects pending requests on teardown", async () => {
  const adapter = createNativeAdapter(fakeBridge(), fakeClock());
  const pending = adapter.request("hub.snapshot");
  adapter.dispose();
  await expect(pending).rejects.toMatchObject({code:"SESSION_ENDED"});
});
```

- [x] **Step 2: Run targeted failures.** `npm run test --workspace @phone-monitor/dashboard -- device.test.ts store.test.ts`. Missing imports are expected until implementation; fake bridge emulates actual postMessage replies, not network calls.
- [x] **Step 3: Implement request transport and independent store.** Serialize v/id/op/args; validate before bridge calls; cleanup timers/listeners exactly once; bound pending work. Poll hub every two seconds and ESP every three only while visible; preserve cached data on failures; on resume issue fresh reads. Inject clock so age/countdown tests do not depend on wall-clock sleeps. Production build fails or shows setup guidance if native bridge is absent; it never treats a query parameter as permission to simulate live data.

```ts
bridge.postMessage(JSON.stringify({v:1,id,op,args:args ?? {}}));
// Each pending request owns its deadline and expected operation schema.
// A validated reply settles only the matching live request, then removes its timer.
```

- [x] **Step 4: Build the intentional visual shell.** Charcoal/cyan/amber palette, system numeric typography, three landscape columns, slim header, compact bottom notification strip, portrait stacking, and secondary sheets. Use compiled stylesheet classes/SVG presentation attributes rather than dynamically generated inline style tags that violate the packaged CSP. Provide useful absent-link/setup states without exposing technical implementation jargon in the main flow.
- [x] **Step 5: Verify adapter/lifecycle/layout scaffold.** Run frontend tests/typecheck/build. Load explicit development fixtures and confirm both independent disconnect states are understandable. Inspect bundle for CDN/dev-server URLs, account secrets, and accidental mock imports; verify dev mocks are tree-shaken from production. Record initial asset size.
- [x] **Step 6: Review and commit.** Sol reviews contract/state/CSP assumptions. Commit `feat: add lightweight dashboard shell and native adapter` after checks pass.

## Task 2: Usage, climate, light controls, and notifications

**Agent:** Sol high; fresh Sol-high review; escalate timing/intent boundary ambiguity to Astra high.

**Files:**
- Create: `dashboard/src/components/UsageCard.tsx`, `ClimateCard.tsx`, `LightCard.tsx`, `NotificationStrip.tsx`, `SettingsSheet.tsx`.
- Create: `dashboard/src/lib/time.ts`, `lightIntent.ts`; `dashboard/test/time.test.ts`, `lightIntent.test.ts`, `render.test.tsx`.
- Modify: `App.tsx`, `store.ts`, `styles.css`; update synthetic fixtures with loading/stale/error/over-limit cases.

**Interfaces:**
- Consumes: `UsageSource`, `EspState`, `EspHistory`, `LightPatch`, notification state, LinkSnapshot, A3 generation/confirmation semantics.
- Produces: estimateLaptopNow(sampleServerEpochMs,sampleAgeMs,receivedMonotonicMs,nowMonotonicMs):number; secondsUntilReset(resetEpochSec,laptopNowEpochMs):number|null; LightIntentController.change(patch)/release()/ack(CommandResult)/applySnapshot(EspSnapshot)/fail(generation,code)/dispose(); accessible components with desired vs confirmed state. Initialize generations from AppStatus.nextCommandGeneration on every new view before enabling writes; test that a retained old outcome cannot clear a new view's intent.
- One UI bridge write is in flight; at most four unsent units preserve ordered timer barriers. Adjacent ordinary patches merge latest touched values per field; never merge a timer into them. Native A3 owns reconciliation and wire-rate bounds. UI applies typed ordinary/timer outcomes from both command reply and esp.state; explicit retry creates a new generation and timers never retry automatically.

- [ ] **Step 1: Write failing product-state tests.** Unknown/zero/fractional/120% usage, dynamic Codex labels/durations, explicit capacity error, missing windows, expired retained Claude row with old reportedAtEpochMs, reset zero, report/source staleness. Repeated cached hub returns across 30-minute USB outage, notification expiry, no backward countdown, threshold crossing, renderer recreation with old native cache, absent sample, and phone clock skew. Lighting tests: cross-field merging while a request waits, timer/slider barriers in both orders, power-off cancels unsent timer, matching/mismatching post-dispatch reconciliation via esp.state, older poll cannot clear newer intent, no replay on loss/teardown, final release value, and queue-full without action loss. Also native setup >30 seconds, duplicate/cancel/expiry and status result rather than acknowledgment deciding success; sensor failure/history gaps; source independence/hostile markup/focus.

```ts
it("uses laptop time even if phone wall clock is wrong", () => {
  const now = estimateLaptopNow(1_000_000, 0, 500, 2_500);
  expect(secondsUntilReset(1_005, now)).toBe(3);
});
it("shows a due reset without pretending usage is zero", () => {
  render(<UsageCard source={usageWith({usedPercent:87,resetsAtEpochSec:1})} laptopNowEpochMs={2000} />);
  expect(screen.getByText(/87% used/)).toBeVisible();
  expect(screen.getByText(/reset due/i)).toBeVisible();
});
it("renders notification markup as plain text", () => {
  const {container} = render(<NotificationStrip items={[notificationWithBody('<img src=x onerror=alert(1)>')]} />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("<img");
});
```

- [ ] **Step 2: Run targeted failures.** `npm run test --workspace @phone-monitor/dashboard -- time.test.ts lightIntent.test.ts render.test.tsx`. Helpers are locally defined synthetic factories conforming to shared schemas.
- [ ] **Step 3: Implement quota/climate/notification cards with honest data.** Numeric used percentage remains unclamped; graphic fill clamps 0–100. Display actual duration/server label and source/row report age; retained expired Claude rows keep their old reportedAtEpochMs even if another row is newer. Empty/missing/auth/unsupported/capacity states have specific guidance. Anchor laptop time at cached serverNowEpochMs + ageMs; advance monotonically and recompute source stale thresholds/notification expiry. Repeated failed polls cannot reset this clock, including after renderer recreation. No sample means unknown countdown. At expiry retain usage and indicate awaiting update. Small SVG chart has null gaps/relative offsets, ≤120 points. Sensor failure is separate from connection. Notifications are escaped expiring text, no automatic links/actions/body diagnostics.

```ts
export function estimateLaptopNow(server:number, age:number, received:number, now:number) {
  return server + age + Math.max(0, now - received);
}
export function secondsUntilReset(reset:number|null, now:number) {
  return reset === null ? null : Math.max(0, Math.ceil((reset * 1000 - now) / 1000));
}
```

Use SVG attributes such as `fill`, `width`, and `d` for dynamic colour/progress/chart output, plus fixed CSS classes; avoid inline script/style dependencies and `dangerouslySetInnerHTML`.

- [ ] **Step 4: Implement bounded intent and full lighting controls.** Explicit power; presets/custom RGB hex, brightness, nine modes, speed, timer 0–720. Maintain desired/confirmed states. One bridge write in flight; up to four unsent units; adjacent ordinary units merge latest values per touched field without resending untouched fields. Timer-only units are ordered barriers, never merged/replayed. Power-off cancels unsent timers, and callbacks settle when superseded/cancelled. Release retains the final value. Native owns coalescing/rate/reconciliation; UI applies CommandResult outcomes from replies and EspSnapshot.commands. Ordinary mismatch/read failure remains unconfirmed; only an explicit retry creates a new generation. Settings use the exact D1 argument keys and immediate native setup acknowledgments; app.status completion decides success, not request timeout. Duplicate/cancel/expired flows are clear, no credentials exposed.

```ts
const modeLabels = ["Solid","Breathe","Rainbow","Jump","Strobe","Candle","Aurora","Party","Thermo"];
const explicitPowerPatch = {power: !desired.power};
// Current-generation acknowledgement updates confirmed state; older generations
// may update diagnostics but cannot clear or replace newer desired intent.
```

Polling may update observed confirmed state but never overwrite newer desired intent. Only native post-dispatch generation outcomes can clear the current pending/unconfirmed marker; old polls/outcomes cannot. A timer's uncertainty is separate from ordinary-state confirmation. Reconnect fetches state without replaying queued actions.

- [ ] **Step 5: Verify actual interaction behavior.** Tests assert one bridge write in flight and ≤4 ordered unsent units, correct cross-field merge, timer barriers/power-off cancellation, final value, old response ignored, native matching/mismatching reconciliation, explicit-only retry, and no queued action replay after teardown/loss. Run the 30-minute cached outage/source-age/notification-expiry/renderer-time tests and native setup acknowledgment/status cases. Test focus/drag stability, portrait, unknown Codex buckets/capacity error, sensor failure with working lights, and all error states. Run tests/typecheck/build and record size.
- [ ] **Step 6: Review and commit.** Sol checks PRD coverage, interaction state, and CSP/resource limits. Commit `feat: add usage climate lighting and notification panels` after fixes.

## Task 3: Packaging, accessibility, and integrated acceptance

**Agent:** Sol high for integration; Luna medium may handle a completely specified mechanical checksum/fixture edit as a separate reviewed narrow fix. Fresh Sol-high task review, followed by the whole-project **Astra-high** gate in the main plan.

**Files:**
- Create: `dashboard/e2e/dashboard.spec.ts`, Playwright config, `scripts/package.mjs`.
- Modify: `scripts/build.mjs`, doctor/connect setup, Android generated-asset build wiring, `docs/SETUP.md`, `TESTING.md`, `DEVICE_ACCEPTANCE.md`, root README/build scripts.
- Produce ignored artifacts: APK, desktop package, checksums, UI screenshots and raw measurements; save sanitized acceptance summaries/review evidence as documents.

**Interfaces:**
- Consumes: completed D3 runtime launcher/service, A3 companion, W2 built UI, all PRD acceptance rows.
- Produces: `npm run verify`, `npm run build`, `npm run package`, `npm run doctor`, `npm run connect -- --serial SERIAL`; reproducible APK with real assets, desktop bundle, checksums, setup/uninstall guide and dated acceptance report.
- Normal build fails if production frontend assets are missing or diagnostic/mock data would be packaged. Gradle copies assets from generated build directory; do not maintain a second manual UI copy.

- [ ] **Step 1: Write meaningful layout/offline-package/integration failures.** Playwright injects a fake native bridge into the test harness; production bundle has no mock adapter. Test 800×360 and 740×320 for primary clipping, 360×800 portrait, increased text, reduced motion, keyboard/focus, offline shell and independent link loss. Test package rejects absent/diagnostic assets and records reproducible manifest/checksums.

```ts
test("primary dashboard fits the small landscape viewport", async ({page}) => {
  await page.setViewportSize({width:740,height:320});
  await installSyntheticNativeBridge(page);
  await page.goto("/");
  await expect(page.getByRole("button",{name:/light power/i})).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
});
test("USB failure leaves room controls available", async ({page}) => {
  await installSyntheticNativeBridge(page,{hub:"disconnected",esp:"connected"});
  await page.goto("/");
  await expect(page.getByText(/laptop disconnected/i)).toBeVisible();
  await expect(page.getByRole("button",{name:/light power/i})).toBeEnabled();
});
```

Tests also inspect each primary control's bounding rectangle against viewport and tap-target dimensions; merely existing in the DOM is insufficient. Synthetic bridge is test-only `addInitScript` setup with shared fixtures.

- [ ] **Step 2: Run failing checks.** `npm run test:e2e --workspace @phone-monitor/dashboard` and packaging tests. Browsers run locally with no user-account sign-in or external notification capture. Review screenshots at both landscape widths rather than accepting only automated DOM assertions.
- [ ] **Step 3: Implement one-command verification/build/package orchestration.** Run protocol/desktop/dashboard tests and typecheck; build desktop/frontend; copy trusted frontend assets for Android; run Android unit/lint/APK checks with the user-owned JDK/SDK. Add checksum manifest and size checks. Install/run the APK on the selected authorized phone only during explicit device setup; do not automate user OS permission grants or silently replace unrelated apps.

```js
await run("npm", ["run","build","--workspace","@phone-monitor/dashboard"]);
await run(androidGradleWrapper, ["-p",androidRoot,":app:testDebugUnitTest",":app:lintDebug",":app:assembleDebug"]);
// Package only the built APK, compiled desktop code/dependencies, and public docs.
// SHA256SUMS covers the final artifacts; secret/private config paths are excluded.
```

`run` takes structured executable/argument arrays and propagates nonzero exit status; no unsafe shell interpolation. Package runtime dependencies with the desktop bundle or document exact clean-install lockfile command; omit the user's Node binary and account/config files.

- [ ] **Step 4: Execute the PRD acceptance matrix honestly.** Check existing provider quotas without manufacturing a prompt; inspect actual Redmi API/MIUI/WebView/viewport; pair hub; connect local-only AP; prove dual paths and independent disconnect; operate actual strip; confirm physical buttons/sensor state; synthetic allowlisted desktop notification; reinstall/uninstall temp-safe integrations; background/approval/renderer/process/ADB transitions. Physical confirmation of USB/Wi-Fi permissions remains with the user.

Record each A01–A17 row as pass/fail/unrun with date, command/observation, sanitized evidence path, and implication. For A17, an independent agent must use HANDOFF/STATUS/PROGRESS/AGENTS to locate the first incomplete task and evidence without chat, validate actual Git/files/report references, and detect disagreement rather than silently repeat completed work. If the phone is absent, software checks continue and device-dependent acceptance stays unrun. Never write “complete” based on APK build alone.

- [ ] **Step 5: Measure usability and endurance on the Redmi.** Shell ≤3 seconds; JS/CSS ≤750 KiB; APK ≤20 MiB; sixty-minute initial plus two-hour release foreground soak; app+renderer PSS target ≤180 MiB; stable child/socket/timer counts; no progressive memory growth/crash/missed updates. Use `adb -s SERIAL shell dumpsys meminfo com.phonemonitor` and renderer process measurements, recording samples rather than private logs. Pause for safe physical setup needs while independent work continues; do not claim unavailable measurements.
- [ ] **Step 6: Review, commit, and prepare the final gate.** Sol reviews integration/package/docs/evidence. Commit `feat: package and verify the phone monitoring dashboard`. Generate baseline-to-final whole-project review package with PRD/design/plans/check output/screenshots/device matrix; dispatch Astra high as specified in the main plan. Final review checks product fit and evidence, not only code syntax. One complete fix wave plus scoped re-review precedes delivery.

**Dashboard/product exit gate:** usable real packaged UI, all mandatory automated checks pass, no unresolved blocking review finding, artifacts/checksums/install/uninstall documentation ready, and actual device acceptance recorded before “fully finished” is claimed.
