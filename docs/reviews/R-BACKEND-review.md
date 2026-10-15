# Backend review — informational, outside current UI scope

2026-10-15. Review stopped when the user narrowed the active task to UI only. These are established observations from the supplied baseline `87bd88d` review package, not a completed backend approval gate. No backend fixes, tests, live actions, or provider configuration changes were performed by this reviewer.

## Verdicts

- Spec compliance: issues found in bounded action completion and safe errors; remaining backend review incomplete.
- Code quality: needs fixes for the observations below if backend work is reopened. These findings do not expand the current UI task.

## Strengths

- `desktop/src/server.ts:15` applies the existing strict Host/Origin/query checks to the action route, and `desktop/src/server.ts:54` requires the existing bearer-token check.
- `desktop/src/actions.ts:21` dispatches fixed action cases; phone input is not interpolated into an executable shell command.
- `desktop/src/provider-alerts.ts:106` reduces accepted provider events to fixed generic notification text and does not read transcript paths.
- `desktop/src/collectors/notifications.ts:160` checks the exact PWA desktop-entry hint before processing notification text. `desktop/src/store.ts:26` retains prior quota windows for non-available source states.

## Established important findings

1. **Unbounded subprocess lifetime:** `desktop/src/actions.ts:23` and the other `exec` calls have no timeout or cancellation. Their promises resolve only when the command exits; a desktop application that remains running can leave the HTTP action pending indefinitely. Use a bounded launcher/control runner with explicit completion semantics and controlled cleanup.
2. **Raw errors cross the API boundary:** `desktop/src/actions.ts:24` (also lines 29, 34, 41, and 47) forwards `err.message`, which can contain command text and subprocess stderr. `desktop/src/server.ts:59` forwards that result directly. Return fixed, bounded safe failure messages/codes instead.
3. **False media success:** `desktop/src/actions.ts:53` (also lines 59 and 65) always resolves success, while the shell loop suppresses failures with `|| true`. Missing D-Bus tools, no available players, and failed player operations therefore appear successful. Distinguish execution success from unavailable/failed control using bounded safe results.
4. **Tests alter host audio:** `desktop/test/server.test.ts:136` adds an authenticated `media_mute` request without substituting the real action executor. It reaches `wpctl` or `amixer` on the test host. Inject a test action runner before rerunning this test or the full desktop suite; tests must not toggle the user's actual audio.

## Unresolved evidence

- `docs/reports/R-BACKEND-implementation.md` claims live status-line installation and Claude 2.1.300 shell/cancellation compatibility. The reviewed `.superpowers/redesign/claude-startup-probe.py` is a probe script, not a recorded successful result; this review did not verify that live claim.
- Actual selected Claude/Codex/WhatsApp notification delivery, PWA wire identity, setup rollback, and device acceptance remain unverified by this reviewer. No real provider private data/configuration was read.
- The current official [Claude hooks reference](https://code.claude.com/docs/en/hooks#command-hook-fields) supports `command` plus `args` exec-form hooks. That configuration shape is not an established defect; compatibility with the exact installed version was not independently exercised.

## Checks performed

Read the requested task brief, implementation claims, supplied diff, recovery records, and relevant PRD/design requirements. Focused unchanged-code checks covered the action route's global security hooks, quota-retention behavior, existing status-line installer gates, and the sanitized startup-probe script. Read official hook documentation to resolve the command/args contract. No test suites, live endpoints, physical controls, provider sessions, or inference were run. Review stopped before remaining uncertainties could be investigated.
