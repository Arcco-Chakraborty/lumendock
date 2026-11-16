# Calendar private storage investigation and repair

Date: 2026-11-16. Canonical worktree: `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`, baseline `e59d312` with pre-existing uncommitted Calendar, Clock and offload changes. Scope: Calendar private-storage subprocess repair; no staging or commit.

## Findings

- On Ubuntu, metadata-only inspection of this application's expected Calendar storage found `connection.json` present with mode `0600`, and both `client.json` and `tokens.json` absent. No file contents were opened. This establishes missing currently saved credentials; it does not establish whether authorization was previously completed, cancelled, disconnected or invalidated. `CalendarService.read()` intentionally returns `disabled` when disconnected. A new grant/source selection is a user-owned prerequisite, and a rebuild alone does not install it.
- The existing Ubuntu and Windows launcher/tray commands do not expose the Calendar CLI. The Agenda setup screen shows a repository-relative `node desktop/dist/main.js calendar connect --client ...` command, making setup hard to reach from a desktop shortcut. Launcher/setup improvements are coordinator-owned.
- `docs/CALENDAR.md` previously described `%APPDATA%` on Windows, while `desktop/src/config.ts` and the Windows launcher actually use `XDG_CONFIG_HOME` or the user's `.config` directory. Documentation correction is coordinator-owned; this repair does not migrate user storage.
- The Windows ACL helper passed a string script and a trailing directory to `powershell.exe -Command`, but the script expected `$args[0]`. Microsoft documents that every argument following string `-Command` becomes command text, rather than script parameters. This makes the directory unavailable as the intended argument and may parse path syntax as code. Reference: [Microsoft about_PowerShell_exe](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1).

## Change

`desktop/src/calendar/connection.ts` now sends the static ACL program with UTF-16LE `-EncodedCommand`. A dedicated `LUMENDOCK_CALENDAR_DIRECTORY` environment entry carries the exact literal path; it never enters command source or trailing command arguments. The program rejects an empty target and retains its existing current-user-only DACL application/verification and fail-closed behavior.

`desktop/test/calendar-storage.test.ts` exercises the real helper/store/CLI while intercepting the unavailable native PowerShell subprocess. A synthetic target contains spaces, an apostrophe, command-like characters and Unicode. The tests verify command/data separation and that native ACL failure prevents OAuth and any connection/credential persistence.

## Verification

- Before the fix, the new focused suite failed as expected: one unsafe-invocation regression failed, and the existing fail-closed behavior passed. The failing assertion showed `-Command` plus a trailing raw target instead of a single final encoded program argument.
- After the fix, storage/connection/OAuth suites: **12/12 passed**.
- Full desktop suite: **33 files, 313/313 tests passed**.
- Desktop TypeScript: `npm --workspace @phone-monitor/desktop run typecheck`, exit **0**.
- Scoped whitespace check: `git diff --check -- desktop/src/calendar/connection.ts desktop/test/calendar-storage.test.ts`, no findings.
- Before repair, the five existing Calendar suites passed **31/31**, demonstrating that prior tests did not cover the actual native invocation contract.

## Limits and handoff

No Windows PowerShell runtime is available in this Ubuntu environment, so actual Windows ACL execution and browser consent remain unrun. The defect is supported by the invocation contract and Microsoft's documented semantics; synthetic boundary tests do not establish Windows device acceptance. No live Google API calls, OAuth client/token contents, account identities, event payloads, private logs, OS/profile ACLs or device/service state were accessed or changed. No claim of completed real-account setup, label fidelity or device acceptance is made. A fresh independent scoped review remains coordinator-owned.
