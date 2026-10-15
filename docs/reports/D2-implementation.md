# D2 desktop collector implementation report

Status: READY for coordinator's fresh Astra/high review; no commit created. Product/device acceptance is not implied.

Execution root: `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`. Dispatch baseline `26c4e541f52050b64216b6c23c524b8c5e26b3a9`; D1 authority `75cb65d`. Shared HEAD observed during final checks: `03847a332284d6f574b5de3029f04ac486f2a50d` (other component commits are coordinator-owned). Existing modified/untracked Android/dashboard/checkpoint files were left to their owners. No root package/dependency/protocol edits were needed.

## Implemented files

- `desktop/src/collectors/claude.ts`: whitelisted normalization, expiry-aware row age, conservative first-cache classification, separate response counters, hashed session discriminator, global genuine-report ordinal, 32-session bound, 24-hour inactivity pruning on capture, atomic locked private persistence, winner preservation through cache-session churn, unchanged reload timestamps.
- `desktop/src/collectors/codex.ts`: pinned CLI version probe, shell-free app-server child, numeric ID correlation, ordered initialize/initialized/account/read/rateLimits/read, 10-second deadlines, 256-KiB JSONL cap, read-only method allowlist by construction, legacy/multi-bucket normalization with real server duration, sparse updates/full-read reconciliation, retained full-read age, 62-window explicit capacity failure, sanitized failure states, stderr drain without storage/logging, jittered 60/300-second cadence with activity-change re-evaluation, bounded crash backoff, shutdown escalation, and no overlapping replacement children.
- `desktop/src/collectors/index.ts`, `desktop/src/main.ts`: foreground hub collector lifecycle, one-second private Claude reload without freshness invention, independent provider failures, owned shutdown.
- `desktop/src/claude/install.ts`: opt-in API, absolute readable owned wrapper/Node selection, declared shell plus explicit compatibility attestation for existing commands, advisory locks, exact private original-byte backup, atomic settings commit, wrapper field ownership, idempotency, explicitly supplied project/managed override diagnostics, and compare-and-restore of only statusLine during uninstall.
- `desktop/src/claude/wrapper.ts`: standalone Node entry point, separately bounded monitoring capture while forwarding entire original stdin, previous shell syntax as a separate argument, inherited cwd/env/stdout/stderr, backpressure/EPIPE, original exit status, private capture failure isolation, minimal model label without an original command, tracked process-group SIGTERM/SIGINT cleanup, 500-ms grace then escalation/reaping, propagated termination semantics, and resistant background descendant cleanup after normal parent completion.
- `desktop/src/private-files.ts`: owned/no-follow bounded reads, private directory creation, mode-0600 atomic writes with fsync/rename, fail-closed advisory locking.
- Five new test files plus two recognizably synthetic fixtures under `desktop/test/fixtures/`. Existing D1 tests remain unchanged.

## Red/green evidence

All commands below selected `/home/arcco-chakraborty/.local/share/phone-monitor/toolchains/node-v24.22.0-linux-x64/bin` explicitly through PATH. System/default Node/Java were unchanged.

1. Required initial command `npm run test --workspace @phone-monitor/desktop -- claude.test.ts codex.test.ts installer.test.ts` failed with three absent collector/installer module suites. These failures required no account access. After implementation: 17/17 passed and desktop typecheck passed.
2. Real-subprocess wrapper tests first failed 4/4 because the wrapper was absent: nonzero exit expected7/9 but received1; no descendant PID; no standalone capture. After implementation: 4/4 passed.
3. Additional Claude regression failed first with disappearing response counters incorrectly refreshing observation1000 to2000; after that repair, the next assertion exposed cache-only session churn evicting the winner (null instead of1000). Both corrected; covering suite passed24/24 at that point.
4. Three Codex lifecycle tests failed first: failed version probe spawned unchecked; phone activity did not shorten the idle cadence; replacement spawned while old child remained alive. Repaired by re-verifying before any unchecked spawn, activity cadence re-evaluation, and awaiting old-child exit before restart/backoff; Codex suite then passed11/11.
5. Resistant background descendant regression failed first with live state `S` after normal previous-command exit. Wrapper now escalates the remaining owned group; covering suite passed54/54.
6. Primitive quota snapshot acceptance and surplus initialized params failed two tests; corrected strict primitive rejection and exact generated notification shape. Covering suite passed58/58.
7. Missing-wrapper installer regression failed because settings were replaced successfully. Installer now refuses unavailable/unowned/nonregular wrapper paths before edits; synthetic installer fixtures create harmless real wrapper files.

## Final scoped verification

Final commands:

```text
npm run test --workspace @phone-monitor/desktop
npm run typecheck --workspace @phone-monitor/desktop
npm run build --workspace @phone-monitor/desktop
git diff --check -- desktop
```

Final run after the missing-wrapper repair:

```text
Test Files  7 passed (7)
     Tests  59 passed (59)
  Start at  11:03:21
  Duration  5.78s

> @phone-monitor/desktop@0.1.0 typecheck
> tsc --noEmit

> @phone-monitor/desktop@0.1.0 build
> tsc
```

