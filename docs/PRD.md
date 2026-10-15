# Phone Monitor — Product Requirements

Date: 2026-10-14 (Asia/Kolkata). Approved product baseline, with the user-requested revision below dated 2026-10-15. Requirements describe intended behavior; verification is recorded separately in STATUS and DEVICE_ACCEPTANCE.

## Current revision

The user has installed and used the app, and requested a complete phone dashboard redesign plus repair of missing Claude usage and selected notifications. [REDESIGN.md](REDESIGN.md) defines this revision. It replaces the original visual layout and startup orientation below: use a flat, restrained instrument display with a prominent local clock/date, room readings and usage, selected alerts, and compact lighting that expands on demand. Both portrait and landscape must work through normal sensor rotation. Hide Android system bars with transient gesture access and preserve setup dialogs, keyboard and cutout safety. The user rejected generic futuristic styling, deep blue gradients, fashionable tech fonts and em-dash copy.

Only Claude, Codex and WhatsApp notifications are selected. Where a provider does not emit a desktop event, this revision may use an opt-in provider attention hook with fixed generic text. Preserve existing hooks and status-line behavior; never forward prompt/transcript input or broadly allow terminal/browser notifications. Exact desktop/PWA identifiers are privacy filters, not authenticated identities. The original exclusions and architecture continue to apply except for these explicitly requested changes.

Original planning-time environment facts below are historical. Consult STATUS for the canonical execution root, current evidence and pending device checks.

## Intent and verified context

Turn the user's spare Redmi 9A into a dedicated, attractive desk dashboard. The phone receives Claude Code/Codex subscription limits and selected laptop notifications through a USB cable, while using its Wi-Fi connection to control the existing ESP32 RGB strip and display room temperature/humidity.

The laptop keeps its normal internet connection. The phone does not need internet access while operating. The display and ESP32 controls continue working if the laptop connection drops; laptop cards remain usable if the ESP32 drops.

Verified on the laptop: Ubuntu/GNOME; Claude Code 2.1.299; Codex CLI 0.162.0-alpha.17.2; ADB 34.0.5; Node 20.20.2; Java 8 runtime. No phone was connected when `adb devices -l` was checked. The Android installation contains platform-tools only: a JDK, Gradle wrapper, command-line SDK, platform, and build tools still need provisioning. `Phone_monitor` started empty and is not yet a Git repository.

Verified in `../RGB_Controller`: ESP32 AP `Rgb_Controller`, HTTP address `192.168.4.1`, DHT11 sensor, and existing state/control/history endpoints. Firmware exposes no CORS headers. Its history contains up to 120 paired samples at a 30-second interval. No firmware changes are required by the proposed native HTTP approach.

The user confirmed the phone is a Redmi 9A and the requested usage is Claude Code/Codex **subscription limits**. Exact Android/MIUI/WebView versions, installed RAM variant, and phone readiness remain hardware discovery inputs; do not assume a particular final regional update.

## Scope and success criteria

### First usable release

| ID | Requirement | Observable success |
|---|---|---|
| P01 | Package a fully local dashboard inside an Android app | Dashboard shell opens with USB unplugged and the ESP32 AP offline |
| P02 | Use USB for laptop communication and Wi-Fi for ESP32 | Both links succeed simultaneously on the Redmi; laptop stays on normal internet |
| P03 | Show Claude subscription windows | Available five-hour/weekly percentages, resets, source age, and explicit unknown/stale states |
| P04 | Show Codex subscription windows | Render every returned bucket/window within the documented capacity, using actual durations; excess capacity is explicit and never silently truncated |
| P05 | Show room climate | Temperature in °C, humidity in %, sensor health, and a small recent-history view |
| P06 | Control lights | Power, RGB colour, brightness, all nine existing modes, speed, and sleep timer |
| P07 | Show selected laptop notifications | Future allowlisted desktop events appear; an empty allowlist starts no capture |
| P08 | Recover independently | USB loss never disables room controls; ESP loss never blanks usage/notifications |
| P09 | Respect the existing desktop configuration | Claude status-line output is preserved; install/uninstall preserves unrelated edits |
| P10 | Be safe to keep on a desk | Foreground-only screen-on option, brightness control, restrained rendering, no required root |
| P11 | Be installable and maintainable | APK, local launcher, opt-in user service, uninstall instructions, and reproducible build commands |
| P12 | Be independently reviewed | Astra at high reviews the PRD/plan before execution and the complete project at release |
| P13 | Maintain a live cross-agent handoff | Another AI can resume from HANDOFF/STATUS/PROGRESS/AGENTS without this chat; checkpoints update after each task/review/decision/yield |

