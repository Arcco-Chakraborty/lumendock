# Desktop Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose normalized Claude Code/Codex subscription windows and selected Linux notifications through a paired, cached loopback API.

**Architecture:** Three mockable collectors feed one in-memory store. A foreground hub or optional user service serves authenticated snapshots and an explicit short-lived pairing flow. Native Android is the client; no browser scraping or model prompts occur.

**Tech Stack:** Node 24.22.0, TypeScript, npm workspaces, Fastify 5, runtime schema validation, Vitest; installed Claude/Codex/ADB/busctl tools accessed with controlled subprocesses.

**Spec:** [Desktop hub specification](../specs/2026-10-14-phone-monitor-design.md#desktop-hub-specification), [PRD](../../PRD.md), and [main plan](2026-10-14-phone-monitor.md).

## Global Constraints

- Hub binds only `127.0.0.1:8765`; paired bearer auth; no remote bind option; no credentials in WebView, query strings, shell arguments, or logs.
- Pairing: eight digits, 120-second expiry, five failed attempts, one-use; normal startup leaves it closed.
- Claude five-minute report staleness; Codex 120-second full-read staleness; laptop six-second link staleness; ESP nine-second link staleness.
- Notification default deny; max 100 records, 30-minute TTL, no disk persistence; unavailable capture never disables other sources.
- Source timestamps use epoch milliseconds; quota reset fields use epoch seconds; display clock advances monotonically from laptop samples.
- Files with secrets are private; configuration install/uninstall preserves unrelated edits; use only the user's existing Git identity and no attribution lines.
- No sibling firmware edits/flashing; no transcript/auth-file reads or provider login/logout; no model calls solely for monitoring/testing.
- Other project-wide requirements in the main plan remain binding.

## Review Focus

1. Missing/expired quota windows versus genuine zero, arbitrary server window durations, and percentages over 100: D1 schema/D2 normalization tests.
2. A timer rerun must not refresh Claude data; concurrent source sessions must not replay stale state: D2 signature tests.
3. Existing shell command semantics and edits made after installation must survive wrapper setup: D2 temp-directory round-trip tests.
4. D-Bus monitoring denial or unallowlisted messages must not expose contents or stop usage: D3 capability/filter tests.
5. Multiple/unauthorized USB devices, crashed children, oversized output, and token failures must recover within bounded work: D1/D2/D3 tests.

## Task 1: Shared contract and authenticated hub

**Agent:** Sol high; fresh Sol-high task review. This includes the initial Node/workspace bootstrap because the hub needs it.

**Files:**
- Create: root package.json, package-lock.json, .nvmrc, .gitignore, tsconfig.base.json. Preserve/update the existing AGENTS.md/HANDOFF/STATUS/PROGRESS records; never replace their user instructions or checkpoint history.
- Create: `packages/protocol/package.json`, `src/schema.ts`, `src/index.ts`, `test/schema.test.ts`, and four fixtures listed in the design.
- Create: `desktop/package.json`, `tsconfig.json`, `src/server.ts`, `src/store.ts`, `src/pairing.ts`, `src/config.ts`, `src/main.ts`.
- Test: `desktop/test/server.test.ts`, `desktop/test/pairing.test.ts`.

**Interfaces:**
- Consumes: authoritative design type definitions; injected wall/monotonic clock and temporary config directory.
- Produces: `HubSnapshotSchema`, `LightPatchSchema`, `EspSnapshotSchema`, `AppStatusSchema`, operation-specific `BridgeRequestSchema`/reply-data schemas, exported protocol types; `buildHub({store,pairing,tokenStore,clock}): FastifyInstance`; `HubStore.snapshot(nowMs): HubSnapshot`; `PairingSession.open(nowMs): string`, `.exchange(code,nowMs): {token:string}`, `.close():void`; private `TokenStore.read/write`. Freeze every app operation's exact args/reply table from the design, including SetupResult/SetupState and per-generation ordinary/timer outcomes; create `app-status.json` and `esp-link-ready.json` synthetic fixtures.
- Package names: `@phone-monitor/protocol`, `@phone-monitor/desktop`, later `@phone-monitor/dashboard`. Root scripts: `test`, `typecheck`, `build`, `verify`, `doctor`, `connect`, `package`; scripts may call Node orchestration rather than assume global shell tools.

- [ ] **Step 1: Bootstrap the testable workspace.** Provision user-owned Node 24.22.0 from the official distribution/version manager without changing system/default Node. Add exact dependency pins and lockfile using `--save-exact` for `fastify@5`, `zod@4`, `typescript@5`, `vitest@5.0.4`, `tsx@4`, `vite@7`, and compatible Node types. Define `test: "vitest run"`, `typecheck: "tsc --noEmit"`, and `build: "tsc"` in applicable packages. Initialize fixtures with synthetic values only.

```json
{"private":true,"workspaces":["packages/*","desktop","dashboard"],"engines":{"node":">=24 <25"}}
```

- [ ] **Step 2: Write meaningful failing boundary tests.** Test a paired snapshot, unknown quotas, percentages 0/17.25/120, 13-digit millisecond reset rejection, malformed/oversized input, wrong protocol, route Host/Origin/auth rejection, and staleness under an injected clock.

```ts
it("keeps absent usage distinct from zero", () => {
  const source = fixtureHub().usage.claude;
  source.windows[0].usedPercent = null;
  expect(HubSnapshotSchema.parse(fixtureWithClaude(source)).usage.claude.windows[0].usedPercent).toBeNull();
  source.windows[0].usedPercent = 0;
  expect(HubSnapshotSchema.parse(fixtureWithClaude(source)).usage.claude.windows[0].usedPercent).toBe(0);
});
it("rejects unpaired requests without echoing auth", async () => {
  const app = makeTestHub();
  const r = await app.inject({url:"/v1/snapshot",headers:{host:"127.0.0.1:8765",authorization:"Bearer secret-test-value"}});
  expect(r.statusCode).toBe(401);
  expect(r.body).not.toContain("secret-test-value");
});
```

Fixture helpers `fixtureHub`, `fixtureWithClaude`, and `makeTestHub` belong to these test files and construct protocol-valid synthetic data; they are not external dependencies.

- [ ] **Step 3: Run the specific failing tests.** `npm run test --workspace @phone-monitor/desktop -- server.test.ts pairing.test.ts` and the protocol schema tests. Expect missing implementation exports or wrong behavior; repair harness/dependency failures before interpreting them as product failures.
- [ ] **Step 4: Implement schemas, store, pairing, and strict routes.** Use injected clocks; finite numbers/nulls; identifier and byte budgets. Generate code/token cryptographically, keep pairing closed by default, count total failed attempts, perform exchange atomically, and preserve the old token until replacement succeeds. Persist mode-0600 token in a mode-0700 app directory. Route handlers never serialize secret-bearing config.

```ts
const cryptoCode = randomInt(0, 100_000_000).toString().padStart(8, "0");
const newToken = randomBytes(32).toString("hex");
// The pairing exchange owns persistence and invalidation atomically.
const requirePhone = (header: string | undefined) => tokenStore.matchesBearer(header);
```

Create `GET /healthz`, `GET /v1/snapshot`, and setup-only JSON `POST /v1/pair` exactly as the design specifies. Cap incoming JSON to 16 KiB; outgoing snapshot to 256 KiB; omit oldest notification records if necessary. No browser CORS or generic RPC. Bind in `main.ts`, not in tests.

- [ ] **Step 5: Verify pairing and failures with exact assertions.** One successful exchange; concurrent exchanges produce only one token; five wrong codes close pairing; 120,000-ms expiry rejects; startup without `--pair` rejects; token file permissions; wrong/absent token 401; invalid Host/Origin rejected; transient collector error preserves prior data. Schemas reject mixed timer/state patches, invalid generation, wrong brightness/screen-on args, malformed setup states, and >62 Codex windows with an explicit source-capacity result rather than truncation. Run package tests and typecheck; use a fixture-only smoke client without account access.
- [ ] **Step 6: Review and commit.** Report changed files, commands/results, and any concern. Fresh reviewer receives baseline-to-head diff and task brief. Commit plain message `feat: add paired desktop hub and shared protocol` only after review/covering checks pass.

## Task 2: Claude and Codex collectors

**Agent:** Sol high; fresh Astra-high review because settings/shell/provider authentication boundaries are involved.

**Files:**
- Create: `desktop/src/collectors/claude.ts`, `codex.ts`, `desktop/src/claude/wrapper.ts`, `install.ts`.
- Modify: `desktop/src/main.ts`, `store.ts`, `config.ts`, `desktop/package.json`.
- Test: `desktop/test/claude.test.ts`, `codex.test.ts`, `installer.test.ts`, synthetic statusline/JSONL fixtures under `desktop/test/fixtures/`.

**Interfaces:**
- Consumes: `UsageSource`, `UsageWindow`, `HubStore`, injected process runner/clock/private config directory from D1.
- Produces: `normalizeClaude(input,observation): UsageSource`; `normalizeCodex(result,observation): UsageSource` with every valid bucket's windows in one Codex source; `observeClaude(input,previous,nowMs): {public:UsageSource,local:ClaudeSignature}`; `CodexCollector.start()/stop()/retry()`; `installClaudeStatusLine({settingsPath,wrapperPath,configDir,nodePath,previousShell?})`, `uninstallClaudeStatusLine({settingsPath,configDir})`; typed source-state updates. ClaudeSignature stores separate API/window metadata and genuine-report ordinal; the original window reportedAtEpochMs survives expiry-only removal. An existing command requires a declared/verified absolute previousShell; unknown compatibility aborts installation without editing settings.
- Private Claude records carry the normalized public observation plus local signature metadata; the serializer strips local metadata. The wrapper is a standalone executable independent of whether the hub is running.

- [ ] **Step 1: Write failing normalization, lifecycle, and installer tests.** Cover missing versus zero, independently absent windows, fractional/over-limit usage, expiry-only removal of one/both windows without refreshing source/row age, initially absent windows, first-seen cached samples, genuine-response signature changes, timer-only duplicates, unchanged old session A after newer session B, restart/reload preserving observation time/ordinal, 32-session limit, legacy/multi-bucket Codex/dynamic durations, explicit >62-window overflow preserving last good state, update merging, auth-required, child crash/timeout, malformed/oversized JSONL, and settings ownership conflicts.

```ts
it("does not turn a timer rerun into a fresh Claude report", () => {
  const baseline = observeClaude(report({apiDurationMs:0,used:null}), null, 0);
  const first = observeClaude(report({apiDurationMs:100,used:42}), baseline, 1_000);
  const timer = observeClaude(report({apiDurationMs:100,used:42}), first, 400_000);
  expect(timer.public.observedAtEpochMs).toBe(1_000);
  expect(timer.public.stale).toBe(true);
});
it("uses the Codex server's window duration", () => {
  const result = codexFixture({bucket:"custom",durationMins:45,used:17.25});
  const source = normalizeCodex(result, {nowMs:1_000,lastSuccessMs:1_000});
  expect(source.windows[0]).toMatchObject({bucketId:"custom",windowDurationMins:45,usedPercent:17.25});
});
```

Helpers `observeClaude`, `report`, and `codexFixture` are implemented/tested in this task; observation signature contains only the locally necessary discriminator/API counters and quota fields. Do not forward their raw input.

- [ ] **Step 2: Run targeted failures.** `npm run test --workspace @phone-monitor/desktop -- claude.test.ts codex.test.ts installer.test.ts`. Ensure failures represent nonexistent/broken collectors rather than missing real account access; tests use fake children and temp settings only.
- [ ] **Step 3: Implement Claude observation and safe passthrough.** Buffer at most 256 KiB for monitoring while teeing the original stdin stream to the saved command unchanged; oversized monitoring input skips capture without truncating the user's status-line input. Execute the saved command as data using its intentional shell syntax, preserving cwd/env/stdout. Never concatenate quota JSON, filesystem paths, or command data into generated shell source. Store validated observations with atomic private writes; capture failures don't interrupt the previous display.

```ts
const previous = spawn(declaredPreviousShell, ["-c", savedCommand], {cwd: process.cwd(), env: process.env, detached:true, stdio:["pipe","inherit","inherit"]});
// Tee stdin bytes to previous.stdin; separately collect a bounded monitoring prefix.
// On overflow skip monitoring only, and still drain/forward all original bytes.
```

Implement advisory lock/atomic settings writes, private backups, idempotent wrapper ownership, no-original-command model label, project/managed override diagnostics, and uninstall compare-and-restore of only the owned statusLine field. Include absolute Node path and safely quoted exec in installed wrapper command. Require declared/verified shell for the prior command, never infer a login shell. Handle stdin backpressure/early EPIPE; preserve prior exit code/output. On SIGTERM/SIGINT stop capture, terminate only the tracked owned child group, allow 500 ms, escalate/reap, and propagate termination. Verify installed Claude normal cancellation semantics before enabling passthrough; do not claim SIGKILL handlers exist. Temp fixtures include spaces, single quotes, `$()`, backticks, and Unicode in paths/input; none may execute except the explicitly configured previous command.

Implement the design's expiry-aware observation classifier and shared locked genuine-report ordinal. Timer-only disappearance preserves expired rows and their reportedAtEpochMs; the selected public source is the greatest genuine ordinal, not the file touched most recently. Reload never assigns a new observation timestamp.

- [ ] **Step 4: Implement the read-only Codex child.** Pin compatible installed CLI metadata; initialize/initialized handshake; account/read then rateLimits/read; typed ID correlation, source normalization, partial-update merging, full-read reconciliation. One in-flight quota read, ten-second deadlines, connected/disconnected cadence, jitter injection, crash backoff, sanitized stderr, graceful stop. Do not read credential files, create turns, or invoke login/logout.

```ts
spawn(codexPath, ["app-server", "--listen", "stdio://"], {shell:false,stdio:["pipe","pipe","pipe"]});
const initialize = {id:1,method:"initialize",params:{clientInfo:{name:"phone_monitor",version:"0.1.0"}}};
const account = {id:2,method:"account/read",params:{refreshToken:false}};
const limits = {id:3,method:"account/rateLimits/read",params:{}};
```

Send `initialized` only after initialize response. Poll 60 seconds with ±10% jitter while authenticated phone requests are recent; 300 seconds otherwise. Unknown buckets remain visible; millisecond/second confusion and invalid percentages never overwrite valid state.

- [ ] **Step 5: Verify preservation and failure behavior.** Assert previous stdout/stdin bytes preserved even with collector failure/oversized input; early stdin close does not crash; nonzero exit is preserved; cancellation of a long-running child plus descendant leaves no owned process; repeated replacement invocations do not leak groups; declared shell mismatch/absence leaves configuration untouched. Unrelated edits survive uninstall; changed statusline yields ownership conflict; duplicate installer is a no-op. Run the expiry/multi-session/reload/capacity tests from Step 1. Fake JSON-RPC child asserts zero thread/turn methods and bounded outstanding requests. Run tests/typecheck/build; optional live read uses provider-managed auth only, without inference solely for testing.
- [ ] **Step 6: Review and commit.** Provide temp-file test evidence and explicit live collector limitations. Astra reviews the task's actual diff. Commit `feat: collect subscription limits without exposing provider credentials` after findings are addressed.

## Task 3: Notification capture and desktop operation

**Agent:** Sol high; fresh Sol-high task review. Escalate privilege/privacy ambiguity to Astra high.

**Files:**
- Create: `desktop/src/collectors/notifications.ts`, `desktop/src/adb.ts`, `scripts/doctor.mjs`, `connect.mjs`, `install-hub.mjs`, `uninstall-hub.mjs`.
- Modify: `desktop/src/main.ts`, `config.ts`, root scripts, `docs/SETUP.md`, `docs/TESTING.md`.
- Test: `desktop/test/notifications.test.ts`, `adb.test.ts`, extend `installer.test.ts`; synthetic typed busctl fixtures.

**Interfaces:**
- Consumes: shared notification/source schemas, private config, process runner and clock, D1 snapshot store/D2 collectors.
- Produces: `NotificationCollector.start(allowlist)/stop()` and capability state; `AdbConnection.ensureReverse(serial)/stop()`; `doctor` JSON/text status without shared phone serial/account details; selected-device CLI connection flow; reversible optional systemd user service.
- Allowlist starts empty; settings accept only bounded valid app labels. Service embeds absolute paths to the selected Node executable, compiled hub, and config directory.

- [ ] **Step 1: Write failing privacy, expiry, USB selection, and installer tests.** Empty allowlist produces no monitor child; denied BecomeMonitor yields unavailable while quotas work; nonallowlisted/hostile/oversized events never stored/logged; TTL expires after 1,800,000 ms; ring stays ≤100; duplicate event within two seconds suppressed. Fake ADB covers offline/unauthorized/wrong/multiple devices, unplug/replug, port conflict, and paths/serials treated as arguments.

```ts
it("never starts capture with an empty allowlist", async () => {
  const runner = fakeRunner();
  await new NotificationCollector({runner,store:fixtureStore(),clock:fakeClock()}).start([]);
  expect(runner.calls).toHaveLength(0);
});
it("expires notifications without requiring new traffic", () => {
  const store = storeWithNotification({receivedAtEpochMs:0,expiresAtEpochMs:1_800_000});
  expect(store.snapshot(1_800_001).notifications.items).toHaveLength(0);
});
```

- [ ] **Step 2: Run targeted failures.** `npm run test --workspace @phone-monitor/desktop -- notifications.test.ts adb.test.ts installer.test.ts`. Use fake process/clock and temp service files; no test requires monitoring the user's private real notifications.
- [ ] **Step 3: Implement typed capture with privacy filtering.** Generate match expressions only after app-label validation; invoke busctl as argument arrays, no shell. Establish fixture format using the installed CLI and a deliberate synthetic `notify-send` event during opt-in setup testing; retain only the synthetic fixture, never a raw real stream. Decode bounded JSON records and validate payload signature/Notify fields. Apply allowlist/truncation before retaining; escape/render body as plain text downstream. Capability failures are fixed error codes, not elevation requests.

```ts
const match = `type='method_call',interface='org.freedesktop.Notifications',member='Notify',arg0='${validatedAppLabel}'`;
spawn(busctlPath, ["--user","--json=short","--no-pager",`--match=${match}`,"monitor"], {shell:false});
```

Use one monitor per explicitly allowed label, cap allowlist to ten apps, reap on settings change/shutdown, and use bounded restart delay. Notification actions/server replacement semantics are intentionally excluded.

- [ ] **Step 4: Implement selected-device connection and setup commands.** `doctor` checks Node/JDK/SDK/ADB/provider versions and reports authorized physical USB devices. `connect --serial SERIAL` requires an explicitly selected authorized USB device, restores `adb -s SERIAL reverse tcp:8765 tcp:8765` after connection transitions, checks `reverse --list`, and never uses a wireless device silently. Port conflict reports an actionable error without killing processes. The optional user service is installed with private config and absolute Node path; uninstall removes only owned service/config integration and preserves user changes.

```ts
await runner.exec(adbPath,["-s",serial,"reverse","tcp:8765","tcp:8765"]);
await runner.exec(adbPath,["-s",serial,"reverse","--list"]);
```

Document native pairing code entry, “allow USB debugging” physical confirmation, ESP Wi-Fi setup, Claude wrapper opt-in, empty notification allowlist, service foreground mode, and precise uninstall. Notification app selection is a laptop CLI/config setup operation: provide `notifications allow APP_LABEL`, `notifications remove APP_LABEL`, and `notifications list`; validate labels, update only this app's private config atomically, and apply changes without restarting other collectors. The phone settings sheet explains that app selection is managed during laptop setup. No installation runs automatically at server startup.

- [ ] **Step 5: Verify runtime cleanup and operator flows.** Run all desktop tests/typecheck/build. Synthetic event appears within three seconds when authorized/allowed; denied bus capture is documented as unavailable. Verify no retained unallowlisted data, tokens in logs, leaked children/timers, or unrelated service/settings deletion. Check reverse restoration through fake runner plus authorized hardware when present; mark physical result unrun otherwise.
- [ ] **Step 6: Review and commit.** Report actual GNOME notification capability and physical ADB validation separately. Commit `feat: add selected notifications and USB desktop launcher` after fresh review.

**Desktop subproject exit gate:** fixture/API/security tests pass; supported collector paths verified; configuration round trips pass; all source errors remain independent; setup docs describe missing hardware/auth/capture states without claiming live acceptance.
