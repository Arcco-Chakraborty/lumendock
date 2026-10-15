# Phone Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Redmi 9A desk dashboard receiving Claude Code/Codex subscription data and selected notifications over USB while independently controlling the ESP32 and showing climate over Wi-Fi.

**Architecture:** A private localhost Node hub collects desktop data; a Kotlin Android companion connects to it through ADB reverse and connects to the controller through a selected Wi-Fi Network. A bundled React dashboard uses only the companion's typed, origin-checked bridge. Provider credentials stay on the laptop; connection failures are independent.

**Tech Stack:** Node 24 LTS, npm workspaces, TypeScript, Fastify 5, React 19, Vite 7, Vitest/Playwright; Kotlin, JDK 17, AGP 9.4.0, Gradle 9.6.0, Android SDK 36/min SDK 29, AndroidX WebKit 1.17.1.

**Spec:** [System design](../specs/2026-10-14-phone-monitor-design.md), governed by [PRD](../../PRD.md). Read both before dispatch; component implementers receive their complete task brief plus applicable common constraints rather than the entire accumulated conversation.

## Global Constraints

- Product baseline: Redmi 9A on Android API 29 or later; current stable WebView with `WEB_MESSAGE_LISTENER`; Linux Ubuntu/GNOME laptop.
- Hub binds only `127.0.0.1:8765`; paired bearer auth; no remote bind option; no credentials in WebView, query strings, shell arguments, or logs.
- ESP address is `192.168.4.1`; existing HTTP endpoints only; no sibling firmware edits/flashing.
- ESP traffic binds individual connections to selected Wi-Fi; never call `bindProcessToNetwork`.
- Bundled UI origin is `https://appassets.androidplatform.net`; exact origin/main-frame bridge enforcement; no remote assets or data HTML.
- Claude five-minute report staleness; Codex 120-second full-read staleness; laptop six-second link staleness; ESP nine-second link staleness.
- Laptop snapshot poll 2 seconds; ESP state poll 3 seconds; history refresh 30 seconds while open; no overlapping requests of the same operation.
- Pairing: eight digits, 120-second expiry, five failed attempts, one-use; normal startup leaves it closed.
- Light intents: explicit power values, brightness/speed 1–100, mode 0–8, timer 0–720 minutes; 150-ms coalescing; ≤4 dispatched writes/second; no automatic timer replay.
- Notification default deny; max 100 records, 30-minute TTL, no disk persistence; unavailable capture never disables other sources.
- Source timestamps use epoch milliseconds; quota reset fields use epoch seconds; display clock advances monotonically from laptop samples.
- Files with secrets are private; configuration install/uninstall preserves unrelated edits; use only the user's existing Git identity and no attribution lines.
- Distinguish software-verified from device-accepted; final project and PRD review uses `gpt-6-astra` at `high`.
- Keep root HANDOFF.md, AGENTS.md, docs/STATUS.json, and docs/PROGRESS.md portable and current after every task/review/decision checkpoint; never record secrets or private captures there.

## Review Focus

1. A no-internet Wi-Fi network must not swallow USB loopback traffic: A3's routing seam tests and real dual-link check.
2. Identical Claude timer reports and expired quotas must not invent fresh/reset data: D2 response-signature tests and W2 clock/render tests.
3. Cross-field intent merging, timer barriers, and native post-dispatch reconciliation must not lose an action, replay a timer, or overwrite newer intent: A3/W2 tests, including generation floors after renderer recreation.
4. Existing settings and unallowlisted/private data must survive setup without being leaked or overwritten: D2/D3 installer/capture tests and A1 bridge tests.
5. WebView/permission/process teardown, human-length native setup, and USB reauthorization must not leak jobs or deadlock the dashboard: A1/A2/A3 setup/lifecycle tests and W3 acceptance. W2 clock tests also cover repeated cached returns through a 30-minute outage.

## File Structure

The design's repository tree is authoritative. The component plans below list exact files owned by each task. `packages/protocol` is created by D1 and reviewed before its consumers start. Contract changes require a controller decision recorded in the ledger, fixture updates, and affected consumer tests.

Root build outputs go to ignored `artifacts/`; packaged Android assets are generated from the dashboard build rather than hand-edited copies. Tracked release evidence goes to `docs/DEVICE_ACCEPTANCE.md` and sanitized review records. Do not commit binaries, account/config files, keystores, package caches, or raw device/account captures.

## Execution Order

