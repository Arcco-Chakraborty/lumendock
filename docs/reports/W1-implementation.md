# W1 — Dashboard shell and device adapter

Date: 2026-10-15. Status: implementation ready for independent Sol-high review; uncommitted pending coordinator serialization. Execution root: `~/.codex/worktrees/phone-monitor-build/Phone_monitor`, managed detached HEAD. Shared baseline advanced to `26c4e541f52050b64216b6c23c524b8c5e26b3a9` during parallel work; W1 changed only `dashboard/**`, root `package-lock.json`, and this scoped report. Root `package.json` needed no edit because existing scripts aggregate workspaces. No staging, commits, branch changes, firmware changes, captures, permission grants, publishing, or account access.

## Delivered scope

- Exact React/React DOM 19.2.4, Vite 7.3.7, Vitest 5.0.4, TypeScript inherited from root. Exact React type pins and updated root lockfile. Dependency installation used the user-local Node 24.22.0 explicitly; npm audit reported zero vulnerabilities. Initial npm workspace discovery emitted a transient workspace warning while the newly created workspace was being registered; install completed and subsequent workspace commands resolve normally.
- Typed `DeviceAdapter` infers reply and required arguments from the shared operation contract. It validates requests before native dispatch and validates version, ID, success/error envelope, and operation-specific reply data. A maximum of sixteen pending requests, ten-second deadlines, unique view-scoped IDs, bounded reply parsing, sanitized errors, and idempotent teardown prevent late/unknown callbacks from affecting other work. Listener restoration and timer cleanup are owned by the adapter.
- `DashboardStore` keeps laptop and ESP links separately, retains cached readings on failures, anchors sampled laptop epoch to native cached-payload age, and advances using an injected monotonic clock. It never invents laptop time. Derived source staleness and notification expiry continue during laptop outages. Stable snapshots update once per displayed second, avoiding an external-store render loop.
- Polls laptop every two seconds and ESP every three while visible, with one outstanding request per source. Hidden views stop polling/ticks; resume issues fresh source reads. Startup requests `app.status` once. Status polling continues every two seconds only while a native setup is in progress. Setup acknowledgments do not change pairing/connectivity; they request typed status, including a guarded follow-up when an older status read was already outstanding.
- Charcoal/cyan/amber system-font shell: slim independent connection header, three landscape columns, usage placeholders, climate, read-only lighting state, compact notification summary, responsive portrait stacking, and accessible modal settings/detail slots. Native setup actions and screen-on setting are scaffolded. Missing native bridge and unsupported WebView have explicit guidance. Settings has an accessible dialog name and restores focus to its opener. All current primary buttons have 44 CSS-pixel minimum touch dimensions.
- Explicit development fixtures (`?demo=connected`, `?demo=usb-offline`, `?demo=esp-offline`) load only in Vite development. Every fixture screen visibly says “Synthetic demo.” Production never interprets query parameters as permission to simulate data. Mock transport uses native-shaped serialized messages and shared schemas, with scheduled work cleaned up on disposal.
- Production uses relative asset URLs, ES2018 target, local SVG favicon, compiled CSS and SVG presentation attributes. Packaged CSP remains restrictive. Only Vite's development server removes the CSP meta tag to support Vite's development CSS/HMR; production build retains it unchanged.

W1 is the shell/adapter/lifecycle scaffold. W2 still owns complete quota window/bucket rendering and per-window report freshness/countdowns, climate history, intent-driven writable lighting controls, full notification display/dismissal, and remaining display settings. W3 owns durable browser integration/packaging tests and acceptance. This report does not claim those features complete.

## Files

