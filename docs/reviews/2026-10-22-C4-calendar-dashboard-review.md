# C4 fresh independent dashboard review

Date: 2026-10-22. Canonical worktree: `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`, detached baseline `8e8ddcc`, with pre-existing dirty 1.3.2 work preserved. This is the fresh Codex dashboard review requested after the Antigravity implementation/review; the earlier model substitution is explicitly disclosed in `docs/reviews/C4-calendar-dashboard-review.md` and does not constitute the required Codex review.

## Verdicts

- Specification compliant: **NO**. Source/revision invalidation, connection clearing, and truthful date presentation need corrections.
- Code quality approved: **NO**, pending the findings below and focused regression evidence.
- Device accepted / live Google labels verified: **NOT ASSESSED**. This review used only source, existing synthetic evidence, and synthetic in-process reproductions. It performs no phone deployment, authentication, Google request, or host action. The separate whole-feature Astra-high gate remains the coordinator's responsibility.

## Actionable findings

### C4-R1 — [P1] Reject an obsolete pagination response against the current accepted revision

Location: `dashboard/src/calendar/store.ts:256–260` (and assignment at `284–289`). `loadMore` compares its response only with the revision/selection captured when the request began. A normal poll can meanwhile accept a newer range or selection without changing `generation`. The old page consequently passes both checks, appends removed events into the new list, and replaces `page` and `selectionRevision` with the old values. This can resurrect a source removed by an already-confirmed selection on another client, or restore deleted occurrences after a completed refresh. Compare against the currently accepted generation/revision as well; invalidate pending page requests whenever a newer dataset or authenticated disabled/setup state is accepted. Restart page one without mixing generations.

Reproduced from the current bundled store: start at `synthetic_r1/synthetic_s1`, defer Load more, accept a poll at `synthetic_r2/synthetic_s2` with zero rows, then resolve the old second page. Output: `new poll cleared 0 synthetic_r2`; `late old page restored ['synthetic_late_page2'] synthetic_r1`.

### C4-R2 — [P2] Keep deselected rows suppressed while the selection transaction is pending

Location: `dashboard/src/calendar/store.ts:388–393`, `418–424`; polling at `453–480`. Selection bumps `generation` and filters the current rows but leaves polling running. A poll begun after that bump shares the new generation, and `requiredSelectionRevision` is installed only after the selection reply. If that reply is delayed, a normal old-selection read restores all removed rows and Next up while the UI still says Applying. Fence reads during selection, or retain the requested inclusion filter and reject the prior selection until the operation resolves. Selection failure should explicitly reconcile with the hub rather than silently republish an unintended intermediate state.

Reproduced with a deferred `hub.calendarSelect` and one synthetic 5-second timer advance: `deselect immediately 0`; `deselect while reply pending 1 selecting true`.

### C4-R3 — [P2] Clear enumerated source identities on authenticated disconnect/reconnect

Location: `dashboard/src/calendar/store.ts:577–585`; source preference at `135–140`. The disabled/setup branch clears event rows and `pageSources` but never clears `enumeratedSources`. Once Calendars has been opened, `snapshot.sources` always prefers this old enumeration, including after the hub returns `disabled` with `sources: []`. Old account calendar names remain available in the Calendars sheet, and reconnect setup can temporarily present old identities with a new selection revision. Clear the enumeration, selection/source state, and obsolete source requests on connection reset, and reload the inclusion list for the new connection before allowing Apply.

Reproduced: enumerate `Synthetic old calendar`, then accept an authenticated disabled page with no sources. Output: `disconnect sources retained ['Synthetic old calendar']`.

### C4-R4 — [P2] Close or invalidate an open detail sheet when its connection is cleared

Location: `dashboard/src/components/AgendaView.tsx:120–123`, `141–151`, `750–761`. The detail sheet retains an independent `selectedEvent`; it only resets on a user Close/Escape or dialog close. If the user leaves details open while the CLI disconnects/reconnects, the store's disabled/setup reply clears the rows but the modal continues showing the old event title, label and calendar over the cleared screen. Tie detail validity to the accepted connection/selection lifecycle and close/purge it on authenticated clearing or source removal. Preserve ordinary offline cached details when no authenticated clearing has occurred.

Evidence: direct state/effect inspection; this is independent of the store enumeration leak in C4-R3.

### C4-R5 — [P2] Display and rebase the actual requested range across tab remounts and midnight

Location: `dashboard/src/components/AgendaView.tsx:212–218`, `262` and range heading at `388`. `rangeShifted` is component-local and initializes false, while CalendarStore survives tab switching and holds a fixed initial date. The heading substitutes today's date whenever this flag is false. After browsing another week and returning from another tab, or after local midnight, the displayed range can differ from the actual query/cache. Today also refuses to reset the store unless the local flag is true. A desk display left open eventually filters Today against an expired seven-day range and cannot recover with Today alone. Derive the heading from the actual range; make Today compare/rebase the real store range, and establish explicit automatic rollover behavior for the default range.