### Excluded from the first release

ChatGPT website quotas, API billing estimates, inference calls, account login automation, notifications from the user's primary phone, notification actions/replies, cloud hosting, remote internet access, general shell execution from the phone, firmware flashing, a new ESP32 network topology, notification history from before the collector starts, OS-wide kiosk enforcement, automatic Android boot launch, and a native Android background service.

ESP32 favourites can be displayed as six local dashboard presets initially. Writing the controller's persistent favourite slots and app-specific agent hooks are follow-up features, not dependencies of P06/P07.

## Dashboard and interaction requirements

Support normal sensor rotation with deliberate landscape and portrait layouts. Setup and Android dialogs must remain usable in either orientation. Primary layout must fit an 800 × 360 CSS-pixel viewport, with an additional check at 740 × 320 for system-bar differences. The actual Redmi viewport is recorded during installation.

Visual direction: dark charcoal background, clear numeric typography, restrained cyan for climate/connectivity, warm amber for usage, and the selected light colour as the RGB accent. Use system fonts, bundled icons, subtle borders, and short state transitions. Do not ship CDN dependencies, video backgrounds, continuous animation, large chart libraries, or heavy blur.

The landscape screen has a slim header with clock and independent laptop/controller status; two usage cards; a climate card with large temperature/humidity values; a lighting card; and a compact notification strip. Secondary light controls, longer usage bucket lists, settings, and notification detail use an on-demand sheet rather than shrinking primary text.

Usage cards display **used** percentage with an unambiguous label, actual window length, reset countdown, and last-report age. Additional Codex buckets remain reachable without truncating their identity. Unknown is represented by a clear message, never `0%`. Above-limit percentages remain visible numerically; visual fill clamps to its track. Countdown reaching zero shows “Reset due; waiting for update.”

Light controls show confirmed state and a separate pending/unconfirmed marker. A power button sends an explicit `0` or `1`, never a retryable toggle. Colour changes use six presets or a compact custom RGB/hex editor. Brightness range is 1–100; mode range is 0–8; speed range is 1–100; timer range is 0–720 minutes. Sensorless operation still allows normal lighting modes; Thermo can be selected with a clear missing-sensor indicator.

Touch targets are at least 44 CSS pixels where interactive controls are shown. Normal text is at least 14 CSS pixels; primary numbers are at least 32 CSS pixels. Connection state is conveyed with text and an icon as well as colour. Honour reduced-motion settings. Updating data must not move focus, reset a slider drag, or reopen a dismissed sheet.

Notifications appear as plain text with source, title, age, and optional truncated body. They do not open links, execute actions, dismiss desktop notifications, or expose raw payloads. Local dismissal only hides the card on the dashboard.

## Data, freshness, and failure behavior

| Source | Collection/update policy | Stale threshold and failure behavior |
|---|---|---|
| Claude | Whitelisted quota fields from status-line events; response signature distinguishes timer reruns | Five minutes without a new report; retain values and show report age; missing windows are unknown |
| Codex | Startup read, notifications, full read every 60 seconds with ±10% jitter while the phone is active; every 300 seconds otherwise | 120 seconds without a successful full read; auth-required is explicit; keep last usable values |
| Laptop → phone | Cached snapshot every 2 seconds while visible | Six seconds without a successful response; show disconnected and retain data with age |
| ESP state | Every 3 seconds while visible; one outstanding read | Nine seconds without successful response; stale readings remain labelled |
| ESP sensor | Trust firmware `ok` separately from HTTP reachability | `ok=false` immediately marks sensor unavailable even if controller responds |
| ESP history | Load when chart opens, refresh every 30 seconds while open | Null samples become gaps; no invented historical timestamps |
| Notifications | Future-only allowlisted events, at most 100, TTL 30 minutes | Expire even while the phone is disconnected; no disk persistence |