All four final commands exited0, including whitespace/diff checks (no output). This is the D2 covering gate; no live/device acceptance is implied.

A broad workspace run was also performed before the last two narrow regressions: `npm test` passed protocol15, desktop56, dashboard39 tests. Aggregate `npm run typecheck` and `npm run build` both found concurrent dashboard `src/lib/lightIntent.ts(20,36)` TS2322 (`power:boolean|undefined` incompatible with EspState). Protocol/desktop checks in those commands passed. This cross-scope transient failure was reported to the coordinator, who routed it to W2 and requested no repeated aggregate runs while its owner is editing. D2 did not modify dashboard code. W3 must verify the stable integrated workspace.

## Compatibility and privacy boundaries

Read-only CLI discovery: installed Codex `codex-cli 0.162.0-alpha.17.2` matches the plan. `codex app-server --help` confirms stdio transport. Generated TypeScript into a temporary directory only and inspected `GetAccountResponse`, `GetAccountRateLimitsResponse`, `RateLimitSnapshot`, `RateLimitWindow`, `AccountRateLimitsUpdatedNotification`, `ClientNotification`, and initialization types. No app-server account call was made. Generated third-party comments were not copied into project code.

Claude `--version` now reports `2.1.300`, differing from checkpoint2.1.299. Current official [statusline documentation](https://code.claude.com/docs/en/statusline) was checked for field names and event/expiry behavior; this is interface research, not proof of installed cancellation semantics.

Public UsageSource contains only protocol quota/state/timestamp fields. No session hash, API counters, genuine ordinal, account identifier, credits, plan metadata, transcript/cwd/model input, raw JSON, or provider stderr is exported. Local Claude metadata stores only hashed session identity, necessary numeric response signature, ordinal and age fields alongside the normalized observation. Mode0600 files and mode0700 configuration directories were asserted in temporary fixtures. The hub's D1 serializer/schema remains the public boundary.

No provider auth files, tokens, real transcripts, private session logs, account emails or notification captures were read. No inference, provider login/logout, installation into real Claude settings, push/publish, firmware operation, system-default change or OS permission grant occurred. No identity/attribution was added.

## Installer and cancellation evidence / limitations

Temporary settings tests prove original type/padding/refreshInterval retention, exact byte backup, original field restoration with unrelated edit preservation, no-op repeat install/uninstall, conflict refusal, concurrent product writer serialization, absolute quoted command execution through a real shell with spaces/single-quotes/Unicode/metacharacters in paths/input, and shell/cancellation/missing-wrapper prerequisites leaving the original statusLine untouched. Override diagnostics only inspect paths explicitly supplied to the API.

Real synthetic wrapper subprocess tests prove all stdin/stdout bytes preserved above256KiB, monitoring skipped on overflow, malformed capture does not corrupt previous output, early EPIPE is harmless, previous nonzero status survives, standalone private capture works without the hub, normal cancellation propagates the signal, resistant descendants are stopped after500ms, and repeated invocations leave no live owned descendants. Linux `/proc` checks distinguish a dead zombie awaiting container init reaping from a running descendant; the wrapper reaps its direct child. No SIGKILL cleanup handler is claimed.

Existing-command passthrough remains gated: installation requires an absolute declared previousShell plus explicit shell/cancellation compatibility attestation tied to a Claude version. Tests use synthetic attestations only. **The installed Claude2.1.300 normal cancellation path has not been verified; do not enable existing-command passthrough on the real settings until that opt-in verification is performed.** No-original-command mode does not require shell passthrough attestation. The installer functions are ready for D3's explicit setup flow; there is no implicit configuration install on hub startup.

Other unrun acceptance: live provider-managed account read, real quota notification stream, real statusline rendering/settings override observation, Redmi simultaneous USB/Wi-Fi routing, and actual ESP32/light behavior. Final project/device gates and fresh Astra/high review remain coordinator-owned.

Advisory-lock crash recovery fails closed with CONFIG_BUSY rather than stealing a possibly live lock. A later explicit setup diagnostic may identify/remove an abandoned product lock after checking ownership; this implementation does not silently remove one.

## Next action

Coordinator: run fresh Astra/high task review against the actual desktop diff and this report, address findings with the original D2 owner, then grant the serialized commit window. Suggested commit: `feat: collect subscription limits without exposing provider credentials`. No commit has been made by this worker.

## Serialized implementation checkpoint

Coordinator granted the commit window after A1 baseline `4a88b40ba278086620ca66a457783bf96b5e275a`. Committed only the 14 D2 desktop files at **`00dd183173aecaf049e72b7428837d8a053c0b6f`**, message `feat: collect subscription limits without exposing provider credentials`. Existing Git identity used; no attribution or root/shared/coordinator/dashboard files included. Source was unchanged after the final59-test/typecheck/build verification. Fresh Astra/high review remains pending.
