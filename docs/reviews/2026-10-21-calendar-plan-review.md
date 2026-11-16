# Calendar implementation plan review

Date: 2026-10-21, Asia/Kolkata. Reviewed `docs/superpowers/plans/2026-10-21-calendar-agenda.md` against the user-approved agenda design and current source at dirty baseline `8e8ddcc`.

Required fresh independent reviewer: `gpt-6-astra`, `high`, task `calendar_plan_review`. Initial verdict **needs_fixes**; after amendments, scoped rereview **approved_for_execution**, no residual plan blockers. This is plan approval, not product/device verification.

1. P1 cross-process connection changes: specified atomically persisted connection generations, prompt hub reload/invalidation, guarded refresh persistence and disconnect/reconnect races. No network calls while holding the file lock.
2. P2 manual refresh: added typed optional refresh flag, incompatible with cursors, coalesced fifteen-second minimum spacing/backoff, event plus label metadata refresh and covering tests.
3. P2 next event beyond page one: defined deterministic whole-range ordering and server-computed `nextEvent`, carried on every page; tests include more than fifty preceding all-day/declined rows.
4. P2 inclusion review before event sync: added `setup_required`, metadata/source enumeration only after browser connection, explicit phone inclusion Apply before event requests, with future-source opt-in.

Additional self-review clarification assigned `dashboard/src/device.ts` argument typing to C4. Calendar Google grant errors remain distinct from validated hub bearer rejection; only the latter may affect native pairing. C1 freezes and independently reviews the wire contract before parallel desktop/Android/dashboard implementation. Real account, named-label API behavior and hardware acceptance remain unverified.