Native laptop requests have a two-second connection timeout and a three-second read timeout. Native ESP requests have a 1.5-second connection timeout and a two-second read timeout. Failed link recovery uses 1/2/4/8/15-second delays, capped at 15 seconds, with no overlapping requests. Codex JSON-RPC uses ten-second deadlines and a separate child-restart backoff capped at 60 seconds.

Slider writes coalesce over 150 milliseconds, serialize on the ESP transport, and send a final value on release. Dispatched writes are bounded to four per second; unsent ordinary patches merge the latest value of each touched field. Timers are separate once-only ordered operations, never mixed with ordinary fields or replayed after uncertainty/reconnection. Power-off cancels unsent timer operations. Native code owns post-timeout reconciliation: a read begun after dispatch may confirm a matching ordinary patch; a mismatch remains unconfirmed until an explicit user retry creates a new generation. A timer without its command response stays uncertain; a remaining duration alone cannot prove the requested timer ran.

Display countdowns using the laptop's sampled time advanced by a monotonic clock, not the phone wall clock. For cached hub payloads, native ageMs belongs to that exact payload and is added to its sampled server time at JS receipt; returning cached data again cannot restart the clock. Source staleness and notification expiry advance during disconnection. Source timestamps are epoch milliseconds, except quota reset timestamps, which are explicitly epoch seconds. A network success does not prove an upstream quota was recently recomputed. Claude expiry-only field removal retains the old usage/reset and report age; an unchanged older session cannot replace a newer genuine report.

## Privacy and security requirements

The laptop hub binds only to `127.0.0.1:8765`. Phone access requires a per-device bearer token. Pairing is explicitly enabled from the laptop, uses an eight-digit code valid for 120 seconds, permits five total failed attempts, is one-use, and closes after success/expiry/exhaustion. Normal server startup does not leave pairing open.

Tokens and ESP Wi-Fi credentials stay in Android native private storage with backup disabled. They are never returned to the WebView, placed in query strings, exported in screenshots of diagnostics, passed in shell arguments, or logged. Laptop token/config files use mode 0600 in a mode-0700 application directory. Provider credentials stay with provider tools; the hub never parses Codex auth storage or sends it to the phone.

The WebView loads only bundled assets at `https://appassets.androidplatform.net/assets/index.html`. Its typed message bridge checks exact source origin and main frame. Block external navigation/subresources, frames, popups, file/content access, mixed-content loading, and arbitrary-URL or shell operations. Feature-check the installed WebView; unsupported bridge capability yields a native update/setup message rather than silently relaxing access.

Only native transports may use cleartext HTTP, restricted to `127.0.0.1` and `192.168.4.1`, with redirects disabled. ESP traffic never receives a laptop authorization header. Wi-Fi requests bind individual ESP connections to their `Network`; never bind the whole process to Wi-Fi.

Default notification allowlist is empty. Filtering happens before storage/forwarding/logging. App labels are privacy filters, not authenticated identities. Keep no email/Slack account connector, conversation transcript, prompt, file path, account email, session ID, OAuth token, or notification body in diagnostics. Provider errors become fixed safe error codes.

Configuration changes are opt-in installer operations, with exact backups and idempotent uninstall. A previous Claude command's execution shell must be explicitly declared/verified; unknown shell compatibility leaves the original field untouched. Wrapper cancellation forwards normal termination to its owned child group, handles early pipe close/backpressure, and preserves prior output/exit status. No Git/GitHub attribution lines or alternate author identities are permitted. Commits use only the user's existing Git configuration.

## Compatibility and deployment

