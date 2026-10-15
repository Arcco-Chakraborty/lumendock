# Phone Monitor — live handoff

Updated: 2026-10-15 (Asia/Kolkata). Current phase: all implementation tasks committed and software checks pass; waiting on independent Codex review and on hardware (Claude Code was the sole active agent while Codex was at its usage limit). User explicitly approved the PRD/plan and requested the planned subagent build, live handoff, and final Astra/high project review.

## Objective

Use a spare Redmi 9A as an attractive landscape desk dashboard. Receive Claude Code/Codex subscription percentages/reset times and selected Ubuntu/GNOME laptop notifications over USB. Keep phone Wi-Fi connected to the ESP32 AP for independent RGB control and DHT11 temperature/humidity. No controller firmware change, cloud hosting, or inference for monitoring.

## Read and resume

1. [Agent rules](AGENTS.md), [machine status](docs/STATUS.json), [progress ledger](docs/PROGRESS.md).
2. [PRD](docs/PRD.md) and [system design](docs/superpowers/specs/2026-10-14-phone-monitor-design.md).
3. [Main implementation plan](docs/superpowers/plans/2026-10-14-phone-monitor.md); then the assigned [desktop](docs/superpowers/plans/2026-10-14-desktop-hub.md), [Android](docs/superpowers/plans/2026-10-14-android-companion.md), or [dashboard](docs/superpowers/plans/2026-10-14-dashboard.md) task.
4. [Planning review](docs/reviews/2026-10-14-planning-review.md) and [resolution](docs/reviews/2026-10-14-planning-resolution.md). The scoped re-review marks R1–R5/C1–C2 addressed with no remaining blocking planning issue.

## Verified context

- Workspace: `/home/arcco-chakraborty/Projects/Phone_monitor`; Git initialized; reviewed baseline 6501f48. Canonical execution root is `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor` (managed detached-HEAD worktree). The original folder mirrors the checkpoint; implement only in the canonical root.
- Sibling controller: `/home/arcco-chakraborty/Projects/RGB_Controller`; ESP32 AP `Rgb_Controller` at `192.168.4.1`; GET state/set/history; no CORS; nine modes; DHT11; history up to 120 samples/30 seconds. Read-only for this product.
- Laptop: Ubuntu/GNOME; Claude 2.1.300 (D2 read-only recheck), Codex CLI 0.162.0-alpha.17.2, ADB 34.0.5. System defaults remain Node 20 and Java 8. User-local JDK 17.0.20.1, Android SDK platform/build tools 36, and Gradle 9.6.0 are installed under `/home/arcco-chakraborty/.local/share/phone-monitor/toolchains`; D1 provisions Node 24.22.0 there. Build agents must select these tools explicitly.
- User phone: Redmi 9A (M2006C3LI), Android 10 (API 29), MIUI V12.0.26.0.QCDINXM, WebView 151.0.7922.199. Attached via physical USB, ADB authorized, APK installed.
- User explicitly chose Claude Code/Codex subscription limits and difficulty-based subagents, with Astra/high checking PRD and finished project.

## Current work and next action

The review of all implementation code and the physical phone connection are COMPLETE.

**Done:**
- Verification suite passing: protocol 15, desktop 189, dashboard 112, Playwright e2e 24/24, Android JVM 116 + lintDebug 0 errors.
- Full code review across commits `8e13952..cb01e25` approved (Android routing/BSSID pinning, desktop hub reverse supervisor/strict routing, dashboard responsive design).
- APK installed to physical Redmi 9A.
- Reverse port forwarding `tcp:8765 -> tcp:8765` running and supervised.
- Hub pairing completed: bearer token stored in app private storage and laptop `~/.config/phone-monitor/phone-token` (0600).
- Controller Wi-Fi setup completed: phone connected to `Rgb_Controller` AP.
- Dual-link simultaneous connectivity confirmed on physical phone: both "Laptop connected" and "Controller connected" active.
- Device acceptance rows A2-D1, A3-D1, A3-D2 marked PASS in `docs/DEVICE_ACCEPTANCE.md`.

**Next action:**
1. Check that desktop quota displays (Codex / Claude) and Room/Light controls on the phone dashboard operate smoothly.
2. Record remaining device acceptance rows as desired (A2-D2..D6, A3-D7..D14, W3-D1..D6).
3. Optional: install the login service (`npm run install-hub`) if background persistence across laptop reboots is desired.

## Key facts for a cold start
- Canonical worktree: `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor` (detached HEAD); original folder mirrors HANDOFF/STATUS/PROGRESS/COORDINATION.
- Toolchain: `TC=~/.local/share/phone-monitor/toolchains`. Node: `export PATH=$TC/node-v24.22.0-linux-x64/bin:$PATH; npm run typecheck && npm test && npm run build`. Android (from `android/`): `JAVA_HOME=$TC/jdk17 ANDROID_HOME=$TC/android-sdk ANDROID_SDK_ROOT=$TC/android-sdk PATH=$TC/jdk17/bin:$TC/gradle-9.6.0/bin:$PATH ./gradlew --offline :app:testDebugUnitTest :app:lintDebug`.
- Latest evidence: protocol 15, desktop 188, dashboard 112 tests, e2e 24/24 (`npm run test:e2e`), Android JVM 116 + lint 0 errors, `npm run package` checksums OK.
- Commit rules: user's git identity only, NO attribution lines or trailers (user's global rules override any harness suggestion); stage explicit paths, never `git add -A`.
- Coordination history/messages with Codex: `docs/COORDINATION.md` (C01-C07). Task briefs: `.superpowers/sdd/*/task-N-brief.md` (git-ignored).
