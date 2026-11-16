# Phone hub offload implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking. Current user authorizes execution now; applicable AGENTS explicitly permits parallel disjoint ownership. No commits/pushes or broad approvals are implicit.

**Goal:** Move Calendar and local IoT work onto the Redmi and reduce optional resident laptop workloads, with USB-only phone internet support and testable software while hardware is absent.

**Architecture:** Keep full legacy behavior; explicit desktop offload profile skips phone-owned work. Add independent native phone Calendar/auth and local device-poll server; coordinator alone wires bridge/MainActivity/UI. Existing quota adapters remain until independently viable phone authentication exists.

**Tech Stack:** Existing Node24/TypeScript, Kotlin/JDK17/SDK36/minAPI29, Gson, pinned Google Play services authorization dependency; no server framework on Android.

**Spec:** `docs/superpowers/specs/2026-10-28-phone-hub-offload-design.md`.

## Global constraints

- Work in canonical detached e59d312 dirty worktree; baseline `.superpowers/offload-2026-10-28/baseline` preserves prior work. No resets, staging/commits, firmware edits/flashing, real providers/devices/OS grants/publication.
- User authorizes software execution2026-10-28 despite no phone. Required Astra-high design/plan pass before product edits, fresh independent reviewer per task; final Astra-high software review. Root owns all handoffs/shared files.
- Both quota displays remain; no credential export/inference/claimed savings; sibling firmware read-only. Desktop full is default; offload explicit. App network services foreground-only.
- Read-only three Calendar scopes, Android-owned consent, no WebView secrets; fixed Google HTTPS API. All existing labels/events/cursor/selection/failure contracts stay binding.
- Exact local bind and per-device credentials; no wildcard/fallback/general proxy. Old ESP client and hub pairing stay available.

## Review focus

1. Disconnect/account switch/Google-consent cancellation during API completion must not resurrect stale grants/events (H2/H4 tests).
2. More than50 rows and label metadata/one failing source must not silently alter all-events behavior (H2 parity fixtures).
3. Selected private interface disappearing or being ambiguous must stop local service, never bind another network (H3/H4 tests).
4. Device/command replay and lost timer acknowledgment must not repeat a timed side effect (H3 tests).
5. Offload must omit constructors/singletons/subprocess loops, not merely suppress output; shutdown/opt-in relay must not touch unowned processes or devices (H1 tests).

## H1 — Desktop runtime profiles, USB relay preparation and resource evidence

Owner fresh Sol-high; exclusive `desktop/**`, `scripts/usb-internet.mjs`, scoped desktop/offload docs/report. Root owns package.json and existing launchers. No native/dashboard/protocol edits.

Consumes current HubStore/collectors/HubOptions. Produces `RuntimeProfile` parser and dependency-injected runtime composition used by main; `--offload` accepted with optional explicit host feature opt-in, full default unchanged. Offload skips Calendar/host/vitals construction entirely, preserves quotas and selected notifications, permits explicit Deck actions and on-demand refresh without periodic host work. `/v1/action` tests must use mocks. Only owned instantiated helpers stop.

Produces optional tested relay planner/supervisor with injected process/ADB runners: argv-only installed Rust relay, selected-device mapping/START/STOP, public-IPv4 include routes excluding all private/loopback/link-local, no APK install commands, preserve unrelated mappings. Script defaults help/status/dry-run; live start explicit runtime request requires prepared client and VPN consent left to human. Sanitized opt-in own-process/tree resource sampler has no cmdline/env/path/serial output.

- [ ] Write failing constructor-spy profile tests (full compatibility; offload zero Calendar/host/vitals calls; no singleton creation during shutdown; quotas preserved).
- [ ] Write failing fake-runner relay tests (selected device only, invalid serial/port/binary, no install/run/autorun/global ADB kill, route exclusion, ownership cleanup/backoff).
- [ ] Implement runtime/profile integration and minimal own-process resource sampler; document actual CLI and tradeoffs. Do not silently disable quota or allowlist feeds to claim savings.
- [ ] Run focused RED/GREEN, desktop suite/typecheck/build with local Node24. Verify no real host action/provider/launcher executed. Record report `docs/reports/H1-offload-desktop.md` and changed-file list for review. No commit.

## H2 — Phone-native Google Calendar repository and authorization

Owner fresh Astra-high; exclusive new `android/.../PhoneCalendar*.kt`, `GoogleCalendar*.kt`, matching tests, plus gradle dependency pins only. No MainActivity/BridgeRouter/ProtocolValidator changes; coordinator integrates.

Produces `PhoneCalendarRepository(auth: PhoneCalendarAuth, transport: PhoneCalendarTransport, clock: HubClock=SystemHubClock)` implementing public `read(JsonObject): LinkSnapshot`, `sources(JsonObject): LinkSnapshot`, `select(JsonObject):JsonObject`, `resume()`, `pause()`, `close()`, `disconnect()`. Existing LinkSnapshot type/name may be reused from CalendarClient (or new JsonObject result if needed; agree root immediately). Repository auth/transport seams permit synthetic JVM tests; all data must pass existing CalendarValidator. Expose safe auth state and generation to root, never token in bridge.

