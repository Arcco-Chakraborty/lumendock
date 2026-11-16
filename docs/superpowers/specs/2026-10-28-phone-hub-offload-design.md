# Phone-owned services and laptop offload

Date: 2026-10-28 (Asia/Kolkata). User authorizes building software now without an attached phone. Architecture/goal agreed in chat on 2026-10-26: minimize laptop CPU, memory and resident helpers; laptop supplies internet only to the Redmi through USB; phone runs online services and a local hotspot command hub. This document makes implementation choices explicit; device acceptance and real savings remain unverified.

## Baseline and authority

Canonical worktree `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`, detached `e59d312`; preserve all prior dirty Calendar/Clock/launcher work. Baseline source/hash snapshot `.superpowers/offload-2026-10-28/baseline`. Existing Clock stays installed and unchanged on hardware during development. User's 2026-10-28 instruction authorizes software implementation of the agreed architecture; do not interrupt it for another general permission request. Required independent Astra-high design/plan review still precedes product edits.

This revision supersedes earlier desktop-only Calendar ownership and fixed ESP AP topology as *optional new modes*, keeping legacy behavior available. It does not authorize changes/flashing in sibling RGB_Controller, laptop hotspots, provider credential export, unattended Google login, OS permission grants, public hosting, startup registration or publication. Existing security and data fidelity requirements continue. Foreground-only app lifecycle remains; no always-on/background-service claim.

## Ownership and performance

Phone: bundled dashboard, timers, Calendar authorization/read-only API sync, normalization/paging/labels/selection and cache; local command queue and device telemetry. Laptop: USB/ADB, optional existing Rust reverse-tether relay, laptop-only actions/notifications/quotas. Authenticated quota adapters remain until a separate verified phone-compatible method exists; no false direct-phone claim, API-key billing substitute or inference for monitoring.

Add explicit `full` (existing default) and `offload` laptop runtime profiles. Offload never constructs laptop Calendar, host polling/vitals or platform host helpers. Preserve both quota feeds and selected notification delivery by default; feature opt-outs are explicit. Deck actions that need desktop access remain explicit and may refresh host state only on demand; no background host loop. Profile tests must prove absent construction, not just slowed intervals. A sanitized own-process profiler enables matching full/offload CPU/memory observations; no savings percentage is asserted from mocks. No real collectors are started during development checks.

## USB internet

Use a separately installed/pinned Rust gnirehtet relay, opt-in via dedicated CLI. Do not vendor/download/install its APK automatically, call `run`/`start`/`autorun`, accept VPN consent or alter laptop networking. Prepare explicit selected-device ADB argv for localabstract mapping and app START/STOP only; preserve the existing hub reverse mapping. Relay binds loopback, distinct from hub8765. Exclude loopback and RFC1918/link-local destinations from the VPN's included IPv4 routes so native IoT traffic can use the local hotspot on API29; hardware validation is mandatory. No default route/firewall changes. Bounded lifetime/backoff, ownership-specific cleanup, no raw child output/private serial in reports. Missing binary/client/phone/consent is actionable setup, never auto-install.

## Native Calendar

Keep existing `CalendarClient` desktop path intact. Add a `PhoneCalendarRepository` with `read(args)`, `sources(args)`, `select(args)`, `resume()`, `pause()`, `close()` returning the exact existing Calendar bridge LinkSnapshots/reply shapes. An activity-owned router chooses `desktop` or `phone`; default desktop for compatibility, explicit native mode switch cancels old backend and invalidates UI state by a new source generation.

Phone authorization uses Google Identity Services AuthorizationClient with an Android OAuth registration for com.phonemonitor and installed signing SHA-1, scoped only to calendar.events.readonly, calendar.calendarlist.readonly and calendar.calendars.readonly. A native explicit Connect action opens Google consent; tokens remain native/in-memory and never enter the bridge, files, diagnostics or the local server. Play services obtains renewed access by authorize() after prior consent. No desktop client secret/refresh token is copied. Validate all granted scopes; missing/rejected grant produces fixed local auth/setup state. Account reconnect/disconnect cancels old requests and clears sources, selection, cursors and events before replacement; generation guards reject late results. No background or OS auto-consent.

Direct HTTPS only to fixed Google Calendar v3 API endpoints, redirects disabled, no arbitrary URL input, bounded bytes2MiB/upstream, timeouts/cancellation, sanitized errors and retry backoff/Retry-After. Preserve every existing calendar requirement: all source/event pages, hidden sources/invitations, recurrence expansion, self-declined list entries, all-day exclusive ends and IANA zones, calendar/label identity, colors/reminder metadata, no synthetic categories. Label read incompatibility stays explicit and uses the same honest fallback as desktop. Source IDs/events are opaque hashes. Sources cap100, range1–31days, response50rows/128KiB, complete collection cap5000events and20MiB; capacity never silently truncates. Sort globally and compute nextEvent across the whole range, independent of pages. Initial/reconnect enumerates sources but performs no event reads until the human applies inclusion. Partial failures retain truthful per-source states and last complete data. Selection/cursors are generation/revision-bound; cache and age use monotonic receipt baselines, no background polling. Active event refresh120s, metadata900s; stale age advances offline. Use synthetic parity fixtures in JVM tests.

