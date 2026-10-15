# D3 — Notification capture and desktop operation (aggregate)

Date: 2026-10-15. Built by Claude (claude-sonnet-5-5) and two Claude subagents (D3-A, D3-B), NOT the planned Sol model. **Independent non-Claude Sol-high review is still required**; detail reports: `D3-A.md`, `D3-B.md`.

## Delivered
- Notification capture (`desktop/src/collectors/notifications.ts`), allowlist helpers (`config.ts`), `notifications allow|remove|list` (`notifications-cli.ts`), live apply via `AllowlistSync` (`notification-sync.ts`) wired in `main.ts`; `HubStore.setNotificationAllowlist`.
- USB: `adb.ts`, `doctor.ts`, `service.ts`, `setup-cli.ts`; scripts `doctor/connect/install-hub/uninstall-hub.mjs`.
- Claude opt-in: `claude-cli.ts` + `scripts/claude-install.mjs`, `claude-uninstall.mjs`, delegating to the reviewed D2 installer with its attestation gates unchanged (`--dry-run`, `--settings`, `--previous-shell`, `--claude-version`, `--attest-shell`, `--attest-cancellation`).
- Root: `package.json` scripts (`install-hub`, `uninstall-hub`, `claude-install`, `claude-uninstall`), `scripts/workspace.mjs` dispatch. Docs: `docs/SETUP.md`, `docs/TESTING.md`.

## Evidence (Node 24.22.0 user-local, run by Claude 2026-10-15)
- `npm run typecheck` clean; `npm test`: protocol 15, desktop 180 (14 files), dashboard 53 (includes the W2 repair tests); `npm run build` passes.
- CLI test (8) found and fixed a real bug: relative `--settings` was resolved before the absolute-path check.
- Real-process smoke: `node scripts/workspace.mjs claude-install --dry-run --settings <nonexistent temp path>` printed the dry-run report and wrote nothing.
- `systemd-analyze verify` passed on a generated unit (D3-B). No real `systemctl`, no real busctl, no real notification captured, no real Claude settings modified, no phone.

## Not verified
- Real GNOME `busctl monitor` output and BecomeMonitor denial text (fixture is hand-written; coordinator was independently probing an isolated test bus).
- Physical USB reverse on the Redmi; unplug/replug; service at login; opt-in on a real Claude settings file; live Claude cancellation compatibility.
- A leftover `adb` server may be running on the laptop from the read-only `adb devices` check.