Product baseline: Redmi 9A on Android API 29 or later; current stable WebView with `WEB_MESSAGE_LISTENER`; Linux Ubuntu/GNOME laptop. Xiaomi documents the device's original Android 10/MIUI 12 release, not the user's final installed build. Discover actual versions before live validation.

Build baseline: Node 24 LTS (24.22.0 verified as current LTS during planning), TypeScript, React 19, Vite 7, Fastify 5, npm workspaces; Kotlin Android app using JDK 17, AGP 9.4.0, Gradle 9.6.0, Android compile/target SDK 36, min SDK 29, and AndroidX WebKit 1.17.1. Resolve compatible stable patch releases with exact pins and lockfiles during bootstrap; do not use floating or prerelease dependencies. Confirm AGP built-in Kotlin compatibility and Android manifest changes before freezing the build.

All project tooling is installed into user-owned locations or the project; do not replace system Java or the default Node selection. The runtime service uses the chosen Node binary by absolute path so systemd does not depend on an interactive shell/nvm setup.

Distribution is a sideloadable personal debug APK and local Linux package/launcher. USB debugging requires the user's physical confirmation on the phone. Use a selected device serial for every ADB operation; do not choose arbitrarily among multiple phones. Automatic launch after login is an optional user-level systemd service installed only during setup.

Wi-Fi connection uses a native visible setup flow: Android's app-specific request for the configured AP, with OS permission/approval handling, plus manual Wi-Fi settings fallback. No-internet access points are valid. Exact MIUI approval/retention behavior is part of hardware testing.

## Acceptance and release criteria

There are two explicit completion levels: **software verified** (builds and simulator/automated checks pass) and **device accepted** (real Redmi/ESP32 checks pass). Do not call the project fully finished until device acceptance and final Astra review are recorded. Lack of attached hardware does not prevent mock-based implementation, but prevents claiming physical validation.

| Test ID | Procedure and pass condition | Evidence required |
|---|---|---|
| A01 | Install/open APK with both links absent; shell renders with useful setup states | APK build result and device screenshot |
| A02 | Phone simultaneously reaches hub over USB and ESP over Wi-Fi; laptop retains internet | Device model/API/WebView, two successful requests, laptop connectivity observation |
| A03 | Compare displayed quotas to provider status/usage view, including all available windows | Time-stamped sanitized comparison; no inference call solely to obtain data |
| A04 | Unknown, zero, fractional, above-limit, expired, and stale quotas render correctly | Fixture-based test results |
| A05 | Unplug/replug USB; room controls continue; laptop cards recover within 20 seconds after ADB is authorized | Recorded manual result |
| A06 | Power-cycle ESP/disable Wi-Fi; laptop cards continue; controller recovers after AP/request is restored | Recorded manual result |
| A07 | Verify power/colour/brightness/all modes/speed/timer against actual strip; timeout never replays a timer | Hardware checklist and command-queue tests |
| A08 | Simulate sensor `ok=false`, malformed payload, null history values, and controller restart | Parser/UI tests plus observed sensor state if safely available |
| A09 | Existing Claude status-line output survives install/uninstall; unrelated settings edits survive | Temp-file installer tests; live opt-in setup observation |
| A10 | Empty/denied notification capture is explicit; allowlisted synthetic event arrives within three seconds | Collector tests and synthetic desktop event observation |
| A11 | Unauthorized endpoints and non-app bridge messages fail; markup renders as text; logs/exports contain no secrets | Security-focused tests and inspection |
| A12 | App background/return, system approval, renderer crash, process kill, device restart, and USB authorization states recover without repeated prompts | Redmi checklist |
| A13 | At 800×360 and 740×320, no primary-control clipping; portrait and increased font size stay operable | Automated browser checks and screenshots |
| A14 | Packaged JS/CSS ≤750 KiB uncompressed; APK ≤20 MiB excluding platform WebView; useful shell within three seconds | Build measurements; device startup measurement |
| A15 | Sixty-minute foreground soak, plus two-hour release soak: no crash or monotonic resource growth; app+renderer PSS target ≤180 MiB | `dumpsys meminfo`, transport/resource counts, device observation |
| A16 | Astra-high reviews the complete tree against PRD and evidence; blocking findings are resolved and rechecked | Written final review and fix evidence |
| A17 | A fresh agent reads the handoff, identifies the actual first incomplete task, verifies referenced reports/artifacts/gates, and resumes without redoing completed work | Handoff/status/ledger consistency check and independent review; no secrets or false completion flags |

