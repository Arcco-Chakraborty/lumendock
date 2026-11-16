import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarService } from '../src/calendar/service.js';
import { CalendarConnectionStore } from '../src/calendar/connection.js';
import { CALENDAR_SCOPES } from '../src/calendar/oauth.js';
import { toOpaqueSourceId } from '../src/calendar/api.js';

const range = { startDate: '2026-03-08', days: 7, timeZone: 'UTC' };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); vi.useRealTimers(); });
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });
const event = (id: string, labelLength = 0) => ({ id, summary: 'Synthetic event', start: { dateTime: '2026-03-08T15:00:00Z' }, end: { dateTime: '2026-03-08T16:00:00Z' }, ...(labelLength ? { eventLabelId: 'x'.repeat(labelLength) } : {}) });
async function fixture(names = ['a', 'b']) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-c2-fixes-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new CalendarConnectionStore(directory);
  const generation = await store.beginConnect();
  await store.finishConnect(generation, { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }, { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 9e12 });
  let now = Date.parse('2026-03-08T12:00:00Z');
  let override: ((url: URL, init?: RequestInit) => Promise<Response | undefined>) | undefined;
  const requests: string[] = [];
  const service = new CalendarService({ directory, nowMs: () => now, fetch: async (input, init) => {
    const url = new URL(String(input)); requests.push(url.toString());
    const replaced = await override?.(url, init); if (replaced) return replaced;
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'synthetic-refreshed', expires_in: 3600, scope: CALENDAR_SCOPES.join(' ') });
    if (url.pathname.endsWith('/calendarList')) return json({ items: names.map(id => ({ id, summary: `Synthetic ${id}`, accessRole: 'owner' })) });
    if (url.pathname.endsWith('/events')) return json({ items: [event('synthetic-event')] });
    return json({ labelProperties: { eventLabels: [] } });
  } });
  cleanups.push(() => service.stop());
  const setup = async () => { service.read(range); await service.flush(); const s = service.sources(); await service.select({ sourceIds: s.sources.map(s => s.sourceId), expectedRevision: s.selectionRevision }); await service.flush(); };
  return { service, store, directory, setup, requests, setOverride: (fn: typeof override) => { override = fn; }, advance: (ms: number) => { now += ms; } };
}

