# W2 scoped re-review 1 (repair 571d45d)

**Reviewer: Claude Code (claude-sonnet-5-5), NOT the required gpt-6 Sol/Astra model. This is an interim check; the Codex Sol-high gate stays OPEN.**

Scope: only W2-R1, W2-R2, W2-M1 from `W2-review.md`, against `git show 571d45d`.

- **W2-R1 addressed (code + evidence).** `applySnapshot` now acknowledges command outcomes before applying `snapshot.data`, and `ack` dedupes a consumed `(generation, outcome)` pair and refuses to downgrade a consumed confirmation, so a retained historical `result.state` can no longer overwrite a newer observation on later polls. New regression tests in `dashboard/test/lightIntent.test.ts` (+64 lines). Dashboard suite: 53 pass (run 2026-10-15). I read the diff; I did not independently re-create the reviewer's replay.
- **W2-R2 addressed (visual).** `.quota-label` is no longer hidden on compact landscape cards; duration and identity render (`quota-identity` truncates with a `title`, `quota-duration` stays). Viewed `dashboard/evidence/w2-fix1-740-nonstandard.png`: "Synthetic custom buc… 45 minutes", over-limit "120% used", "Reset due · awaiting update". Label truncation by ellipsis is acceptable; full label is in the title/expanded sheet.
- **W2-M1 addressed (visual).** `w2-fix1-360-notifications.png` shows "Synthetic app · 0s ago" on its own line above the title.
- Not covered: real WebView, live drag/focus behavior (W3), device.

Verdict (interim, Claude): R1, R2, M1 addressed; no new issues seen in the diff. Codex to confirm.