- `dashboard/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `public/favicon.svg`
- `dashboard/src/device.ts`, `store.ts`, `main.tsx`, `App.tsx`, `styles.css`, `mocks/device.ts`
- `dashboard/test/device.test.ts`, `store.test.ts`, `shell.test.tsx`, `mock.test.ts`, `helpers.ts`, `type-contract.ts`
- `dashboard/evidence/w1-800-esp-offline.png`, `w1-740-usb-offline.png`, `w1-360-connected.png`, `w1-production-no-bridge.png`
- Root `package-lock.json`; generated `dashboard/dist` and dependency folders are ignored build outputs.

The design token plan followed the approved brief: background `#111719`, surface `#1a2326`, rule `#344247`, secondary text `#a3b3b8`, room cyan `#79d5dc`, usage amber `#edbd72`. System typography uses tabular numeric figures. Left-aligned usage occupies the first column, room the second, and lighting the third; portrait stacks room/lighting below the two usage cards. Visual emphasis is on room readings rather than ornamental animation, remote assets, gradients, blur, or heavy chart libraries.

## Interfaces and rulings

- Consumes `@phone-monitor/protocol`: `BridgeRequestSchema`, `BridgeReplySchemaFor`, operation/reply types, source/link/AppStatus/EspSnapshot contracts, and limits. Vite aliases the shared source so standalone dashboard builds do not require a prebuilt protocol distribution.
- Native interface: `window.phoneMonitor.postMessage(serializedRequest)`; `window.phoneMonitor.onmessage({data: serializedReply})`. No direct fetch, network proxy, credentials, or pairing code in WebView.
- Public exports: `createNativeAdapter(bridge, clock?)`, `DeviceAdapter`, `NativeBridge`, `DeviceError`, `Clock`, `systemClock`; `DashboardStore(clock?)` with `start`, `setVisible`, `subscribe`, `snapshot`, `estimatedLaptopNow`, `applyHub`, `applyEsp`, `applyAppStatus`, `setup`, `dispose`; development-only `createMockAdapter(fixtures, clock?)`; `App` with usage/climate/lighting/notification/settings React slots.
- The brief's illustrative `SESSION_CLOSED` conflicted with shared `SESSION_ENDED`. Raised to coordinator; coordinator ruled shared `SESSION_ENDED` authoritative and amended brief/plan. No alias introduced.
- D1 review changed pending-limit errors to `QUEUE_FULL` and normalized state hex to uppercase. W1 consumes the corrected contract; fixture states remain uppercase. User-entered patches are validated by shared patch schema.
- Generic request type parameter represents the operation, with its return inferred from the map. It does not let a caller falsely assert an arbitrary reply type. Compile-only tests reject unknown operations, missing required args, wrong operation args, and excess keys.

## Test-first and verification evidence

All npm commands below used `PATH=~/.local/share/phone-monitor/toolchains/node-v24.22.0-linux-x64/bin:$PATH`; no system/default tool change.

1. RED: direct user-local Node invocation of `node_modules/vitest/vitest.mjs run --root dashboard device.test.ts store.test.ts` failed with two missing implementation imports, as the brief explicitly expected before implementation.
2. GREEN: adapter/store implementation passed 14 tests.
3. RED/GREEN: stable-snapshot regression failed when elapsed milliseconds produced a new render snapshot within the same displayed second; caching by displayed second fixed it.
4. RED/GREEN: setup acknowledgment racing an older status request failed with only one status request instead of two; queued status refresh fixed it.
5. RED/GREEN: provider/notification outage-age test failed because source stale flags stayed false; derived monotonic-age projection fixed it.
6. RED/GREEN: shell test initially failed with missing `App` import; implementation passed. Unsupported-WebView guidance regression later failed because no guidance rendered, then passed after adding it.
7. `npm run test --workspace @phone-monitor/dashboard`: PASS, four files / twenty tests. Includes transport ID matching, missing/unsupported bridge, malformed version/data, request validation, deadline/late callback isolation, sixteen-request capacity, teardown cleanup, native errors/send failure, independent cached sources, epoch aging, visibility/poll pacing, setup acknowledgment/race, fixture disposal, shell slots and unsupported guidance.
8. `npm test`: PASS, fifteen protocol + twenty-two desktop + twenty dashboard tests (57 total), no test failures. No model/account/notification capture occurred.
9. `npm run typecheck`: PASS for protocol, desktop, dashboard; includes adapter compile-only misuse checks.
10. `npm run build --workspace @phone-monitor/dashboard`: PASS; relative production assets and ES2018 compilation. Two warnings originate in upstream Zod comments containing misplaced `@__PURE__` annotations; Rollup removes those comments. No build error or CSP workaround in production.
11. `git diff --check -- dashboard package-lock.json`: PASS. Scoped source self-review completed; independent review remains required.

