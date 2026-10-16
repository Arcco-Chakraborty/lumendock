# D1 implementation and checkpoint report

Execution root: `~/.codex/worktrees/phone-monitor-build/Phone_monitor`.
Starting HEAD: `2a8ba20572dabb36d26cc9206e26cc907bf67f08` (managed detached HEAD).
Product baseline: `6501f489651816ab77dc6d45f3e20f0e8af2f0cd`.
Status: implementation/checks complete, checkpoint requested by coordinator; fresh independent D1 review still required. This is software evidence only; no device acceptance or finished-project claim.

## Scope delivered

- npm workspace bootstrap with exact dependency pins/lockfile, Node24 engine and `.nvmrc`, strict TypeScript configuration, build/test/typecheck/verify commands, and doctor diagnostics. Root connect/package dispatchers explicitly report that D3 prerequisites are absent until the later task supplies their scripts; they do not claim an ADB connection or package exists.
- Strict Zod schemas/exported types for usage sources/windows, complete hub snapshots, notifications, ESP state/history/link snapshots, nonempty ordinary or timer-only patches, positive safe-integer command generations and distinct state/timer outcomes, typed setup state/results, AppStatus and every exact `app.*` args/reply table. Unknown versions/ops/fields fail. Fixed error codes reject arbitrary provider text.
- Operation-specific request schema and reply-data map/factory, plus generic reply union. `PairResult` remains the native internal `{paired:boolean}` result; the hub pairing exchange separately returns its native token result.
- Six synthetic JSON fixtures: `hub-ready`, `hub-unknown`, `esp-ready`, `esp-history`, `app-status`, `esp-link-ready`. No captured user data.
- Private token storage: mode0700 product directory, mode0600 token file, no-follow reads, owner/file checks, bounded file content, constant-time bearer comparison, exclusive private temporary write/fsync/atomic rename. Existing token survives a failed replacement write.
- Pairing closed by default; cryptographic eight-digit code, 120000ms deadline, five total failed attempts, one-use synchronous exchange and 32-byte cryptographic token. Only successful persistence commits replacement/closes setup. Concurrent HTTP exchanges permit one success.
- Fastify health/snapshot/setup-pair routes with exact Host enforcement, rejection of every Origin header and query parameters, no request logging or CORS, strict JSON pairing, 16KiB input limit, no-store non-health responses and fixed safe errors. Binding lives only in main and is fixed to `127.0.0.1:8765`; startup does not kill a listener on conflict.
- HubStore retains good source windows through transient failures and over-capacity observations, reports `unsupported/SOURCE_CAPACITY_EXCEEDED` without truncation, computes source staleness at read time, records only authenticated phone activity, filters notifications through a default-empty allowlist, bounds ephemeral retention to100/30minutes and removes oldest complete records from an oversized response. No notification disk persistence.

## Toolchain and dependency evidence

Actual selected runtime: `~/.local/share/phone-monitor/toolchains/node-v24.22.0-linux-x64/bin/node` → `v24.22.0`.

