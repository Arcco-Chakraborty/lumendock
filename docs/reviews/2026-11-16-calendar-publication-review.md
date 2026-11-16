# Calendar repair and source publication — scoped independent review

Date: 2026-11-16. Required `gpt-6-astra` with high reasoning was executed for this fresh independent scoped review. Execution root: `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`; branch `codex/calendar-windows-recovery`; baseline `e59d312b0a27c9a3e8b658c34993a22a3be5645b`. The reviewed candidate is the staged stable source snapshot, not the incomplete offload branch.

## Verdict

**Approved for the scoped Calendar repair and source publication after the evidence-file exclusion below. No open actionable finding remains in this scope.** This is not whole-project approval, a replacement for the historical final review gate, Windows runtime acceptance, Google account acceptance, or physical phone/ESP32 acceptance. Coordinator-owned full build checks and final checkpoint reconciliation remain separate prerequisites before publication.

Read AGENTS, HANDOFF, STATUS and PROGRESS first, then the PRD, original system design, Calendar design/plan and prior Calendar/Clock review records. Inspected the staged changes against the actual baseline, the publication-boundary manifest, Calendar CLI/storage/OAuth/service integration, native transport wiring, package manifests and recovery instructions. Historical reports were treated as claims to check, not proof of current behavior.

## Root cause and repair

- The current Ubuntu symptom has a setup prerequisite: the coordinator's metadata-only investigation found no currently saved client/token files. This does not disprove the user's earlier setup, identify why credentials disappeared, or establish that the Windows storage defect caused the Ubuntu symptom. Rebuilding alone cannot complete Google authorization. The recovery guide correctly distinguishes reconnecting from applying Calendar selection and explains the existing-project client download path.
- The old Windows subprocess supplied a trailing directory after a string `-Command`, while the script expected `$args[0]`. Microsoft's [Windows PowerShell executable documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1), independently opened during review, states that following arguments become command text. The replacement encodes only the static program in UTF-16LE and supplies the literal directory through a dedicated environment entry. It uses `Set-Acl`/`Get-Acl -LiteralPath`, rejects an empty target, retains the protected current-user DACL and preserves failure before OAuth. No dynamic directory becomes PowerShell source.
- The new synthetic regression covers spaces, an apostrophe, command-like syntax and Unicode. Its second case exercises the actual CLI/store failure path and proves that native ACL failure neither starts authorization nor persists connection/client/token files. These are subprocess-boundary tests, not an execution of Windows security APIs.
- `docs/CALENDAR.md` is now included in both desktop package manifests, with explicit tests for both archives. The documented Windows configuration base matches `defaultConfigDirectory()` and the launcher: `%USERPROFILE%\\.config\\phone-monitor`, subject to `XDG_CONFIG_HOME`. The root `calendar` command reaches the CLI before starting hub collectors.

## Publication boundary and resolved finding

**P1 publication finding, resolved before approval:** the initial staged candidate included new `dashboard/evidence/flip-clock/device-*.png` and `dump.xml` files among 265 new evidence assets. Their provenance was not established as sanitized synthetic data; publishing them would conflict with the explicit private-capture boundary. No potential private payload was opened by this reviewer. The coordinator excluded all newly added dashboard evidence from both publication candidates and added an ignore rule while preserving local files.

Independent verification after correction found **zero newly added `dashboard/evidence/` files** against `e59d312` in either the stable index or `codex/phone-hub-offload-wip` (`0483b767cef87459dbd2e51c3920353fa212273b`). All 24 WIP-only paths in the publication-boundary manifest are absent from the stable index; no corresponding stale desktop compiled JS remains. Source searches found no remaining offload/PhoneCalendar/LocalHub implementation references in the stable product trees. The existing Calendar path remains laptop-owned and wired through the native USB bridge.

The earlier Calendar Astra review explicitly withheld approval on 15 findings; its subsequent feature rereview explicitly disclosed a different runtime. This pass does not rewrite that history or silently close the whole-feature/final-project gate. Current source and synthetic regressions were checked for the loadbearing earlier repairs: native receipt age independent of Google sync age, merged-range capacity accounting, drained request batches, backoff at dispatch, resident refresh scheduling, failed source discovery, and dashboard selection/pagination/source reset fences. No additional consequential regression was found in those inspected paths.

## Independent verification

Used the existing local Node 24.22.0 toolchain without changing the default Node installation:

```text
npm exec --workspace @phone-monitor/desktop -- vitest run test/calendar-storage.test.ts test/calendar-connection.test.ts test/calendar-oauth.test.ts test/calendar-api.test.ts test/calendar-service.test.ts test/calendar-review-regressions.test.ts
6 files, 33 tests passed; exit 0

npm exec --workspace @phone-monitor/dashboard -- vitest run test/packaging.test.mjs test/calendar.test.ts
2 files, 83 tests passed; exit 0

git diff --cached --check
exit 0
```

The storage source/test, packaging source/test and both recovery guides matched their staged bytes at review completion. SHA-256 for `desktop/src/calendar/connection.ts`: `5cf3820ec7be6d0f9aa56bd1adc2a21f57eabd2f964b81c57630388b30f19fb1`; for `scripts/lib/package-build.mjs`: `24ddb78aab2b4c6ee4ca7ec1367a576c2a1f77dd98040a3e6677632af38a00e1`.

No real credentials, account identities, events, private logs or capture contents were read. No real provider request, browser consent, running hub action, OS permission/profile ACL change, device action, commit or push was performed by this reviewer. Actual Windows private-directory protection/browser launch, real-account labels and simultaneous Redmi USB/ESP32 Wi-Fi operation remain unrun here. Keep software verification separate from device acceptance. The coordinator owns HANDOFF/STATUS/PROGRESS updates and final publication evidence.
