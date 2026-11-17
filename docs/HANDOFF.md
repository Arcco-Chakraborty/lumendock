# LumenDock live handoff

## 2026-11-13
- Historical checkpoint: [root handoff](../HANDOFF.md).
- Windows checkout main at e59d312. User requests WhatsApp repeat suppression and Google Calendar repair. Windows notification source is desktop/src/win/notifications.ts; its cursor resets when max live row ID falls and its content cache expires quickly. Next: reproduce both with synthetic rows and check Windows toast metadata without reading live payloads.
- Calendar source remains absent from upstream heads. Next: check phone APK and available local artifacts for the 1.3.2 contract and source.
- Synthetic regression reproduced duplicate at 30 s. Plan: WhatsApp-only sliding 30-minute window bounded to 2,048 hashes, preserve normal 2 s gate for others, keep cursor high-water across live row removal. Calendar: APK 1.3.2 confirms hub.calendar, hub.calendarSources, hub.calendarSelect bridge; no source in GitHub heads, Windows tree, or WSL mount. Need Ubuntu source transfer for a faithful repair.
- Implemented Windows-only sliding WhatsApp suppression and cursor fix. Next: run desktop suite, build desktop workspace, then stop/start Windows hub and check health/USB reverse.
- Desktop tests: 219 passed, 4 skipped; build succeeded. Restarting Windows hub to load the fix.
- Deployed locally via scripts/windows/lumendock.ps1 restart; /healthz OK and USB reverse tcp:8765 active. Real WhatsApp delivery remains unverified; identical text from the same app inside the sliding window may also suppress a genuinely repeated message. Calendar pending: obtain Ubuntu source for the installed 1.3.2 build via shared D: drive or a branch. Then inspect Google OAuth/config and hub endpoints before porting; preserve existing pairing.

## 2026-11-15 product assessment
- Research only. Parallel scoped research: desk software/hardware substitutes and adoption/pricing evidence. Coordinator checks current packaging and technical scope, then delivers decision and validation gates in chat.
- Market assessment evidence: public v1.3.1 with APK 1.2.0, 0 stars/forks/issues and 0 asset downloads for that release on inspection. PhoneBox is a direct free MIT substitute, CodexBar and TRIGONE show adjacent demand. Recommendation: cap effort at a narrow Windows 11 + Android closed beta, benchmark first-run and recovery against PhoneBox, retain ESP as optional. No product code changes in this assessment.

## 2026-11-17 Windows update to main 87f1131 (Claude Code)
- Pulled main (Android/desktop 1.3.2 with Calendar). Local WhatsApp-dedupe edits (desktop/src/win/notifications.ts + test) kept via stash/pop; upstream HANDOFF.md and docs/PROGRESS.md taken as-is (my 2026-11-04 notes dropped, superseded by this entry). `npm ci`, build, typecheck clean.
- FIXED (uncommitted): `protectWindowsDirectory` in desktop/src/calendar/connection.ts failed on every call after the first with SeSecurityPrivilege (a fresh DirectorySecurity makes Set-Acl write the SACL). Now reads the existing ACL, rewrites only the DACL, and skips when already private. 23 desktop tests had failed with CALENDAR_PRIVATE_STORAGE; real Calendar would have too.
- Test tweaks (uncommitted): calendar-connection.test.ts skips the POSIX 0o600 assertion on win32; desktop/vitest.config.ts testTimeout 30 s on win32 (each real ACL step starts PowerShell). Suite green twice: protocol 60, desktop 254/4 skip, dashboard 208/1 skip.
- Hub restarted via scripts/windows/lumendock.ps1 start; healthz ok, reverse tcp:8765 active, phone paired (token kept). Phone (APK 1.3.2, left untouched; signing key is only on Ubuntu) now shows "Connect Google Calendar" = Calendar protocol working. `npm run calendar -- status` = disconnected (Google sign-in deferred by the user).
- OPEN: Windows clock is 5.5 h slow (10:38 vs phone 16:08, both IST): dual-boot RTC mismatch. w32tm /resync fails (Windows Time service stopped; needs admin). Claude/Codex cards show Stale / "5h ago" because of it. Fix needs the user (admin): see chat. Permanent fix options: Windows `RealTimeIsUniversal=1` or Ubuntu `timedatectl set-local-rtc 1`.
- Next: after the clock is fixed, confirm Claude/Codex cards go fresh; commit + push the fixes if the user agrees; Calendar sign-in per docs/WINDOWS.md when the user has their Desktop client JSON.
