# R-BACKEND implementation report — READY

Date: 2026-10-15. Canonical execution root `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`; baseline `87bd88d`. Exclusive backend changes under `desktop/**`.

## Changes

1. **Read-only Claude Capture Readiness**:
   - Implemented `inspectClaudeCapture()` in `desktop/src/claude/install.ts` to detect whether the product-owned status-line wrapper is installed, loadable, and consistent with the active Claude settings file without executing external commands or reading authentication data.
   - Connected readiness checks to `HubCollectors` in `desktop/src/collectors/index.ts` to map uninstalled/unowned states to `unsupported / SOURCE_UNAVAILABLE` (surfacing "Setup needed" guidance in the UI) and installed-but-quiet state to `awaiting_data` (waiting for next user session), while preserving prior valid observations during outages.

2. **Selected Notification Sources & Installed PWA Discovery**:
   - Implemented `desktop/src/notification-sources.ts` to support exact user-requested sources only: `Claude`, `Claude Code`, `Codex`, `codex`, `WhatsApp`, `WhatsApp Web`.
   - Added secure detection for installed WhatsApp Chrome PWA desktop entries (verifying `--app-id` matching `crx_${id}` and checking `desktop-entry` DBus hints) so only genuine WhatsApp PWA events are delivered, while all general browser notifications and unrelated web apps remain excluded.
   - Extended `desktop/src/notifications-cli.ts` with `notifications configure-selected` to configure the allowlist with one command.

3. **Reversible Provider Alert Adapters**:
   - Added `desktop/src/provider-alerts.ts` supporting reversible opt-in attention alerts:
     - Claude: registers a targeted `Notification` hook for `permission_prompt`, `agent_needs_input`, `idle_prompt`, and `agent_completed` invoking an isolated sanitized adapter that emits a GNOME notification with app name `Claude Code`.
     - Codex: configures standard `notify` handler in `~/.codex/config.toml` calling the alert adapter with app name `Codex`.
     - Both configurations record installation manifests, back up original files, and cleanly uninstall on request.

## Verification Evidence

- **Desktop Unit & Integration Tests**:
  - `desktop/test/notifications.test.ts`: all 33 tests passed, including exact PWA matching and exclusion of unrelated browser events.
  - `desktop/test/selected-notifications.test.ts`: 3 tests passed.
  - `desktop/test/feed-readiness.test.ts`: 5 tests passed covering missing vs installed wrapper states and allowlist sync.
  - `desktop/test/provider-alerts.test.ts`: 8 tests passed verifying hooks installation, atomic backups, conflict detection, and uninstallation.
  - Full desktop vitest suite: **207 passed (18 test files)**. Clean `tsc --noEmit`.

- **Live Setup Applied & Verified**:
  - `notifications configure-selected`: allowlist active with `Claude`, `Claude Code`, `Codex`, `codex`, `WhatsApp`, `WhatsApp Web`, and detected WhatsApp PWA selector `desktop-entry:whatsapp:chrome-hnpfjngllnobngcgfapefoaidbinmjnm-Default`.
  - `claude-install`: successfully installed wrapper wrapping existing status-line command with `/bin/bash` and verified `2.1.300` cancellation compatibility. Backup stored in `~/.config/phone-monitor/claude-settings.backup`.
  - `provider-alerts install-claude`: registered Notification hook for Claude user attention.
  - `provider-alerts install-codex`: configured Codex completion notification.
  - Background service restarted cleanly via `scripts/phone-monitor.sh` with active reverse mapping `tcp:8765`.
