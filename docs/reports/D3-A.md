# D3-A report: notification capture, allowlist persistence, notifications CLI

Status: software verified with fakes only. Real GNOME/busctl capture is NOT verified. No git writes made.

## Files
- New `desktop/src/collectors/notifications.ts` (`NotificationCollector`, `matchExpression`, `plainText`).
- New `desktop/src/notifications-cli.ts` (`runNotificationsCommand(argv, configDir, out) -> exit code`).
- Edited (additive) `desktop/src/config.ts`: `isValidNotificationLabel`, `MAX_NOTIFICATION_APPS`, `listNotificationApps` (sync), `allowNotificationApp`/`removeNotificationApp` (async).
- Edited (additive, outside the stated list; needed) `desktop/src/store.ts`: `setNotificationAllowlist(labels)`. The store's allowlist was constructor-only, so a settings change could not otherwise take effect.
- Tests: `desktop/test/notifications.test.ts` (31), `desktop/test/notification-config.test.ts` (21), fixture `desktop/test/fixtures/busctl-notify-synthetic.json` (synthetic, hand-written; not a real capture).

## Commands (PATH = repo node 24.22.0)
- `npm run test --workspace @phone-monitor/desktop`: 11 files, 155 tests, all pass (66 pre-existing still pass; D3-B's adb/service tests included).
- `npm run typecheck --workspace @phone-monitor/desktop`: 0 errors. `npm run build ...`: success.
- Tests were written first (failed on missing module), then implemented. Mutation spot checks (dropping label gate, stale-child guard, dedupe, signature check, oversize discard) each made a test fail.

## Wiring notes for main.ts (coordinator)
- `const c = new NotificationCollector({store, clock:{nowMs}})`; `await c.start(listNotificationApps(configDir))`; `await c.stop()` on shutdown. `start()` is idempotent reconcile: call again with a new list to apply a settings change without touching other collectors (unchanged labels keep their child). Never throws.
- Config lives in `<configDir>/config.json`, key `notificationAllowlist`, mode 0600, other keys preserved, lock `config.lock`. The hub does not watch the file; main.ts must re-read it (e.g. on SIGHUP or a poll) to apply CLI changes live. CLI messages do not claim a restart is needed or not.
- `listNotificationApps` throws `BAD_CONFIG` for an unreadable config; catch it in main.ts and treat as empty.

## Design decisions
- Labels: `^[A-Za-z0-9 _.:-]{1,80}$`, no leading/trailing space (rejects `'`, `"`, `\`, `,`, control, non-ASCII). Validation precedes match-string construction in both collector and config. Invalid labels are dropped (fail closed, no throw); max 10 valid labels kept in order.
- One `busctl --user --json=short --no-pager --match=<expr> monitor` per label, `shell:false`, `stdio:['ignore','pipe','pipe']`.
- Event gate order: JSON line (cap 256 KiB, oversized line discarded to its newline) -> Notify method_call + signature `susssasa{sv}i` + 8 typed fields -> `arg0 === the monitor's own label` -> only then sanitize. Non-allowlisted fields are never copied, stored, or logged. Collector has no logging at all.
- Text: simple markup tags (b/i/u/a/img) removed, 5 XML entities decoded once, control/bidi chars flattened, lone surrogates replaced, truncated to 100/280 code points.
- Dedupe: sha256 of label+title+body, 2000 ms window from the last accepted event, map capped at 500. Local IDs `n<time36>-<seq>`.
- Ring (<=100) and TTL (1,800,000 ms on read) are enforced by the existing `HubStore` (`addNotification`/`snapshot`); the collector adds no second buffer.
- Capability: `available` once any monitor survives 1000 ms or emits a decodable line; otherwise `unavailable` with `NOTIFICATION_MONITOR_DENIED` (stderr matched /denied|permission|policy.../, text then dropped) or `NOTIFICATION_MONITOR_UNAVAILABLE` (missing busctl, spawn throw, other exit). The DENIED refinement can lag a missed-exit stderr by <=20 ms.
- Lifecycle: start/stop go through a serial promise queue; each monitor object has a `closed` flag and handlers verify `m.child === child`, so stale children cannot store events, schedule restarts, or flip capability. Removal/stop: SIGTERM, SIGKILL after 2 s, give up 1 s later; all timers cleared (tests assert `vi.getTimerCount() === 0`). Restart backoff 1,2,4..60 s, reset after a 30 s stable run.
- Stopping/emptying the allowlist calls `store.setNotificationAllowlist`, which drops retained events of removed apps.

## Known gaps / NOT verified
- Real GNOME `busctl monitor` output and real BecomeMonitor denial text were not observed (busctl was deliberately not run against the real bus). The JSON field names follow systemd's documented `--json` message format; confirm with the opt-in `notify-send` synthetic test in setup, then replace/augment the fixture.
- No wall-clock/real-process test of the default `spawn` runner; only fake children.
- Label match is exact against Notify `arg0`; apps whose label differs per message will not match.
- Notification actions/replace IDs are intentionally ignored (per spec).
- `HubStore` byte-budget trimming and ring/TTL logic are D1 code; only exercised here via the collector.
