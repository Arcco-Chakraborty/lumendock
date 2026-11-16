# C2 desktop Calendar independent review — 2026-10-22

Scope: fresh specification and quality review of C2, independently of the earlier Antigravity/Gemini approval. Canonical worktree: `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`, detached baseline `8e8ddcc`, existing dirty work preserved. This report evaluates the current implementation and approved requirements, not the earlier report's conclusions.

## Verdict

- **Specification compliant: NO.** Seven consequential findings remain against the approved C2 resource, freshness, error, and label contracts.
- **Code quality approved: NO; fixes and independent rereview required.**
- No live Google OAuth/account/label parity, actual phone behavior, or device acceptance is established by this review.

## Findings

### 1. [P1] Validate the combined retained-and-refreshed range before publishing

Location: `desktop/src/calendar/service.ts:797–838` (especially replacement at 803 and retention at 820).

The 10,000-occurrence/16 MiB staging checks count newly fetched rows only. Afterward this loop combines successful replacements with old rows from failed sources without checking the resulting range. Synthetic reproduction: initially A=5,000 and B=5,000 yields an available 10,000-row range; refresh A=10,000 while B returns 503 yields a **partial 15,000-row cache**. Repeating asymmetric failures can keep growing the retained total. Byte limits have the same hole, and `evictRangesIfNeeded` allows the sole pinned range to remain over the cache budget. This breaks explicit capacity bounds and preservation of the previous complete range on a capacity breach. Build a proposed merged range, include retained rows and associated cached label references in its accounting, and reject the proposal with capacity before mutating published cache.

### 2. [P2] Drain or cancel the old request batch before retrying after 401

Location: `desktop/src/calendar/api.ts:235–252` (`Promise.all` in `runWithConcurrency`) and `desktop/src/calendar/service.ts:530–546`.

`Promise.all` rejects as soon as one worker encounters 401; the other runner keeps fetching. `callWithTokenRefresh` immediately starts a new two-runner batch with the refreshed token while that original runner remains active and can continue to later sources. With three selected synthetic sources, one old-token source returning 401 and another held pending, the retry produced **three simultaneous event reads**, exceeding the promised maximum of two. The stale runner also shares the outer staging counter with the retry, so duplicate work can produce false capacity failures. Abort/drain every old runner, stop it taking more items, and allocate fresh staging for a retried attempt before launching another batch. Ensure disconnect/stop cancels every owned request controller.

### 3. [P2] Honor Retry-After before dispatching already queued work

Location: `desktop/src/calendar/service.ts:473–495`.

Backoff is checked when reads enqueue work, but not when the worker dequeues it. Manual refresh queues metadata plus a range; if metadata then returns 429 with `Retry-After: 600`, the worker immediately executes the queued event range during that backoff. Synthetic output: `eventsAfter429=1`, `backoffRemainingMs=600000`. Newest pending navigation can do the same after an event job sets backoff. Recheck the deadline at every dispatch, retain/coalesce pending work, and schedule resumption after the deadline without blocking a read handler.

### 4. [P2] Preserve retry guidance from per-calendar metadata failures

Location: `desktop/src/calendar/api.ts:408–413`.

The metadata catch rethrows only auth errors and discards the status/retry guidance on all other errors. A calendar metadata 429 with `Retry-After: 600` becomes `labelMetadataAvailable=false`; the service sees successful metadata collection, records **no backoff**, and starts event requests. A synthetic setup/apply yielded `backoffUntilMs=0` and two event reads despite that metadata 429. Keep source metadata degradation nonfatal to event display while propagating rate-limit/backoff and capacity information to the collector; do not treat a throttled metadata read as unconstrained success. This is separate from finding 3: enforcing dispatch backoff cannot help when the error's deadline was discarded.

### 5. [P2] Expose unsupported or unavailable named-label reads to the phone

Location: `desktop/src/calendar/service.ts:719–728` and `desktop/src/calendar/api.ts:408–420`.