## Local IoT hub

A separate foreground-owned native service object, initially disabled; no TCP listener until explicitly enabled through native setup. User starts phone hotspot/local-only network manually; the app lists eligible local interface/address pairs and requires explicit native selection/confirmation of the hotspot interface. Validate interface/address is still present/up/non-loopback/non-point-to-point, RFC1918 IPv4 only, exact selected bind; no wildcard/default/first-private fallback. Recheck lease before start and per request, stop listener on invalid lease; actual hotspot identity and VPN coexistence require Redmi acceptance. Port8787. No exposure on BITS Wi-Fi, no IP forwarding/NAT, no internet for clients required. Preserve legacy WifiSession/EspClient path while the server is off.

Native enrollment creates independent random per-device bearer credentials; store only a digest in app-private storage with backup disabled, display provisioned bearer only in native one-time UI. Never reuse laptop/Google tokens or expose credentials to WebView/status. Each credential addresses one device; bounded max8 configured devices, only selected light controls the existing dashboard. Provisioning is explicit, no unauthenticated enrollment endpoint. No Calendar/laptop/provider data, arbitrary HTTP proxy, shell, URLs or remote laptop actions in server routes.

Fixed POST device poll/report protocol carries v1, acknowledged command identity and normalized optional telemetry, and returns at most one queued typed light command with id/generation/expiry. Define exact JSON in docs/PHONE_HUB.md. Header8KiB/body16KiB, 4 bounded clients, socket read2s, connection close, strict methods/paths/keys/types, no CORS/query tokens/redirects/raw logs. Independent device credentials and queues; constant-time digest comparison. Commands expire30s; ordinary state may coalesce while unsent, no blind timer replay after delivery/uncertainty. Acknowledgment must match device/id/generation; stale/foreign acknowledgments fail. Pause closes sockets, cancels unsent work and leaves delivered uncertain; no resends on resume. Selected device telemetry flows into existing EspSnapshot/history contracts with explicit stale/unknown data. The current ESP firmware is AP-only and does not yet speak this protocol: its migration is a separate future approved firmware task.

## Product setup and lifecycle

Add optional fixed bridge operations `app.phoneHubStatus` (sanitized mode/auth/server/device status only) and `app.configurePhoneHub` (open native dialog, returns opened boolean). Existing operations retain shapes. Native controls select Calendar backend, connect/disconnect Google, select/bind hotspot interface, enroll/select/revoke device, start/stop IoT listener. Dashboard Settings adds a compact Phone hub entry/status; no provider secrets/implementation internals in the web UI. Unknown operation on old APK hides optional controls without breaking other setup. No visual redesign of Monitor/Clock/Agenda.

On actual app background, calendar I/O and server stop; external Google consent has a separate owned setup generation so Activity stop does not accidentally accept late cancelled grants. Resume does not reopen listener automatically until current network lease revalidated; no new consent prompt without explicit user action. App restart retains only non-secret preferences/device digests/selection as applicable, not event bodies/access tokens. No Android boot launch, screen-off/background guarantee or OS grants.

## Acceptance

Software: meaningful fail-first tests; native normalization/auth-generation/cancellation/strict server/auth/queue/lease tests; desktop profile process-construction/relay fake-runner tests; bridge fixture parity; dashboard Settings behavior/old-native fallback; workspace typecheck/unit suites; browser regression; Android lint/APK build; fresh independent task reviews and Astra-high final software-scope review. Preserve old evidence and installed APK artifact separately. No desktop action/real-provider side effects in tests.

Device pending: selected Redmi USB internet + hub loopback + hotspot/local sockets together, Google consent/refresh via USB, independent disconnections, command/telemetry flow with migrated firmware, MIUI foreground lifecycle, full/offload same-condition CPU/RSS/PSS comparison. Fully finished/device accepted remains false until real matrix passes.

## Primary sources consulted

- https://developer.android.com/identity/authorization
- https://developers.google.com/identity/protocols/oauth2/native-app
- https://developer.android.com/develop/connectivity/wifi/localonlyhotspot
- https://github.com/Genymobile/gnirehtet (Rust relay/source; APK installation by upstream start/run must be avoided)
- https://learn.chatgpt.com/docs/app-server (quota integration; no Android runtime claim)
