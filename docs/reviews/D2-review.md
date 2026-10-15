# D2 independent task review

Spec compliance: **Issues found**. Code quality: **Needs fixes**.

Reviewed `4a88b40ba278086620ca66a457783bf96b5e275a..00dd183173aecaf049e72b7428837d8a053c0b6f` using the supplied diff once, task brief, implementation report, and binding PRD/design. Android/dashboard changes are outside this review.

## Strengths

- `desktop/src/collectors/claude.ts:38`: separates response evidence from timer reruns, retains expired rows with their own report times, and classifies first-seen cache conservatively. The locked persisted ordinal and protected winner implement cross-session arbitration (`:77`); tests exercise expiry, restart, and cache-session churn (`desktop/test/claude.test.ts:18`, `:38`, `:63`).
- `desktop/src/claude/wrapper.ts:34`: saved command remains a separate shell argument, with inherited cwd/environment/output. Monitoring overflow does not truncate passthrough; owned-group cancellation and escalation are implemented. Real subprocess tests cover bytes, nonzero exits, early EPIPE, cancellation, and resistant descendants (`desktop/test/wrapper.test.ts:15`, `:27`, `:37`, `:44`).
- `desktop/src/claude/install.ts:51`: existing-command installation requires explicit shell and cancellation attestation; command paths are quoted, backups are private, and uninstall restores only the owned field (`:70`). The report honestly distinguishes synthetic cancellation tests from unverified installed-Claude compatibility.
- `desktop/src/collectors/codex.ts:88`: requests are serialized, correlated by numeric IDs, and bounded by deadlines/line length. The method set is read-only; notification merging preserves other buckets, full reads reconcile, and errors retain usable values (`:105`, `:124`).

## Important findings

### D2-R1 — Failed settings commit strands ownership state

`desktop/src/claude/install.ts:61` persists `claude-install.json` before the settings comparison/atomic commit at `:64–66`. If that commit fails, the current statusLine is still the original value, but the persisted record claims the wrapper is installed. Subsequent install and uninstall both reject `STATUSLINE_OWNERSHIP_CONFLICT`. The same transaction gap exists if execution stops between those writes. This turns a transient setup failure into a state the provided APIs cannot recover from.

Focused fault-injection check: a synthetic `EIO` on the settings rename left the original settings bytes unchanged; after restoring normal filesystem behavior, both retry and uninstall failed with `STATUSLINE_OWNERSHIP_CONFLICT`. Only temporary synthetic files were used.

Fix with an explicit recoverable transaction state and reconciliation under the locks. Recognize an uncommitted record when settings still match the recorded original field, while continuing to reject genuine intervening edits. Preserve the wrapper's ability to read its record immediately when settings activation succeeds. Add failure/retry and interrupted-transaction regressions; include the analogous restore-before-record-removal uninstall interruption in the recovery design.

### D2-R2 — Restart during a version probe leaves Codex idle

`desktop/src/collectors/codex.ts:51–64`: `stop()` invalidates the pending probe's generation but leaves `probing` true. A new `start()` sets `running` true, then `probeVersion()` returns immediately because the old probe is still pending. The old completion sees a generation mismatch and returns; its `finally` only clears the flag. No child, retry timer, or new probe remains, so the collector stays idle until another explicit retry.

Focused deferred-probe check: `start(); await stop(); await start(); resolve old probe` produced **one version probe and zero child spawns** after the old promise settled. This is a deterministic lifecycle failure, not a provider/account dependency.

Fix by making probe ownership generation-specific and ensuring the new start waits for retirement or schedules its own probe after the obsolete one settles. Test stop/start while version verification is unresolved and require exactly one valid replacement child without overlapping children.

## Scope and evidence

- One focused unchanged-code check: risk that `HubCollectors.loadClaude()` error updates erase last good quotas. Inspected `HubStore.updateUsage()`/`snapshot()` in `desktop/src/store.ts:19–33`, `:52–66`; non-available updates preserve prior windows/full-read time and snapshots continue staleness calculation. No finding.
- Ran one Node24/tsx synthetic diagnostic covering only D2-R1 and D2-R2. It exited 0 and printed the failure outcomes above; temporary files were removed. No package suite/typecheck/build was rerun. Reported 59 desktop tests/typecheck/build remain implementer evidence; the reported concurrent W2 aggregate failure belongs to integrated verification.
- Cannot verify from this diff: actual Claude2.1.300 cancellation compatibility, live provider-managed account/notification behavior, D3 setup wiring, or full cross-component/device integration. Existing-command passthrough must remain disabled until D3 verifies the installed version and compatibility before supplying the attestation. The report states these limitations sufficiently; they are not claimed as passing acceptance.
- No critical findings. No additional minor findings. After the two fixes, obtain a scoped re-review; software/device/final-project acceptance remains separate.
