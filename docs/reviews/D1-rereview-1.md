### Finding Verdicts

- **D1-R1 — Required queue-overflow error name** — **ADDRESSED**. `packages/protocol/src/schema.ts:18` now exports `QUEUE_FULL` in place of `COMMAND_QUEUE_FULL`. The operation-specific failed `esp.set` regression accepts the required name and rejects the old name (`packages/protocol/test/schema.test.ts:47`).
- **D1-R2 — Uppercase normalized ESP state** — **ADDRESSED**. `packages/protocol/src/schema.ts:52` now requires six uppercase RGB digits in `EspState.hex`. The regression checks uppercase acceptance, lowercase state rejection, and continued acceptance of lowercase user colour intent (`packages/protocol/test/schema.test.ts:52`).

### New Breakage in the Fix Diff

- None. The two production edits narrowly correct the reviewed contract values. The accompanying coordinator documentation records existing rulings/evidence and retains false software/device/final-project gates (`docs/STATUS.json:22`).

### Out-of-Scope Observations

- None.

### Checks

- Read the scoped re-review template and appended D1 fix report. The report names the covering schema test command and records red output with two failures/13 passes, then green output with 15 passing tests; protocol typecheck and build both exited zero. The assertions in the exact fix diff cover both defects directly. No suites were rerun.
- Reviewed `.superpowers/sdd/2026-10-14-desktop-hub/review-8633669..75cb65d.diff`, from `863366909acda1c2a44d56879664bf09e7190a76` to `75cb65dd752eaa33df3aa636241bf91ed4d42e49`, including intervening coordinator checkpoint commit `4eb58a7`. Initial combined output truncated coordinator documentation; recovered only that cut-off portion. No changed source file was separately reread; no broader crawl, Git mutation, or subagents.
- Only this requested ignored re-review report was written.

### Verdict

**Fix round:** All findings addressed, no new Critical/Important breakage. D1's scoped spec-compliance and quality gate is approved following these fixes; broader software/device/final-project gates remain separate.