- `curl -I -s https://nodejs.org/dist/v24.22.0/SHASUMS256.txt`: HTTP200.
- Downloaded official `node-v24.22.0-linux-x64.tar.xz` and compared `sha256sum` to the official SHA256 list: both `cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008`.
- Extracted only into the user-owned product toolchain directory. Every npm command selected it through a command-local PATH prefix. Default shell `node --version` remains `v20.20.2`; no nvm default/system Node change.
- Exact resolved pins: Fastify5.12.7, Zod4.6.7, TypeScript5.9.3, tsx4.23.15, Node types24.19.2, Vitest5.0.4 and Vite7.3.7.
- Initial requested Vitest3.2.7 audit failed: tinypool<=2.1.0 GHSA-5gmw-xhrv-c9v3 and tinypool<2.1.2 GHSA-85c8-ppgw-ccpr (critical); @vitest/mocker>=2.1.0<4.1.11 GHSA-82fw-gwwq-j7x9 (moderate). npm reported stable Vitest5.0.4 as the fixed major upgrade. Coordinator added an execution ruling to the brief authorizing Vitest5.0.4/compatible exact Vite7, based on the PRD stable/pinned requirement. No dev server was enabled.
- After exact upgrade, `npm audit --json` including development dependencies exited0, vulnerabilities `{}`, total0. Saved sanitized evidence: `.superpowers/sdd/2026-10-14-desktop-hub/task-1-audit-after.json` (140 total dependencies; prod54/dev87/optional53 per npm's overlapping categories).
- npm reported esbuild's install script is not covered by its allowScripts setting. No account/npm permission setting was changed. Installed platform binary supports the actual successful Vitest/Vite transforms; TypeScript build succeeds.

## TDD and repairs

1. Created fixtures and boundary tests before implementation. `npm run test --workspace @phone-monitor/protocol` failed on missing `src/index.js`; desktop targeted test failed on missing config/server modules. An initial desktop package resolution harness error was fixed with an explicit Vitest source alias, then rerun: only expected missing production modules remained. Missing exports/modules were an expected red condition in the D1 brief.
2. Implemented schemas; protocol tests passed11/11. Implemented pairing/store/server; desktop tests passed20/20.
3. Initial TypeScript check caught unresolved generic Zod link-payload inference and Fastify's unknown error type. Fixed both, preserving a required exactly typed link payload. Added independently compiled type-contract assertions for exact hub payload, brightness args and setup reply. The type assertions compile successfully.
4. Fastify emitted a deprecation warning for an unnecessary logging-disable option. Removed the option because `logger:false` already disables request logging. Later runs have no warning.
5. Added HTTP concurrency/total malformed-attempt tests and a full Unicode response-budget stress case. It keeps all2 Claude+62 Codex windows, omits oldest whole notifications, keeps the newest body intact and fits262144bytes.
6. Wrote a specific regression for `{power:undefined}` being accepted as a nonempty patch. Observed the behavioral failure (`expected true to be false`), then rejected undefined-only/undefined-field patches. Protocol suite now13/13, desktop22/22.
7. Bootstrap initially replaced the preexisting `.gitignore`; coordinator flagged that avoidable error. Restored every baseline ignore and extended it only with `*.tsbuildinfo`. `.superpowers`, scratch/worktrees, toolchains, artifacts, signing/local config and existing secret patterns remain ignored.

## Commands and final results

All npm commands use `PATH=~/.local/share/phone-monitor/toolchains/node-v24.22.0-linux-x64/bin:$PATH` from the execution root.

- `npm install --save-exact --workspace @phone-monitor/protocol zod@4`: pass, exact pin/lock.
- `npm install --save-exact --workspace @phone-monitor/desktop fastify@5`: pass, exact pin/lock.
- `npm install --save-exact --save-dev typescript@5 vitest@3 tsx@4 @types/node@24`: initial installation passed; audit findings above prompted the approved upgrade.
- `npm install --save-dev --save-exact vitest@5.0.4 vite@7`: pass, exact fixed stable pins.
- `npm run test --workspace @phone-monitor/desktop -- server.test.ts pairing.test.ts`: initial red missing implementation; later20/20pass before additional cases.
- `npm run verify`: final rerun after all product/type-contract changes checks the entire currently present workspace: protocol13/13, desktop22/22; typecheck including type-contract assertions; both builds. Exit0.
- `npm audit --json`: exit0; zero production/development vulnerabilities.
- `node .superpowers/sdd/2026-10-14-desktop-hub/task-1-smoke.mjs` using the absolute Node24 binary: exit0. Output: `PASS: fixture snapshot over real loopback HTTP; normal startup closed; unpaired snapshot rejected.` This uses only synthetic fixture/token/temp configuration, starts/stops its own listener/child, cleans temporary storage and never accesses provider accounts.
- `npm run doctor`: exit0; Node24.22.0 supported, selected absolute runtime printed, desktop hub built, Android APK not built.
- `npm run connect` and `npm run package`: expected exit1 with explicit D3 unmet-prerequisite messages. These commands do not attempt hardware/installation.
- `git diff --check -- .gitignore .nvmrc package.json package-lock.json tsconfig.base.json packages/protocol desktop scripts/workspace.mjs`: exit0.

## Files and commit scope

Product changes: `.gitignore`, `.nvmrc`, `package.json`, `package-lock.json`, `tsconfig.base.json`, `scripts/workspace.mjs`; `packages/protocol/{package.json,tsconfig.json,tsconfig.type-tests.json,src/schema.ts,src/index.ts,test/schema.test.ts,test/type-contract.test-d.ts,fixtures/*.json}`; `desktop/{package.json,tsconfig.json,vitest.config.ts,src/config.ts,src/pairing.ts,src/store.ts,src/server.ts,src/main.ts,test/pairing.test.ts,test/server.test.ts}`.

Ignored task evidence: this report, `task-1-smoke.mjs`, `task-1-audit-after.json`.
Excluded coordinator/parallel changes: HANDOFF/STATUS/PROGRESS and desktop plan; Android/dashboard files; scripts/build.mjs; toolchain records. No sibling firmware change, push, branch creation/switch, provider capture or hardware action.

Checkpoint: `863366909acda1c2a44d56879664bf09e7190a76` — `feat: add paired desktop hub and shared protocol`; 29 product files, 3090 insertions. Coordinator explicitly requested this local checkpoint before independent review so Android/UI can consume the frozen shared contract. D1 acceptance remains pending review.

Final staged diff check passed. Coordinator HANDOFF/PROGRESS/desktop-plan edits remain unstaged and outside this commit. Worktree remains detached; no push or branch change.

## Self-review and remaining concerns

- Required security/data boundaries are implemented and checked. No secret-bearing configuration is serialized by the API. Generated live pairing codes/tokens were not saved in report/git/logs. Synthetic fixtures use recognizable synthetic labels.
- Error codes are an exported fixed enum. Future collectors/native components should map failures into this safe contract; any additional codes require a coordinated contract amendment rather than arbitrary error text.
- Generic link inference has a narrow documented type assertion at the schema factory; independent compile-time assertions protect required payload typing and actual runtime tests protect age validation.
- Root connect/package need their planned D3 scripts; doctor correctly reports absent APK. No claim that later tasks or packaging are done.
- Fresh independent task review has not yet run. No actual Claude/Codex collector behavior, Android routing, Redmi, ESP32/light or device acceptance was tested in D1.
- Checkpoint/ledger updates belong to the coordinator. Request checkpoint of this implementation/report and the final review outcome.

## D1 fix round 1 — review consistency findings

Reviewed the full fresh report `task-1-review.md` and verified its findings against design lines 198–200 before editing. Reviewed product base: `863366909acda1c2a44d56879664bf09e7190a76`. Current HEAD during this fix: `4eb58a7c98f3d98fc3c1a96e13473e4f44216699` (coordinator checkpoint changes). This fix changes only `packages/protocol/src/schema.ts` and `packages/protocol/test/schema.test.ts`.

- **D1-R1:** Replaced the non-design `COMMAND_QUEUE_FULL` enum member with the required `QUEUE_FULL`. Added a regression accepting `QUEUE_FULL` in a failed operation-specific `esp.set` reply and rejecting the old alternative. A focused production-source search now finds only `QUEUE_FULL`; the old spelling remains solely in the negative regression.
- **D1-R2:** Tightened normalized `EspState.hex` to `#` followed by six uppercase RGB digits. Added a regression accepting `#12ABEF` and rejecting lowercase `#12abef` as state, while confirming `LightPatch` still accepts lowercase colour intent.

Red/green evidence, using the same command-local Node 24 PATH prefix as above:

1. Added both regressions before the schema fix. `npm run test --workspace @phone-monitor/protocol -- test/schema.test.ts` exited 1: 2 failed, 13 passed. Queue error failed `expected false to be true`; normalized colour failed `expected true to be false`.
2. Applied only the two schema corrections. Reran the exact schema test command: exit 0, 15 tests passed, one test file passed, Vitest 5.0.4.
3. `npm run typecheck --workspace @phone-monitor/protocol`: exit 0; `tsc --noEmit && tsc --noEmit -p tsconfig.type-tests.json`, including the independent payload/args/reply type assertions.
4. `npm run build --workspace @phone-monitor/protocol`: exit 0; `tsc`.
5. `git diff --check -- packages/protocol/src/schema.ts packages/protocol/test/schema.test.ts`: exit 0.

No root manifest/lockfile, Android/dashboard, coordinator records, or unrelated source edits. No full frontend workspace rerun: W1 owns its active dependency changes. Both findings are addressed in the working tree; commit is intentionally pending the coordinator's requested serialization. Fresh focused re-review/acceptance remains owned by the coordinator.

Coordinator then authorized the serialized fix commit. Created `75cb65dd752eaa33df3aa636241bf91ed4d42e49` — `fix: align queue error and normalized ESP colour contracts` — from base `4eb58a7c98f3d98fc3c1a96e13473e4f44216699`. Exactly the two protocol schema/test files were staged (13 insertions, 2 deletions); staged diff check passed. Previously evidenced tests were not rerun because the verified source was unchanged. Independent focused re-review remains pending.