Initial typecheck caught overly broad empty-object inference in operation argument types. The empty-operation union now distinguishes no-arg operations from the three required-argument operations; runtime strict schemas remain the final input gate.

## Browser/asset evidence

Used local Playwright with synthetic development fixtures and a local static server for production. Browser screenshots are copied into the execution-root evidence folder. Tool screenshot output roots required temporary captures under the original project's `.playwright-mcp`; no product source was implemented there.

- Development 800×360 / ESP offline: document 800×360, laptop connected/controller disconnected; retained room readings and last-state label remain understandable.
- Development 740×320 / USB offline: document 740×320, laptop disconnected/controller connected; room/climate remain visible.
- Development 360×800 portrait: document width 360, content height 815; vertical scrolling remains usable, no horizontal overflow.
- Current primary settings button 44×44 and notification details button approximately 75×44 in all three layouts.
- A narrow-screen CSS rule initially hid the synthetic-demo label; corrected to keep it visible. Formatting the CSP meta tag initially defeated a single-line development removal regex and blocked Vite's injected styles; corrected to accept whitespace/newlines. Repeated checks above passed after both fixes. Production CSP remained intact throughout.
- Static production `?demo=connected`, no native bridge: honest setup guidance and unknown values; no simulated readings. Settings opens, Pair laptop is disabled, closing restores focus to Open settings. Document fits 740×320. Zero inline styles/style tags. Restrictive CSP remains present. Initial static-server console's sole error was an absent favicon; local bundled SVG favicon added. Final production smoke has zero console errors/warnings, favicon HTTP 200, an accessible dialog named Settings, and no synthetic marker or inline style nodes.
- Production asset scan finds no `synthetic-main`, `Synthetic demo`, `Synthetic title`, `createMockAdapter`, `mocks/device`, `@vite/client`, localhost/loopback address, CDN host, or unpkg marker. Fixture dynamic imports are eliminated; production emits one JS and one CSS asset, plus HTML/favicon. React's diagnostic documentation URLs are library strings, not fetched dependencies. No account data was accessed, so no account secrets could enter assets.
- Final build: `index-B_nfkxsk.js` 307,988 bytes + `index-t9MyER1W.css` 5,554 bytes = **313,542 bytes (306.2 KiB)** uncompressed JS+CSS, below 750 KiB. HTML is approximately 0.74 kB; favicon is a local SVG.

## Unrun / acceptance limits

Software scaffold checks are verified; device acceptance is unrun. No Redmi or ESP32 was accessed. Native appassets origin/main-frame enforcement and actual WebMessage delivery await A1 integration; physical simultaneous USB/Wi-Fi routing, dialogs/MIUI/WebView compatibility, sensor/strip behavior, actual startup time, memory/PSS, endurance, APK size, and final device matrix remain unrun. Laptop/ESP browser fixtures cannot prove them. W1 independent Sol-high review and final project Astra-high review are pending coordinator gates.

Next: coordinator dispatches fresh W1 review, checkpoints HANDOFF/STATUS/PROGRESS, serializes W1 commit after findings are resolved, then hands the stable adapter/store/shell to W2. No commit has been made by this worker.

## Serialized implementation checkpoint

Coordinator authorized the scoped checkpoint after readiness, based on `26c4e541f52050b64216b6c23c524b8c5e26b3a9`. Committed only dashboard source/tests/evidence and root lockfile as `f6694f985b03bfba55a305a9989e471f50ed855c` — `feat: add lightweight dashboard shell and native adapter`. Ignored dist/node_modules excluded; other workers' Android/desktop/scripts files remained unstaged. No source change or new full test run after the verified readiness snapshot. Fresh independent W1 review follows this commit.