Current AgendaView SSR with requested `2026-10-21` / seven days and server today `2026-10-22` produced heading `Oct 22 to Oct 28`; the actual requested interval ends October 27. Returning from a browsed-range tab has the same component-state mismatch by inspection.

### C4-R6 — [P2] Group an overlapping multi-day event at its first visible day

Location: `dashboard/src/components/AgendaView.tsx:269–273`. `eventDates` returns only first/last occupied dates. Selecting the first endpoint on or after the displayed start skips every interior day. An ongoing all-day event that began before the window is therefore grouped under its final day, making an event happening today appear as a later event in Upcoming. Clamp the first occupied date to the actual range start/current grouping boundary, or use the existing span utility with an explicit grouping policy; retain exclusive all-day ends.

Current AgendaView SSR for an all-day `2026-10-20` through `2026-10-24` exclusive, viewed on October 22, produced group `Tomorrow · Fri, Oct 23`. The event occupies October 22 and should be grouped at the first visible occupied day.

### C4-R7 — [P2] Keep source selection errors visible and do not close the sheet as success

Location: `dashboard/src/components/AgendaView.tsx:170–176`; `dashboard/src/calendar/store.ts:437–441`. `selectSources` catches failures and resolves normally, so `applySourceSelection` always closes the source sheet even for `CALENDAR_SELECTION_CHANGED`, timeout, or hub failure. Optimistic checkbox changes and filtered rows remain, and the normal available Agenda does not display these selection errors. The phone can therefore imply a preference was applied when the hub retained the previous selection; a subsequent poll restores excluded rows. Return an explicit success result or propagate the error, keep the sheet open with the failure, and reconcile the optimistic state/revision before retry.

Evidence: direct success/error control-flow inspection. Existing E2E only checks that an Apply operation was sent, not that failure remains actionable or that inclusion persisted.

## Coordinated cross-layer finding

The coordinator reports that the separate Astra review reproduced a native/UI clock contract defect: CalendarClient uses upstream last-success age for `LinkSnapshot.ageMs`, while `CalendarStore.recordTiming` (`store.ts:495–498`) adds that value to current `serverNowEpochMs` as though it were transport/cache receipt age. Consequently normal cached reads advance Next up into the future and can prematurely suppress an ongoing event. Fix and test the shared age semantics in the native/store integration, including normal two-minute upstream caching and USB loss. This report does not count it again as an independently reproduced C4 finding.

The coordinator also requires label availability to remain honest across the C2/C4 boundary. `AgendaView.tsx:99` unconditionally describes every readable source as `Readable · events and labels`, even though authenticated label support is not established and metadata/read failures may leave only source identity. Replace that unconditional claim with neutral readable-source wording and render the explicit partial/error state supplied by the corrected desktop collector when label reads fail. Coordinate this with the C2 label finding; do not infer verified label support from capability `read` or from a synthetic fixture.

## Scope and evidence

Read AGENTS, HANDOFF/STATUS/PROGRESS, approved PRD/calendar design and original system design, the binding C4 brief, C4 report and prior review; verified actual dirty status and baseline history. Inspected current store/time/AgendaView, App lifecycle/navigation, adapter argument validation, production/mock split, styles, synthetic bridge, unit and E2E tests. No product source, index, HEAD, existing evidence screenshot, or checkpoint was edited.

Focused reproductions used Node `v24.22.0`, installed esbuild with `write:false`, fake adapter replies and fake store timers; rendering used current AgendaView plus React server rendering. No real data or persistent capture was used. The first attempted ESM SSR probe failed because bundled Node dependencies required CommonJS; rerunning the same synthetic probe as an in-memory CommonJS bundle succeeded. Three store race/clearing probes and two date-presentation checks produced the outputs recorded above. `git diff --check dashboard/` passed. The coordinator owns broad suite/build reruns; no duplicated broad tests or new permanent test files were introduced by this review.

Existing synthetic screenshots were visually inspected at 800x360, 740x320 with 130% text, and 360x800 with 130% text, plus setup state. The layout uses readable text and distinct source/label badges, wraps controls without visible horizontal overflow, and permits vertical agenda scrolling. Existing Playwright checks cover the basic geometry/targets and simple detail focus restoration, but those checks and screenshots do not exercise the transaction races, authenticated clearing while details are open, range remount/midnight, multi-day overlap grouping, or failed Apply above. No fresh physical-screen acceptance claim follows.

Other checked behavior is directionally correct: whole-range `page.nextEvent` is used instead of deriving it from page one; date-only ends are exclusive; timed values use Intl zones; ended/all-day/self-declined summaries are rejected; source badges and event label chips remain distinct; only Agenda activates CalendarStore polling; old-hub unsupported state is separate; production bootstrap contains no automatic mock fallback. These do not remove the findings.

Coordinator next action: assign focused fixes, add delayed-reply and lifecycle regressions, obtain fresh scoped review, and checkpoint this outcome. Calendar software approval and device acceptance remain separate gates.
