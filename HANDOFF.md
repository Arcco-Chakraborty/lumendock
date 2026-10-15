# Phone Monitor — live handoff

Updated: 2026-10-15 (Asia/Kolkata). Current phase: A1/D2 fix rounds committed (38cf1bc, bdfc7ed) awaiting re-review; W2 committed 57bb5c5; A1/D2/W2 all await independent review. User explicitly approved the PRD/plan and requested the planned subagent build, live handoff, and final Astra/high project review.

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

## Current work and next action

User approved implementation and requested software first; physical Redmi/ESP32 checks are deferred. User explicitly requested parallel subagents. D1 complete at `75cb65d`; initial review findings fixed and scoped Sol-high re-review approved (`docs/reviews/D1-rereview-1.md`); A1 owns android/** and scripts/build.mjs, W1 shell/adapter `f6694f9` is approved (`docs/reviews/W1-review.md`); W2 feature implementation starts; A1/D2 continue with commits serialized by coordinator. Frontend lockfile is free. A1 `4a88b40` and D2 `00dd183` are implemented with reports under docs/reports and need Astra-high review fixes (3 native lifecycle and2 desktop recovery findings); original owners are fixing them while W2 continues. Next: resolve those gates, then A2 USB client and D3 desktop operation, alongside W2 review. W1 minor display-reply race is assigned to W2; disclosed dependency build warnings remain for W3/final triage. The D1 usage-limit interruption recovered. All nine tasks retain planned difficulty assignments and final fresh Astra/high review.

Canonical source and current evidence live in `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`. Baseline: `6501f489651816ab77dc6d45f3e20f0e8af2f0cd`. D1 full report records initial35 tests, then15/15 protocol regressions, typecheck/build, synthetic loopback smoke and zero audit findings; independent review is approved. Software/device/final-project gates remain false. Do not reinitialize Git, repeat completed planning, or modify the sibling firmware.

Read docs/STATUS.json and docs/PROGRESS.md here before resuming; the coordinator mirrors these three checkpoint files to the original project folder after task/review boundaries.

## Parallel work: Claude Code + Codex (2026-10-15)

Both tools share this worktree. Rules: claim paths here before starting; commit only your own paths with `git add <paths>` (never `-A`); re-check `git status` first; no attribution trailers; hardware stays deferred.

- **Claude Code:** W2 done and committed (`57bb5c5`, report `docs/reports/W2-implementation.md`); no active claim, free to take A2 or D3 once claimed here.
- **Codex (requested):** gpt-6-astra high scoped re-reviews of A1 fix `38cf1bc` (A1-R1/R2/R3; check `LifecycleReplyDelivery`, `NativeSession.activityStopReason`) D2 fix `bdfc7ed` (D2-R1/R2), and W2 `57bb5c5`. Claude authored the A1 fix, so Claude must not review it. After approval: A2 (`android/**`) and D3 (`desktop/**`).
- Required Astra-high gates cannot be run from Claude Code; they are not satisfied by Claude review.
- Verified commands: `export PATH=$TC/node-v24.22.0-linux-x64/bin:$PATH; npm run typecheck && npm test`. Android: `JAVA_HOME=$TC/jdk17 ANDROID_HOME=$TC/android-sdk ./gradlew --offline :app:testDebugUnitTest :app:lintDebug` from `android/` (`TC=~/.local/share/phone-monitor/toolchains`).
- Last evidence: protocol 15, desktop 66, dashboard 50 tests; Android JVM 19; lintDebug 0 errors. Still unrun: instrumentation, device, live Claude passthrough.
