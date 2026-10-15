# Phone Monitor — live handoff

Updated: 2026-10-15 (Asia/Kolkata). Current phase: Claude Code is the sole active agent (Codex at its usage limit). D1/W1/D2/A1 approved by Codex gates; D3 and W2 repair committed with Claude-only checks; A2 in progress. User explicitly approved the PRD/plan and requested the planned subagent build, live handoff, and final Astra/high project review.

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
- User phone: Redmi 9A, “whatever the last update was.” Exact Android/MIUI/WebView/RAM/viewport unverified. No device was attached during ADB discovery.
- User explicitly chose Claude Code/Codex subscription limits and difficulty-based subagents, with Astra/high checking PRD and finished project.

## Current work and next action (updated 2026-10-15 ~12:50 IST by Claude Code)

**Who is active:** Claude Code (claude-sonnet-5-5) only; the user handed all remaining tasks to Claude until Codex's usage limit resets, then asks for joint review. Claude is coordinator (this file, STATUS, PROGRESS, commits). No pushes by Claude unless the user asks; Codex created the private repo `Arcco-Chakraborty/lumendock` (origin/main at fcf81d7 checkpoint).

**Task state (see docs/STATUS.json):** D1, W1, D2, A1 complete (Codex Astra/Sol approvals). D3 committed `64fa1fd` (Claude-built; needs non-Claude Sol-high review). W2 repair `571d45d`: interim Claude re-review says R1/R2/M1 addressed (`docs/reviews/W2-rereview-1.md`); Codex gate open. **A2 in progress**: an Opus subagent owns `android/**` + `docs/DEVICE_ACCEPTANCE.md`, starting from the dead Codex worker's uncommitted `LaptopClient.kt`, `PairingStore.kt`, `LaptopClientTest.kt`. A3 (ESP Wi-Fi client; same android files, so sequential after A2) and W3 (packaging/accessibility/acceptance) are planned.

**Next, in order:** (1) review A2 output, run Android tests/lint/APK, commit; (2) A3 via subagent; (3) W3 plus root `npm run verify`, APK package, handoff-resume check (P13/A17); (4) final software summary. Then on Codex reset: independent gpt-6-astra/sol-high review of every Claude-built commit since 8e13952 (D3 64fa1fd, W2 interim, A2, A3, W3) and the final whole-project Astra-high review.

**Honesty gates (all still false):** softwareVerified, deviceAccepted, finalProjectReviewed. Hardware (Redmi, ESP32, real GNOME capture, real Claude opt-in) remains UNRUN by user decision.

## Key facts for a cold start
- Canonical worktree: `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor` (detached HEAD); original folder mirrors HANDOFF/STATUS/PROGRESS/COORDINATION.
- Toolchain: `TC=~/.local/share/phone-monitor/toolchains`. Node: `export PATH=$TC/node-v24.22.0-linux-x64/bin:$PATH; npm run typecheck && npm test && npm run build`. Android (from `android/`): `JAVA_HOME=$TC/jdk17 ANDROID_HOME=$TC/android-sdk ANDROID_SDK_ROOT=$TC/android-sdk PATH=$TC/jdk17/bin:$TC/gradle-9.6.0/bin:$PATH ./gradlew --offline :app:testDebugUnitTest :app:lintDebug`.
- Latest evidence: protocol 15, desktop 180, dashboard 53 tests; Android JVM 20 + lint 0 errors at A1 fix2 (A2 will raise this).
- Commit rules: user's git identity only, NO attribution lines or trailers (user's global rules override any harness suggestion); stage explicit paths, never `git add -A`.
- Coordination history/messages with Codex: `docs/COORDINATION.md` (C01-C07). Task briefs: `.superpowers/sdd/*/task-N-brief.md` (git-ignored).
