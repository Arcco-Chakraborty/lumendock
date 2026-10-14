# Phone Monitor planning bundle

Date: 2026-10-14. These are proposed requirements and build instructions. Product implementation and device acceptance have not started.

Read in this order:

0. [Live handoff](../HANDOFF.md), [agent rules](../AGENTS.md), [machine-readable status](STATUS.json), and [progress ledger](PROGRESS.md): current checkpoint for any AI tool.
1. [Product requirements](PRD.md): intended dashboard, scope, privacy, compatibility, and acceptance criteria.
2. [System design](superpowers/specs/2026-10-14-phone-monitor-design.md): component boundaries, shared protocol, routing, lifecycle, and recovery.
3. [Main implementation plan](superpowers/plans/2026-10-14-phone-monitor.md): ordered milestones, agent routing, review gates, and final release conditions.
4. Component task plans: [desktop hub](superpowers/plans/2026-10-14-desktop-hub.md), [Android companion](superpowers/plans/2026-10-14-android-companion.md), [dashboard](superpowers/plans/2026-10-14-dashboard.md).
5. [Planning review](reviews/2026-10-14-planning-review.md): independent findings and their resolution before execution.

Execution uses subagents selected by difficulty, with Astra at high reasoning effort checking the requirements/plan and the finished project. An APK build and mock tests alone do not satisfy the real Redmi/ESP32 acceptance gate.

The coordinating agent maintains the handoff/status/ledger at each task and review boundary; these are working project records, not a one-time chat summary. Workers use scoped reports and one coordinating checkpoint writer. No watcher or recurring automation is required to read/resume this repository.
