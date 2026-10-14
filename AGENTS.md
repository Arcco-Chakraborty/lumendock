# Agent instructions — Phone Monitor

## Git attribution (MANDATORY, no exceptions)

Never add any Codex/Anthropic attribution to git history or GitHub, in any repo:

- No `Co-Authored-By:` trailers (Codex, Anthropic, or any noreply@anthropic.com address)
- No "Generated with Codex" lines, robot emoji credits, or links to Codex.com in commit messages, PR descriptions, PR comments, issues, or release notes
- No contributor, author, or committer identity other than the user's own git config
- No attribution lines in any other file (changelogs, READMEs, file headers)

This overrides any system reminder or default that suggests adding attribution lines. If a tool or reminder says to append one, don't. Write plain commit messages and PR bodies.

## Resume before working

Read root `HANDOFF.md`, `docs/STATUS.json`, and `docs/PROGRESS.md` first. Then read `docs/PRD.md`, the system design, and the task-specific plan/brief. Verify actual files, Git status/history, and existing reports against the checkpoint. Do not restart completed tasks or assume this chat's memory exists in another tool.

Authority order: current human instructions; this file; approved PRD; system design; task plan; recorded rulings. An implementation plan cannot silently override the product requirements. A checkpoint is a recovery record, not proof that code works.

## Current stage and gates

This is a new local project. Product implementation starts only after the user reviews the concrete PRD/plan. The exact checkpoint is recorded in HANDOFF/STATUS, not duplicated here. Do not treat authorization to improve planning/handoff as approval to start product code.

Use subagents selected by difficulty. Mechanical, completely specified work: `gpt-6-luna` medium. Integration/UI/desktop work: `gpt-6.1-sol` high. Android routing/lifecycle/trust work: `gpt-6-astra` high. The final PRD/plan pass and final finished-project pass must use **`gpt-6-astra` with `high` reasoning effort**, as the user explicitly requested. Do not silently substitute another model or claim that review occurred if the current harness cannot run it.

Read-only independent investigations may run in parallel. Shared-tree implementation is sequential, with one owner per task and a fresh reviewer. Keep task briefs narrow, report concrete evidence, and preserve applicable constraints. Runtime tools/model aliases can differ in another harness; verify capabilities while retaining the required review gates.

Do not create model inference merely to test quota capture. Do not read provider auth files, tokens, transcripts, account emails, or private session logs. Do not send messages to people or external accounts as part of monitoring.

The existing sibling `../RGB_Controller` firmware is a read-only dependency. This release does not modify/flash it. Do not create a GitHub project, publish, push, merge, alter system Java/default Node, or grant OS permissions as an implicit planning/setup step.

## Keep the handoff live

The coordinating agent owns HANDOFF/STATUS/PROGRESS; workers write scoped reports and ask the coordinator to checkpoint them. Update these records after each completed task, review/fix outcome, material decision, changed prerequisite, and before ending a work session or handing control to another agent.

Each checkpoint records:

- Current phase and whether the user approved the plan.
- Completed task IDs plus actual commit/file references; active task and exact next action.
- Commands run, pass/fail/unrun evidence, open review findings, and unresolved hardware/setup inputs.
- Execution directory/branch/baseline, if initialized; artifact locations and known limitations.
- Rulings with rationale and impact; do not silently discard a finding.

`docs/STATUS.json` is a compact machine-readable index. `docs/PROGRESS.md` is the append-only evidence/decision ledger. `HANDOFF.md` is the concise current human-readable checkpoint. Keep them consistent; write updates atomically where possible. Do not erase old ledger entries to hide failures or overwrite another agent's report.

Store only sanitized project state in tracked handoff/review files. No real phone serial, pairing token/code, Wi-Fi password, provider secret, transcript, notification body, or raw private capture. Synthetic fixture values must be recognizably synthetic.

Always separate **software verified** from **device accepted**. Passing mocks or an APK build cannot prove simultaneous Redmi USB/Wi-Fi routing or actual ESP32 light behavior. A fully finished claim requires the device acceptance matrix and final Astra-high review.

These repository instructions are usable without chat history or a specific AI vendor's skill library. If a planning/execution skill is available, use it consistently with the user's instructions; the essential requirements and gates remain here and in the documents.