The API returns `labelOptInFallback` and records `labelMetadataAvailable`, but neither signal is consumed by service/protocol/UI. If Google rejects `eventLabelVersion=1`, the fallback event data is published with `state=available`, `errorCode=null`, and source state `available`; unavailable metadata behaves identically. The user cannot distinguish an unlabeled event from label support being unavailable. This violates the approved visible supported-fallback requirement for “all events with labels.” Preserve the events and source badges, but surface a safe explicit label-support limitation using the agreed domain/UI contract; distinguish supported-empty label definitions from missing/rejected metadata. No authenticated parity claim should be added without account acceptance.

### 6. [P2] Keep periodic refresh alive when Agenda stops polling

Location: `desktop/src/calendar/service.ts:464–470` and `841–862`.

Periodic scheduling runs only from `read()`/`sources()`. Once a worker completes, its only interval is stopped, and `main.ts` supplies no Calendar scheduler. When Agenda is hidden or the phone disconnects there are no Calendar reads, so the advertised 15-minute idle event/metadata refresh never occurs; a new CLI connection is likewise not observed until the next Calendar request. In a synthetic connected-and-synced fixture, advancing the injected clock by sixteen minutes with no new Calendar request leaves `workerPromise=null`, `watchdogTimer=null`, and zero new network calls. Static control flow confirms there is no scheduler that could notice the elapsed time. Maintain a service-owned, stopped-on-shutdown scheduler for connection reconciliation and due jobs, respecting opt-out and backoff. Verify with fake timers rather than waiting real minutes.

### 7. [P2] Preserve metadata-unavailable state instead of reporting an empty successful agenda

Location: `desktop/src/calendar/service.ts:487–490`, `691–700`, and `1156–1160`.

On startup with an existing applied selection, a CalendarList 503 leaves metadata unloaded/error. The worker then skips metadata recovery because state is `error`, interprets an undiscovered source list as a deliberate empty selection, and marks the range available. The read path also overrides state to available whenever selected-readable length is zero and metadataLoaded is true, independently of discovery errors/staleness. The reproduced cold-start path returns **`state=available, errorCode=null, sourceCount=0, items=[]`** after the upstream 503. This tells the UI there are no events instead of showing unavailable/retry state. Only treat zero readable sources as a successful empty range after successful source discovery and a reviewed selection; carry metadata loading/error/capacity through range replies and retain prior data honestly where available.

## Evidence and limits

Read AGENTS/checkpoints, approved PRD, original system design desktop constraints, approved Calendar design and implementation plan, C2 task brief, snapshot-relative task diff, current OAuth/connection/API/service/CLI/main/server/private-file code, Calendar protocol contract, setup documentation, and focused Calendar tests. The previous clean C2 review is superseded by the findings above for the evaluated implementation.

Focused, synthetic-only reproductions ran via `/home/arcco-chakraborty/.local/share/phone-monitor/toolchains/node-v24.22.0-linux-x64/bin/node --input-type=module`, importing the existing desktop compiled modules. Fixtures used temporary `synthetic-c2-review-*` directories, recognizable synthetic client/tokens/source/events, injected HTTP responses, and injected time; each fixture stopped its service and removed its directory. Reproductions independently confirmed the 15,000-row retained merge, overlapping three upstream reads after 401 refresh, queued event work during a 600-second backoff, swallowed metadata retry guidance, invisible label fallback, missing idle scheduler, and false-success empty agenda after initial metadata failure. No tests or product source were modified. No real account data, credentials, Google requests, device actions, host actions, staging/commits, or HEAD/index mutations occurred. The coordinator owns fresh full-suite/build evidence.

Positive checks: requests use the three approved read-only scopes and fixed Google URLs; explicit connection and reviewed inclusion gate event import; connection mutations are locked/generation checked; late collection publication checks connection/selection generations; event/list upstream paging and source-specific event identities exist; all-day dates, self-declined invitations, normalized fields, whole-range nextEvent, authenticated fixed routes, and unchanged legacy snapshot shape are implemented. These strengths do not resolve the consequential findings or establish live Google/device acceptance.