describe('C2 independent review regressions', () => {
  it.each([{ initial: 5000, fresh: 10000, labelLength: 0 }, { initial: 2500, fresh: 4500, labelLength: 2000 }])('preserves complete prior range when combined retained/fresh count or bytes exceeds capacity: %j', async ({ initial, fresh, labelLength }) => {
    const f = await fixture(); let refreshing = false;
    f.setOverride(async url => {
      if (!url.pathname.endsWith('/events')) return;
      const isB = url.pathname.includes('/b/');
      if (refreshing && isB) return json({}, 503);
      const total = refreshing ? fresh : initial;
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const end = Math.min(start + 200, total);
      return json({ items: Array.from({ length: end - start }, (_, i) => event(`synthetic-${start + i}`, labelLength)), ...(end < total ? { nextPageToken: String(end) } : {}) });
    });
    await f.setup();
    const old = f.service.read(range);
    expect(old.state).toBe('available');
    const oldSuccess = old.lastSuccessAtEpochMs;
    refreshing = true; f.advance(20_000); f.service.read({ ...range, refresh: true }); await f.service.flush();
    const page = f.service.read(range);
    expect(page.state).toBe('capacity'); expect(page.errorCode).toBe('CALENDAR_CAPACITY');
    expect(page.lastSuccessAtEpochMs).toBe(oldSuccess);
    let count = page.items.length; let cursor = page.nextCursor;
    while (cursor) { const next = f.service.read({ ...range, cursor }); count += next.items.length; cursor = next.nextCursor; }
    expect(count).toBe(initial * 2);
  });

  it('drains a rejected 401 batch before refreshed retry and resets attempt staging', async () => {
    const f = await fixture(['a', 'b', 'c']);
    let active = 0; let maxActive = 0; let refreshed = false; let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    f.setOverride(async (url, init) => {
      if (url.hostname === 'oauth2.googleapis.com') { refreshed = true; return; }
      if (!url.pathname.endsWith('/events')) return;
      active++; maxActive = Math.max(maxActive, active);
      try {
        const old = new Headers(init?.headers).get('authorization') === 'Bearer synthetic-access';
        if (old && url.pathname.includes('/a/')) return json({}, 401);
        if (old && url.pathname.includes('/b/')) await gate;
        return json({ items: Array.from({ length: 2000 }, (_, i) => event(`synthetic-${i}`)) });
      } finally { active--; }
    });
    f.service.read(range); await f.service.flush();
    const s = f.service.sources();
    await f.service.select({ sourceIds: s.sources.map(s => s.sourceId), expectedRevision: s.selectionRevision });
    await new Promise(resolve => setImmediate(resolve));
    const refreshedBeforeDrain = refreshed;
    release(); await f.service.flush();
    expect(refreshedBeforeDrain).toBe(false); expect(maxActive).toBeLessThanOrEqual(2);
    expect(f.service.read(range).state).toBe('available');
  });

  it.each(['calendarList', 'metadata'])('honors %s Retry-After at dispatch and resumes queued range after deadline', async mode => {
    const f = await fixture(['a']); await f.setup();
    let throttled = true; let events = 0;
    f.setOverride(async url => {
      if (url.pathname.endsWith('/events')) events++;
      if (throttled && (mode === 'calendarList' ? url.pathname.endsWith('/calendarList') : url.pathname.endsWith('/calendars/a'))) return json({}, 429, { 'retry-after': '600' });
    });
    f.advance(20_000); f.service.read({ ...range, refresh: true }); await f.service.flush();
    expect(events).toBe(0);
    const page = f.service.read(range);
    expect(page.state).toBe('partial'); expect(page.errorCode).toBe('CALENDAR_UNAVAILABLE'); expect(page.items).toHaveLength(1);
    f.advance(599_000); f.service.read(range); await f.service.flush(); expect(events).toBe(0);
    throttled = false; f.advance(2000); f.service.read(range); await f.service.flush(); expect(events).toBe(1);
    expect(f.service.read(range).state).toBe('available');
  });

  it.each(['fallback', 'metadataFailure', 'metadataMissing', 'empty'])('shows honest label state while preserving event and source badge: %s', async mode => {
    const f = await fixture(['a']);
    f.setOverride(async url => {
      if (mode === 'fallback' && url.pathname.endsWith('/events') && url.searchParams.has('eventLabelVersion')) return json({}, 400);
      if (url.pathname.endsWith('/calendars/a')) {
        if (mode === 'metadataFailure') return json({}, 404);
        if (mode === 'metadataMissing') return json({});
      }
    });
    await f.setup(); const page = f.service.read(range);
    expect(page.items).toHaveLength(1); expect(page.items[0]!.calendarName).toBe('Synthetic a');
    const expected = mode === 'empty' ? null : mode === 'metadataFailure' ? 'CALENDAR_UNAVAILABLE' : 'CALENDAR_UNSUPPORTED';
    expect(page.errorCode).toBe(expected); expect(page.state).toBe(expected ? 'partial' : 'available');
    expect(page.sources[0]!.state).toBe(expected ? 'partial' : 'available'); expect(page.sources[0]!.errorCode).toBe(expected);
    expect(f.service.sources().sources[0]!.errorCode).toBe(expected);
  });

  it('owns idle and connection reconciliation scheduling, and stops all work at shutdown', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const f = await fixture(['a']); await f.setup();
    const before = f.requests.length;
    f.advance(16 * 60_000); await vi.advanceTimersByTimeAsync(2000); await f.service.flush();
    expect(f.requests.length).toBeGreaterThan(before);
    await f.store.disconnect(); await vi.advanceTimersByTimeAsync(2000); await f.service.flush();
    const disconnectedCalls = f.requests.length;
    const gen = await f.store.beginConnect(); await f.store.finishConnect(gen, { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }, { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 9e12 });
    await vi.advanceTimersByTimeAsync(2000); await f.service.flush(); expect(f.requests.length).toBeGreaterThan(disconnectedCalls);
    const afterReconnect = f.requests.length; f.service.stop(); f.advance(16 * 60_000); await vi.advanceTimersByTimeAsync(4000); await f.service.flush();
    expect(f.requests.length).toBe(afterReconnect); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps failed cold source discovery unavailable instead of publishing successful empty agenda', async () => {
    const f = await fixture(['a']);
    const state = f.store.read(); await f.store.applySelection(state.generation, state.selectionRevision, [toOpaqueSourceId('a')]);
    f.setOverride(async url => url.pathname.endsWith('/calendarList') ? json({}, 503) : undefined);
    f.service.read(range); await f.service.flush(); const page = f.service.read(range);
    expect(page.state).toBe('error'); expect(page.errorCode).toBe('CALENDAR_UNAVAILABLE'); expect(page.lastSuccessAtEpochMs).toBeNull();
  });
});