Performance numbers are release targets to measure on the actual phone, not statements of current results. If the PSS target is exceeded, profile and simplify; any exception needs an explicit documented user-visible tradeoff.

## Agent execution and review policy

The controller owns product decisions, shared contracts, task ordering, integration, evidence, and the progress ledger. Use isolated, self-contained subagent prompts with explicit model and reasoning effort. Read-only investigations can run in parallel; implementers run sequentially to avoid shared-tree conflicts. Each meaningful implementation unit gets a fresh task reviewer.

Maintain root HANDOFF.md/AGENTS.md and docs/STATUS.json/PROGRESS.md as live project records after each task, review/fix outcome, material decision/prerequisite change, and before yielding to another agent. The coordinator is their single writer; workers report evidence through scoped reports. Handoff names the current phase, approval/completion gates, actual execution root/branch/baseline, completed/active tasks, open findings, artifacts/check evidence, and exact next action. Other AI tools must be able to resume without chat history or this host's skill library. Keep secrets and raw private captures out, and never infer approval or passing hardware checks from a status flag alone.

| Work | Default agent model/effort | Reason |
|---|---|---|
| Complete-code mechanical edits, fixtures, release metadata | `gpt-6-luna`, medium | Clear inputs and a narrow change surface |
| Desktop adapters, pairing, UI components, installers | `gpt-6.1-sol`, high | Multiple files and failure handling need judgment |
| Android network/lifecycle/bridge integration | `gpt-6-astra`, high | Routing and platform state need architecture-level reasoning |
| Normal task review | `gpt-6.1-sol`, high | Independent spec/quality check against a scoped diff |
| Subtle Android/security task review | `gpt-6-astra`, high | Cross-boundary failure and trust analysis |
| PRD/plan final pass and finished-project final pass | **`gpt-6-astra`, high** | Explicit user requirement; review product coherence and complete evidence |

Use Luna only when the task really is mechanical; an integration task does not become easy because it has few lines. On repeated unresolved implementation findings, escalate capability and provide the exact prior findings. Reviewers must distinguish proven software behavior from pending hardware checks.

## Assumptions and sources

Defaults open to correction at plan review: landscape-first layout, Celsius, dark theme, laptop-only notification sources, no cloud hosting, no controller firmware changes, and one selected spare phone.

Notification app choices are deliberately deferred to runtime settings with an empty default. The exact Android version and Wi-Fi credentials are discovered/entered during setup. These do not require guessing or introducing account connector access.

Primary references checked during planning:

- [Claude Code status-line data](https://code.claude.com/docs/en/statusline)
- [Codex app-server account/rate-limit interface](https://learn.chatgpt.com/docs/app-server)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Android ADB reverse access](https://developer.android.com/develop/ui/views/layout/webapps/access-local-server)
- [Packaged WebView content](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
- [Android per-network connections](https://developer.android.com/reference/android/net/Network)
- [Wi-Fi network request API](https://developer.android.com/develop/connectivity/wifi/wifi-bootstrap)
- [Native bridge risks](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges)
- [Desktop notification protocol](https://specifications.freedesktop.org/notification/latest/protocol.html)
- [D-Bus monitoring](https://dbus.freedesktop.org/doc/dbus-specification.html)
- [Redmi 9A original software FAQ](https://www.mi.com/global/support/faq/details/KA-07667/)
- [Node release support](https://nodejs.org/en/about/previous-releases)
- [AGP build compatibility](https://developer.android.com/build/releases/agp-9-4-0-release-notes)
- [AndroidX WebKit releases](https://developer.android.com/jetpack/androidx/releases/webkit)
