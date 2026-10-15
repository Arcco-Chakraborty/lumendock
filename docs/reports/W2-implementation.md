# W2 — Usage, climate, lighting, notifications

Date: 2026-10-15. Status: implementation committed; **independent review pending (must not be Claude, who verified/committed but did not author the feature code)**. Owner of code: interrupted Codex Sol worker; verification and commit by Claude Code (claude-sonnet-5-5). Paths: `dashboard/**` only.

## Delivered
- `src/lib/time.ts` (laptop-time anchoring, reset countdown), `src/lib/lightIntent.ts` (bounded intent controller: one write in flight, <=4 unsent units, timer barriers, per-field merge, generation reconciliation, explicit-only retry, teardown without replay).
- Components: `UsageCard`, `ClimateCard` (incl. history, <=120 points, gaps), `LightCard` (power, nine modes, colour, brightness, speed, timer 0-720), `NotificationStrip` (plain text, expiry, local dismissal), `SettingsSheet`. `App.tsx`, `store.ts`, `styles.css`, synthetic scenarios in `src/mocks/scenarios.ts`.
- W1-R1 fixed: typed display result merges into latest AppStatus (store.test "merges typed display result into latest status ... (W1-R1)").

## Evidence (Node 24.22.0 user-local; commands run 2026-10-15 by Claude)
- `npm run typecheck` (all workspaces): passed.
- `npm test`: protocol 15, desktop 66, dashboard 50 passed (dashboard: 7 files).
- `npm run build -w dashboard`: passed; JS 325519 B + CSS 10021 B = 335540 B (W1 was 313542). Two upstream Zod PURE-comment warnings persist (W1-R2, unchanged).
- Source scan: no `dangerouslySetInnerHTML`, `innerHTML` or inline `style=` in `dashboard/src`.
- Screenshots (synthetic, produced by the original worker; Claude viewed 800 and 360 widths): `dashboard/evidence/w2-*.png`.

## Known limits / follow-ups
- Minor W2-M1: at 360px the notification strip renders "0s ago" directly against the title (no gap).
- Not run: real WebView, real bridge, device; Step 5 portrait/focus-drag checks rely on the worker's tests/screenshots and were not independently re-driven in a browser by Claude.
- W3 still owns integrated packaging/acceptance and warning triage.