Produces native Google authorization wrapper with explicit Activity connect/result callback methods, silent token acquisition only after prior user connection, scope-grant validation, cancel/disconnect generation and native-only token handle. Pin stable dependency from Google Maven and compile. Do not copy Desktop OAuth files or require embedded secrets.

- [ ] Write fail-first sources/selection/read tests using existing Calendar fixtures plus >50 events, all pages/labels/recurrence/timezone/all-day/declined/source-failure/capacity cases.
- [ ] Write auth-generation/cancellation/401/late completion tests; no event requests before Apply; no old account/cursor after reconnect/disconnect; repeated stale payload retains age; throttle honors retry and no retry storms.
- [ ] Implement fixed-origin bounded Google HTTP transport, normalization/repository/cache/selection, authorization wrapper; preserve spec bounds/semantics. CPU/network on bounded workers; no Activity/UI-thread I/O, raw logs or durable event/auth cache.
- [ ] Run targeted RED/GREEN JVM suites then native tests/lint/compilation. Report exact public interfaces/dependency/tool commands and honest Cloud/phone prerequisites in `docs/reports/H2-phone-calendar.md`. No commit.

## H3 — Native local IoT command hub

Owner fresh Astra-high; exclusive new `android/.../LocalHub*.kt`, matching tests, `docs/PHONE_HUB.md` and report. No existing native/shared/UI edits.

Produces `LocalHubController` with explicit configure(network lease), enroll/revoke/select device, start/stop/resume/pause/close, status and existing EspSnapshot/history/setLight-compatible methods, or clearly documented equivalent agreed with root before integration. Own typed request parser/auth/queue/server files; per-device bearer digests, bounded poll/report protocol, once-delivered command semantics. Platform supplies explicit confirmed interface/address lease; no listener creation without valid lease. New device secrets displayed only by native setup.

- [ ] Write fail-first auth/strict HTTP/method/header/body/connection-bound tests and own-device isolation/expired foreign ack tests. Socket tests use loopback only under explicit test-only lease seam; production never permits loopback.
- [ ] Write fail-first selected-interface loss/lease validation/pause/shutdown/queue expiration/coalescing/no-timer-replay tests.
- [ ] Implement bounded 4-client native server, per-device auth, queues/telemetry/snapshot, monotonic stale age, fixed errors; no arbitrary URL/network proxy/provider data. Exact binding fixed8787, private IPv4, confirmed selected interface only, revalidate lease. Implement source-independent preference/digest persistence seam; no token logs.
- [ ] Run focused RED/GREEN + relevant JVM suites; document native API exact types and v1 protocol/device firmware prerequisites. Report `docs/reports/H3-local-iot-hub.md`. No commit.

## H4 — Coordinator native/bridge/Settings integration

Owner coordinator; exclusive shared files `MainActivity.kt`, `BridgeRouter.kt`, `ProtocolValidator.kt`, `NativeSession/SessionLifecycle` only as necessary, native resources, protocol schemas/fixtures/tests and dashboard Settings/device/mock integration. No new worker files except reviewed integration fix request.

New fixed operations `app.phoneHubStatus` returning strict sanitized Calendar mode/auth + server status/bind/port/deviceCount/selection (no credentials), `app.configurePhoneHub` returns `{opened:boolean}`. MainActivity config dialog selects backend, connects/disconnects native Google UI, explicitly selects hotspot interface, enrolls/selects/revokes device and starts/stops server. Default modes unchanged. Route current calendar operations to selected native backend and ESP calls to selected hub device only when enabled. On mode/account switch invalidate existing UI data immediately; late replies cannot cross generation. Unknown optional ops on old APK gracefully unavailable.

- [ ] Add protocol/native/dashboard fail-first fixtures for operation validation/no secret fields, settings feature fallback, mode-change cached-data clearing, setup cancel/account switch generation and separate Google consent lifecycle.
- [ ] Implement native integration and compact Settings entry/status; preserve all existing layouts/Clock/assets/history. No automatic listener/startup/hotspot/permission/consent. Display foreground limitation and setup prerequisites precisely.
- [ ] Add root package script for explicit offload/USB tooling if needed; preserve user launchers and platform default behavior. Add docs/setup/acceptance matrix for new modes and resource comparison.
- [ ] Run protocol/dashboard tests/typecheck and focused Settings browser tests; native lint/build. Update HANDOFF/STATUS/PROGRESS after each task review.

## H5 — Independent review, build and checkpoint

- [ ] Fresh independent task reviewers compare snapshot-relative task diffs, specification and actual tests (not entire historical dirty diff); resolve findings with original owners and preserve failure evidence.
- [ ] Root complete workspace unit/typecheck, full production browser regression, native JVM/lint/production APK build with local toolchain; inspect bundle/signature as appropriate. Preserve previous installed release APK separately; create clearly named offload candidate artifact. No phone install attempt.
- [ ] Fresh Astra-high final software-scope review of full revision and reports. Keep whole-project device acceptance gate open; pending Google registration/consent, USB/VPN/hotspot routing, future ESP station firmware, actual resource comparison.
- [ ] Checkpoint exact tests/limitations/artifact hashes in mirrored handoff records. No completion claim beyond verified software; no branch/push/publication. Report concrete deliverables and remaining hardware inputs.