| Order | Task / detailed brief | Depends on | Independently reviewable deliverable |
|---|---|---|---|
| 0 | Reviewed document baseline and isolated execution workspace | User plan review | Git identity verified, new feature branch/worktree, baseline SHA and ledger |
| 1 | [D1: Protocol, pairing, cached hub](2026-10-14-desktop-hub.md#task-1-shared-contract-and-authenticated-hub) | 0 | Authenticated local fixture API and shared schemas |
| 2 | [D2: Claude/Codex collectors](2026-10-14-desktop-hub.md#task-2-claude-and-codex-collectors) | D1 | Real supported collectors with reversible settings setup |
| 3 | [D3: Notifications and operation](2026-10-14-desktop-hub.md#task-3-notification-capture-and-desktop-operation) | D1, D2 | Allowlisted stream, USB launcher, user-service installer |
| 4 | [A1: Trusted WebView and bridge](2026-10-14-android-companion.md#task-1-packaged-webview-and-restricted-bridge) | D1 | Buildable diagnostic APK, private asset origin, blocked unsafe messages |
| 5 | [A2: USB client and pairing](2026-10-14-android-companion.md#task-2-usb-hub-client-and-reconnection) | A1, D1; D3 for USB setup integration | Native paired loopback hub access and independent reconnect |
| 6 | [A3: Wi-Fi controller integration](2026-10-14-android-companion.md#task-3-explicit-wi-fi-esp32-access-and-controls) | A1, A2 | Native per-network ESP state/history/serialized intents |
| 7 | Hardware routing checkpoint | A2, A3 | Redmi reaches hub and controller simultaneously; no firmware change |
| 8 | [W1: Dashboard shell/adapter](2026-10-14-dashboard.md#task-1-dashboard-shell-and-device-adapter) | D1, A1 contract | Lightweight UI shell with labelled fixture mode |
| 9 | [W2: Functional cards](2026-10-14-dashboard.md#task-2-usage-climate-light-controls-and-notifications) | W1, A3 intent contract | Complete product UI; unknown/stale/pending/error states |
| 10 | [W3: Packaging and acceptance](2026-10-14-dashboard.md#task-3-packaging-accessibility-and-integrated-acceptance) | D3, A3, W2 | APK/package, setup docs, automated evidence and physical acceptance |
| 11 | Final whole-project Astra-high review and scoped fix/re-review | W3 | Final tree checked against PRD and evidence; blocking findings resolved |

User execution update (2026-10-15): run desktop, Android and dashboard tracks in parallel after D1 freezes the shared contract. Keep ownership disjoint, serialize shared root edits and commits, and review exact per-task checkpoint ranges. Desktop follows D1→D2→D3; native follows A1→A2→A3; UI follows W1→W2. A2 can implement/test the D1 HTTP contract before D3 USB launcher integration; W2 can consume the D1/A3 intent contract before A3 runtime completion. W3 waits for completed D3/A3/W2 and joins the tracks. Read-only research/reviews may run concurrently. If hardware is unavailable at checkpoint 7, record A02/A05–A07/A12/A15 as unrun and continue the browser/mock-verifiable UI work. Defer claims of hardware compatibility and the release gate; do not block independent software work or silently mark the checkpoint passed.

### Step 0: Concrete execution setup

- [x] Read approved PRD/design/plans and this workspace's instructions; do not create an external project.
- [x] Check `git config --get user.name` and `git config --get user.email` without changing them. If missing, do not invent an identity; product work can proceed without commits until the user supplies it.
- [x] Initialize this fresh folder only with `git init -b feat/phone-monitor`; preserve all planning files. Write `.gitignore` for tool/build caches and secrets before adding files.
- [x] Commit the reviewed documents using the configured identity and a plain message such as `docs: define phone dashboard requirements and build plan`.
- [x] Apply `superpowers:using-git-worktrees`: inspect this chat's existing worktree artifacts, reuse a suitable one or create a managed worktree from the new feature branch. Use its returned path for all implementation. No remote/default branch exists yet; supply a valid local ref explicitly.
- [x] Record baseline SHA, execution root, plan paths, completed tasks, rulings, and check results in the main progress ledger. Each component plan also uses its own SDD brief/report/review workspace.
- [x] Read root HANDOFF.md/AGENTS.md and docs/STATUS.json/PROGRESS.md; preserve them and update executionRoot/branch/baseline and plan approval after verifying actual state. No agent may infer approval from a handoff request.
- [x] Read D1/A1 bootstrap requirements before provisioning Node/JDK/SDK into user-owned paths. A missing toolchain is a setup task, not evidence that the product architecture failed.

## Agent Assignments

| Task | Implementer | Reviewer | Escalation |
|---|---|---|---|
| D1 | Sol high | Sol high | Astra high for auth/contract ambiguity |
| D2 | Sol high | Astra high for shell/settings/auth boundary | Fresh Astra high if unresolved |
| D3 | Sol high | Sol high | Astra high for privilege/privacy ambiguity |
| A1 | Astra high | Astra high | Fresh independent Astra high review |
| A2 | Astra high | Sol high; Astra for pairing trust findings | Astra high |
| A3 | Astra high | Astra high | Fresh independent Astra high review |
| W1 | Sol high | Sol high | Astra high if bridge contract changes |
| W2 | Sol high | Sol high | Astra high for intent/freshness ambiguity |
| W3 | Sol high | Sol high | Astra high for cross-component defects |
| Complete-code mechanical fixes/fixture metadata | Luna medium | Sol medium | Sol high if judgment is required |
| PRD + plan final pass | **Astra high** | Independent review | Resolve findings before user handoff |
| Finished project final pass | **Astra high** | Whole tree + PRD + evidence | One complete fix wave and scoped re-review |

Exact model IDs: Luna=`gpt-6-luna`, Sol=`gpt-6.1-sol`, Astra=`gpt-6-astra`. Spawn with explicit `model`, `reasoning_effort`, and `fork_turns:"none"`; provide narrow briefs. Do not let implementers spawn their own reviewers or unbounded helper trees.

Task loop: extract brief → fresh implementer → meaningful task checks → self-review/report → fresh spec-and-quality reviewer → scoped fixes → reviewed commit → ledger update. Do not pause for approval between already-approved tasks. Repeated unresolved findings escalate per the subagent-driven-development skill. Independent hardware/setup input can be requested while other authorized work continues.

### Live, portable handoff

The coordinator updates HANDOFF.md (concise current state), docs/STATUS.json (machine-readable gates/task index), and docs/PROGRESS.md (append-only evidence/rulings) after every task, review/fix outcome, material prerequisite change, and before yielding/handoff. Workers report their actual files/commits/commands/results; one coordinating writer checkpoints them to avoid shared-file races. AGENTS.md carries the user's constraints and this maintenance rule for other AI tools, without relying on chat memory.

Every checkpoint includes exact next action, task states, actual execution directory/branch/baseline, open findings, evidence paths, artifact locations, and whether plan review/software verification/device acceptance/final Astra review happened. Keep secrets/phone serial/account captures out. A resuming agent validates files/Git/reports, starts at the first incomplete task, and does not repeat completed research or claim unavailable evidence.

## Integration and Final Review

- [ ] Run schema/provider/config/ADB tests; React tests and layout checks; Android JVM/lint/APK build; then instrumented tests on an attached authorized Redmi.
- [ ] Compare actual quotas without generating an inference call solely for testing; verify both physical connection paths and light controls.
- [ ] Complete all PRD acceptance rows with a dated outcome, commands/evidence, or explicit unrun reason; never replace physical checks with mocks.
- [ ] Produce APK, desktop package, checksums, screenshots, build-size/performance measurements, and setup/uninstall documents.
- [ ] Generate the complete review package from the baseline SHA to final HEAD, plus untracked file manifest if any; include PRD, architecture, all plans, ledger, per-task check evidence, and device report.
- [ ] Reconcile HANDOFF/STATUS/PROGRESS with the actual tree/artifacts and completion gates; include their consistency in final review. Leave a precise resumable checkpoint even when physical checks remain unrun.
- [ ] Dispatch a fresh `gpt-6-astra` agent at `high` to compare the entire product with the PRD, including recovery, security, visual usability, and evidence gaps.
- [ ] Send the complete actionable finding list to one appropriate fix agent; re-run covering checks; request a scoped Astra-high re-review of the amended range. Record residual limitations transparently.
- [ ] Deliver only when mandatory software checks pass and no unresolved blocking finding remains. “Fully finished” additionally requires the physical acceptance gate. Do not push, publish, merge, flash firmware, or create a GitHub project without a separate request.

No elapsed-time estimate substitutes for these gates. The highest-risk work is real Redmi routing/lifecycle and provider configuration preservation, so it occurs before polishing the display.
