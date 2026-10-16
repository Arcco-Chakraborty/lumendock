# LumenDock live handoff

Current revision, 2026-10-16 (Claude Code, Opus 5.5, sole coordinator at the user's instruction): **v1.2.0 released and installed on the phone (Claude usage without an open CLI). Earlier: v1.0.0, v1.1.0 (Laptop vitals screen).** Claude usage polling is turned ON on the user's laptop (`npm run claude-usage -- status`). Repo made public (MIT) at the user's request; GitHub release v1.0.0 carries the signed APK, desktop tarball, manifest and SHA256SUMS.

## State
- App renamed LumenDock (user-visible strings; package id `com.phonemonitor` and `~/.config/phone-monitor` kept for compatibility; generated systemd unit text intentionally unchanged because uninstall compares it byte-for-byte).
- Features in 1.0.0: see CHANGELOG.md (Monitor, Deck with now playing + system keys, lamp signals, overlay control bar, near-black/cyan design).
- Release signing: keystore + properties OUTSIDE the repo at `~/.local/share/phone-monitor/signing/` (0700/0600). `node scripts/build.mjs --release` signs and verifies. Certificate SHA-256 `595f8aa4be43bad2cbe532ac06a9e811d0b1f8eb81f4d8d68b76a11c67f63933`. Losing the keystore means no in-place updates.
- Verified 2026-10-16 (1.2.0): typecheck clean; protocol 19, desktop 239, dashboard 127, Playwright 54, Android 118 + lint; package OK. Details in docs/TESTING.md.
- History privacy scan before going public: no tokens/keys/passwords/serial/attribution trailers; only file checksums matched 64-hex; home paths shortened to `~` in current docs.
- Phone: debug build replaced by the signed release (requires re-pair + lamp Wi-Fi reconnect by the user).

## Claude usage (1.2.0, done)
User chose "both, polling opt-in" (2026-10-16): (A) status-line readings stay valid until their reset time instead of going Stale after 5 min; elapsed windows show as reset, not the old %. (B) opt-in `claude-usage on|off|status` (config.json key `claudeUsagePolling`): hub reads only `claudeAiOauth.accessToken`/`expiresAt` from Claude Code's `.credentials.json` at runtime, GETs `https://api.anthropic.com/api/oauth/usage` (beta header `oauth-2025-04-20`) every 3 min while the phone is active, never refreshes/stores/logs the token; expired token -> falls back to the status line. Agents still never read that file. New source enum `claude_usage_api` (protocol + Android validator). Files: packages/protocol/src/schema.ts, desktop/src/collectors/claude-usage.ts (new), collectors/index.ts, store.ts, config.ts, main.ts, dashboard UsageCard.tsx, ProtocolValidator.kt. Live-verified: endpoint replied with `five_hour`/`seven_day` {utilization, resets_at ISO}; phone showed it. Window labels renamed Session/Week. AGENTS.md + PRD carry the user-approved exception.

## Next / open
- Formal device-acceptance rows remain UNRUN (informal observations recorded in docs/DEVICE_ACCEPTANCE.md).
- Lamp pulse appearance on the real strip not yet observed.
- Claude polling: expired-token fallback not yet observed on real hardware (unit-tested).
- AGENTS.md asks for an independent Astra-high final review; not available to Claude.

## How to resume
Canonical root: ~/.codex/worktrees/phone-monitor-build/Phone_monitor (detached HEAD; push with `git push origin HEAD:main`). Toolchain: Node 24.22.0, JDK 17, SDK 36 under ~/.local/share/phone-monitor/toolchains. Rebuild protocol dist before running the hub after schema changes. Run the background service with ./phone-monitor.sh start|stop|status|logs. User Git identity only; no attribution.
