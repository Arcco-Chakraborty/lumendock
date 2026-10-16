# LumenDock live handoff

Current revision, 2026-10-16 (Claude Code, Opus 5.5, sole coordinator at the user's instruction): **v1.0.0 released.** Repo made public (MIT) at the user's request; GitHub release v1.0.0 carries the signed APK, desktop tarball, manifest and SHA256SUMS.

## State
- App renamed LumenDock (user-visible strings; package id `com.phonemonitor` and `~/.config/phone-monitor` kept for compatibility; generated systemd unit text intentionally unchanged because uninstall compares it byte-for-byte).
- Features in 1.0.0: see CHANGELOG.md (Monitor, Deck with now playing + system keys, lamp signals, overlay control bar, near-black/cyan design).
- Release signing: keystore + properties OUTSIDE the repo at `~/.local/share/phone-monitor/signing/` (0700/0600). `node scripts/build.mjs --release` signs and verifies. Certificate SHA-256 `595f8aa4be43bad2cbe532ac06a9e811d0b1f8eb81f4d8d68b76a11c67f63933`. Losing the keystore means no in-place updates.
- Verified 2026-10-16: typecheck clean; protocol 16, desktop 224 (server route now uses a mocked executeAction), dashboard 126, Playwright 50, Android 115 + lint debug/release; package OK. Details in docs/TESTING.md.
- History privacy scan before going public: no tokens/keys/passwords/serial/attribution trailers; only file checksums matched 64-hex; home paths shortened to `~` in current docs.
- Phone: debug build replaced by the signed release (requires re-pair + lamp Wi-Fi reconnect by the user).

## Next / open
- Formal device-acceptance rows remain UNRUN (informal observations recorded in docs/DEVICE_ACCEPTANCE.md).
- Lamp pulse appearance on the real strip not yet observed.
- AGENTS.md asks for an independent Astra-high final review; not available to Claude.

## How to resume
Canonical root: ~/.codex/worktrees/phone-monitor-build/Phone_monitor (detached HEAD; push with `git push origin HEAD:main`). Toolchain: Node 24.22.0, JDK 17, SDK 36 under ~/.local/share/phone-monitor/toolchains. Rebuild protocol dist before running the hub after schema changes. Run the background service with ./phone-monitor.sh start|stop|status|logs. User Git identity only; no attribution.
