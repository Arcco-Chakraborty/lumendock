import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CalendarPageSchema, CalendarSourcesPageSchema } from '@phone-monitor/protocol';
import { CalendarConnectionStore } from '../src/calendar/connection.js';
import { CALENDAR_SCOPES } from '../src/calendar/oauth.js';
import { toOpaqueSourceId } from '../src/calendar/api.js';
import { CalendarService } from '../src/calendar/service.js';

const dirs: string[] = [];
const services: CalendarService[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-cal-svc-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const svc of services.splice(0)) svc.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const defaultRange = { startDate: '2026-03-08', days: 7, timeZone: 'America/New_York' };

async function connectStore(dir: string) {
  const store = new CalendarConnectionStore(dir);
  const gen = await store.beginConnect();
  await store.finishConnect(
    gen,
    { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
    { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 9_000_000_000_000 },
  );
  return { store, gen };
}

describe('CalendarService collection, caching, pagination, and lifecycle', () => {
  it('starts opt-out with zero network calls and transitions to setup_required upon connect without fetching events', async () => {
    const dir = makeTempDir();
    let now = 1_772_950_000_000;
    const requestedUrls: string[] = [];

    const service = new CalendarService({
      directory: dir,
      nowMs: () => now,
      fetch: async (input) => {
        const url = new URL(String(input));
        requestedUrls.push(url.pathname);
        if (url.pathname.endsWith('/users/me/calendarList')) {
          return new Response(
            JSON.stringify({
              items: [
                { id: 'work@example.com', summary: 'Work', backgroundColor: '#22D3EE', accessRole: 'owner' },
                { id: 'room@example.com', summary: 'Room', accessRole: 'freeBusyReader' },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.pathname.includes('/calendars/work%40example.com')) {
          return new Response(
            JSON.stringify({
              id: 'work@example.com',
              summary: 'Work',
              labelProperties: { eventLabels: [{ id: 'l1', name: 'Urgent', color: '#FF0055' }] },
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    services.push(service);

    // Disconnected
    const disabledPage = service.read(defaultRange);
    expect(CalendarPageSchema.parse(disabledPage).state).toBe('disabled');
    expect(CalendarSourcesPageSchema.parse(service.sources({})).state).toBe('disabled');
    expect(requestedUrls).toEqual([]);

    // Connect from another store instance (cross-process simulation)
    await connectStore(dir);

    const setupPage = service.read(defaultRange);
    expect(setupPage.state).toBe('setup_required');
    await service.flush();

    // Only calendarList and calendar metadata were fetched; zero /events calls before Apply!
    expect(requestedUrls.some((u) => u.endsWith('/events'))).toBe(false);

    const sourcesPage = service.sources({});
    expect(CalendarSourcesPageSchema.parse(sourcesPage).state).toBe('setup_required');
    expect(sourcesPage.sources).toHaveLength(2);
    const workSource = sourcesPage.sources.find((s) => s.name === 'Work')!;
    const roomSource = sourcesPage.sources.find((s) => s.name === 'Room')!;
    expect(workSource.selected).toBe(true);
    expect(workSource.capability).toBe('read');
    expect(roomSource.selected).toBe(false);
    expect(roomSource.capability).toBe('busy');
  });

  it('computes range-global sort and nextEvent across >50 earlier/all-day/declined rows and prioritizes ongoing over future', async () => {
    const dir = makeTempDir();
    await connectStore(dir);
    let now = Date.parse('2026-03-08T14:30:00Z');

    const service = new CalendarService({
      directory: dir,
      nowMs: () => now,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/users/me/calendarList')) {
          return new Response(
            JSON.stringify({
              items: [
                { id: 'cal-a@example.com', summary: 'Alpha', backgroundColor: '#22D3EE', accessRole: 'owner' },
                { id: 'cal-b@example.com', summary: 'Beta', backgroundColor: '#33B679', accessRole: 'owner' },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.pathname.endsWith('/events') && url.pathname.includes('cal-a%40example.com')) {
          // 55 past/all-day/declined events before the eligible timed events
          const items: any[] = [
            {
              id: 'allday_1',
              status: 'confirmed',
              summary: 'All Day Banner',
              start: { date: '2026-03-08' },
              end: { date: '2026-03-09' },
            },
          ];
          for (let i = 0; i < 52; i++) {
            const startMs = Date.parse('2026-03-08T06:00:00Z') + i * 60_000;
            items.push({
              id: `past_${i.toString().padStart(3, '0')}`,
              status: 'confirmed',
              summary: `Past ${i}`,
              start: { dateTime: new Date(startMs).toISOString(), timeZone: 'America/New_York' },
              end: { dateTime: new Date(startMs + 30_000).toISOString(), timeZone: 'America/New_York' },
            });
          }
          // Confirmed event at 14:40Z where self declined -> must NOT be nextEvent!
          items.push({
            id: 'declined_future',
            status: 'confirmed',
            summary: 'Declined Sync',
            start: { dateTime: '2026-03-08T14:40:00Z', timeZone: 'America/New_York' },
            end: { dateTime: '2026-03-08T15:00:00Z', timeZone: 'America/New_York' },
            attendees: [{ self: true, responseStatus: 'declined' }],
          });
          // Future eligible event at 15:00Z
          items.push({
            id: 'future_eligible',
            status: 'confirmed',
            summary: 'Future Review',
            start: { dateTime: '2026-03-08T15:00:00Z', timeZone: 'America/New_York' },
            end: { dateTime: '2026-03-08T15:30:00Z', timeZone: 'America/New_York' },
          });
          return new Response(JSON.stringify({ items }), { status: 200 });
        }
        if (url.pathname.endsWith('/events') && url.pathname.includes('cal-b%40example.com')) {
          return new Response(
            JSON.stringify({
              items: [
                // Ongoing event (started at 14:15Z, ends at 14:45Z; now is 14:30Z)
                {
                  id: 'ongoing_now',
                  status: 'confirmed',
                  summary: 'Ongoing Standup',
                  start: { dateTime: '2026-03-08T14:15:00Z', timeZone: 'America/New_York' },
                  end: { dateTime: '2026-03-08T14:45:00Z', timeZone: 'America/New_York' },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ id: 'meta', labelProperties: { eventLabels: [] } }), { status: 200 });
      },
    });
    services.push(service);

    service.read(defaultRange);
    await service.flush();

    const sources = service.sources({});
    const selectedIds = sources.sources.map((s) => s.sourceId);
    await service.select({ sourceIds: selectedIds, expectedRevision: sources.selectionRevision });
    await service.flush();

    const page1 = service.read(defaultRange);
    expect(CalendarPageSchema.parse(page1).state).toBe('available');
    expect(page1.items).toHaveLength(50);
    expect(page1.nextCursor).not.toBeNull();
    // All-day event at midnight America/New_York (05:00Z) sorts before 06:00Z timed events
    expect(page1.items[0]!.title).toBe('All Day Banner');
    // Ongoing event is selected as nextEvent across the whole range even though >50 events exist
    expect(page1.nextEvent?.title).toBe('Ongoing Standup');

    const page2 = service.read({ ...defaultRange, cursor: page1.nextCursor! });
    expect(CalendarPageSchema.parse(page2).state).toBe('available');
    expect(page2.items).toHaveLength(6);
    expect(page2.nextCursor).toBeNull();
    // Page 2 repeats the same range-global nextEvent summary
    expect(page2.nextEvent?.title).toBe('Ongoing Standup');
    // Declined event is still in the agenda list with selfResponseStatus: 'declined'
    expect(page2.items.find((e) => e.title === 'Declined Sync')?.selfResponseStatus).toBe('declined');

    // Advance clock past ongoing event end (14:50Z) -> nextEvent advances to 'Future Review', skipping 'Declined Sync'
    now = Date.parse('2026-03-08T14:50:00Z');
    const afterOngoing = service.read(defaultRange);
    expect(CalendarPageSchema.parse(afterOngoing).nextEvent?.title).toBe('Future Review');

    // Cursor expires after 10 minutes
    now += 10 * 60 * 1000 + 1;
    const expiredPage = service.read({ ...defaultRange, cursor: page1.nextCursor! });
    expect(expiredPage.errorCode).toBe('CALENDAR_CURSOR_EXPIRED');
  });

  it('retains previous complete source data on partial failure, refreshes label metadata independently, and defaults new sources off', async () => {
    const dir = makeTempDir();
    await connectStore(dir);
    let now = 1_772_950_000_000;
    let labelName = 'Initial Label';
    let includeNewCalendar = false;
    let failCalB = false;

    const service = new CalendarService({
      directory: dir,
      nowMs: () => now,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/users/me/calendarList')) {
          const items: any[] = [
            { id: 'a@example.com', summary: 'Cal A', backgroundColor: '#22D3EE', accessRole: 'owner' },
            { id: 'b@example.com', summary: 'Cal B', backgroundColor: '#33B679', accessRole: 'owner' },
          ];
          if (includeNewCalendar) {
            items.push({ id: 'new@example.com', summary: 'Newly Added', backgroundColor: '#FFAA00', accessRole: 'owner' });
          }
          return new Response(JSON.stringify({ items }), { status: 200 });
        }
        if (url.pathname.includes('/calendars/a%40example.com') && !url.pathname.endsWith('/events')) {
          return new Response(
            JSON.stringify({
              id: 'a@example.com',
              labelProperties: { eventLabels: [{ id: 'lbl1', name: labelName, color: '#0088FF' }] },
            }),
            { status: 200 },
          );
        }
        if (url.pathname.endsWith('/events') && url.pathname.includes('a%40example.com')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 'ev_a',
                  status: 'confirmed',
                  summary: 'Event A',
                  eventLabelId: 'lbl1',
                  start: { dateTime: '2026-03-08T15:00:00Z', timeZone: 'UTC' },
                  end: { dateTime: '2026-03-08T16:00:00Z', timeZone: 'UTC' },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.pathname.endsWith('/events') && url.pathname.includes('b%40example.com')) {
          if (failCalB) {
            return new Response(JSON.stringify({ error: 'upstream 503' }), {
              status: 503,
              headers: { 'retry-after': '30' },
            });
          }
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 'ev_b',
                  status: 'confirmed',
                  summary: 'Event B',
                  start: { dateTime: '2026-03-08T17:00:00Z', timeZone: 'UTC' },
                  end: { dateTime: '2026-03-08T18:00:00Z', timeZone: 'UTC' },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ id: 'meta', labelProperties: { eventLabels: [] } }), { status: 200 });
      },
    });
    services.push(service);

    service.sources({});
    await service.flush();
    const initialSources = service.sources({});
    await service.select({
      sourceIds: initialSources.sources.map((s) => s.sourceId),
      expectedRevision: initialSources.selectionRevision,
    });
    service.read(defaultRange);
    await service.flush();

    const fullPage = service.read(defaultRange);
    expect(fullPage.state).toBe('available');
    expect(fullPage.items.map((e) => e.title)).toEqual(['Event A', 'Event B']);
    expect(fullPage.items[0]!.label?.name).toBe('Initial Label');

    // Now rename label, add a new calendar upstream, and make Cal B fail on manual refresh (after 15s coalesce spacing)
    now += 20_000;
    labelName = 'Updated Label';
    includeNewCalendar = true;
    failCalB = true;

    service.read({ ...defaultRange, refresh: true });
    await service.flush();

    const partialPage = service.read(defaultRange);
    expect(CalendarPageSchema.parse(partialPage).state).toBe('partial');
    expect(partialPage.errorCode).toBe('CALENDAR_UNAVAILABLE');
    expect(partialPage.failedSourceCount).toBe(1);
    // Cal B's previous complete event is retained, and Cal A's label updated!
    expect(partialPage.items.map((e) => e.title)).toEqual(['Event A', 'Event B']);
    expect(partialPage.items[0]!.label?.name).toBe('Updated Label');

    // Newly discovered calendar after initial selection defaults to selected: false
    const updatedSources = service.sources({});
    const newCal = updatedSources.sources.find((s) => s.name === 'Newly Added')!;
    expect(newCal.selected).toBe(false);
  });

  it('discards in-flight sync data and clears removed rows when deselected or disconnected mid-sync', async () => {
    const dir = makeTempDir();
    const { store } = await connectStore(dir);
    let now = 1_772_950_000_000;

    let releaseCalB!: () => void;
    const calBGate = new Promise<void>((resolve) => {
      releaseCalB = resolve;
    });
    let pauseCalB = false;

    const service = new CalendarService({
      directory: dir,
      nowMs: () => now,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/users/me/calendarList')) {
          return new Response(
            JSON.stringify({
              items: [
                { id: 'keep@example.com', summary: 'Keep', accessRole: 'owner' },
                { id: 'drop@example.com', summary: 'Drop', accessRole: 'owner' },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.pathname.endsWith('/events') && url.pathname.includes('keep%40example.com')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 'ev_keep',
                  status: 'confirmed',
                  summary: 'Kept Event',
                  start: { dateTime: '2026-03-08T15:00:00Z', timeZone: 'UTC' },
                  end: { dateTime: '2026-03-08T16:00:00Z', timeZone: 'UTC' },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.pathname.endsWith('/events') && url.pathname.includes('drop%40example.com')) {
          if (pauseCalB) await calBGate;
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 'ev_drop',
                  status: 'confirmed',
                  summary: 'Dropped Event',
                  start: { dateTime: '2026-03-08T16:00:00Z', timeZone: 'UTC' },
                  end: { dateTime: '2026-03-08T17:00:00Z', timeZone: 'UTC' },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ id: 'meta', labelProperties: { eventLabels: [] } }), { status: 200 });
      },
    });
    services.push(service);

    service.sources({});
    await service.flush();
    const s = service.sources({});
    const keepId = toOpaqueSourceId('keep@example.com');
    const dropId = toOpaqueSourceId('drop@example.com');

    // Start sync with both selected, but pause Drop mid-flight
    pauseCalB = true;
    const rev1 = (await service.select({ sourceIds: [keepId, dropId], expectedRevision: s.selectionRevision })).selectionRevision;
    service.read(defaultRange);

    // Deselect Drop while its sync is still in flight
    pauseCalB = false;
    await service.select({ sourceIds: [keepId], expectedRevision: rev1 });
    releaseCalB();
    await service.flush();

    const afterDeselect = service.read(defaultRange);
    expect(afterDeselect.items.map((e) => e.title)).toEqual(['Kept Event']);
    expect(afterDeselect.sources.map((src) => src.sourceId)).toEqual([keepId]);

    // Disconnect via store clears everything
    await store.disconnect();
    const afterDisconnect = service.read(defaultRange);
    expect(afterDisconnect.state).toBe('disabled');
    expect(afterDisconnect.items).toEqual([]);
  });

  it('enforces 100-source capacity, 10,000-occurrence range capacity preserving prior complete range, and 401 refresh', async () => {
    const dir = makeTempDir();
    await connectStore(dir);
    let now = 1_772_950_000_000;
    let sourceTotal = 101;
    let eventTotal = 1;
    let return401Once = false;

    const service = new CalendarService({
      directory: dir,
      nowMs: () => now,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.toString().includes('oauth2.googleapis.com/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'refreshed-access',
              expires_in: 3600,
              scope: CALENDAR_SCOPES.join(' '),
            }),
            { status: 200 },
          );
        }
        if (return401Once) {
          return401Once = false;
          return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
        }
        if (url.pathname.endsWith('/users/me/calendarList')) {
          return new Response(
            JSON.stringify({
              items: Array.from({ length: sourceTotal }, (_, i) => ({
                id: `cal_${i}@example.com`,
                summary: `Cal ${i}`,
                accessRole: 'owner',
              })),
            }),
            { status: 200 },
          );
        }
        if (url.pathname.endsWith('/events')) {
          return new Response(
            JSON.stringify({
              items: Array.from({ length: eventTotal }, (_, i) => ({
                id: `ev_${i}`,
                status: 'confirmed',
                summary: `Event ${i}`,
                start: { dateTime: '2026-03-08T15:00:00Z', timeZone: 'UTC' },
                end: { dateTime: '2026-03-08T16:00:00Z', timeZone: 'UTC' },
              })),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ id: 'meta', labelProperties: { eventLabels: [] } }), { status: 200 });
      },
    });
    services.push(service);

    // >100 sources -> capacity
    service.sources({});
    await service.flush();
    expect(service.sources({}).state).toBe('capacity');
    expect(service.sources({}).errorCode).toBe('CALENDAR_CAPACITY');

    // Reduce to 1 source and trigger refresh after 15s coalesce window, testing 401 token refresh
    sourceTotal = 1;
    return401Once = true;
    now += 20_000;
    service.read({ ...defaultRange, refresh: true });
    await service.flush();

    const s = service.sources({});
    expect(s.state).toBe('setup_required');
    await service.select({ sourceIds: [s.sources[0]!.sourceId], expectedRevision: s.selectionRevision });
    await service.flush();

    const validPage = service.read(defaultRange);
    expect(validPage.state).toBe('available');
    expect(validPage.items).toHaveLength(1);

    // Now return 10,001 events on refresh -> fails with CALENDAR_CAPACITY while retaining previous 1 complete event
    eventTotal = 10_001;
    now += 20_000;
    service.read({ ...defaultRange, refresh: true });
    await service.flush();

    const capPage = service.read(defaultRange);
    expect(CalendarPageSchema.parse(capPage).state).toBe('capacity');
    expect(capPage.errorCode).toBe('CALENDAR_CAPACITY');
    expect(capPage.items).toHaveLength(1);
    expect(capPage.items[0]!.title).toBe('Event 0');
  });

  it('coaleasces manual refreshes (15s), enforces 2m active / 15m idle periodic refresh, keeps 1 active + 1 pending range, and evicts >3 cached ranges', async () => {
    const dir = makeTempDir();
    await connectStore(dir);
    let now = 1_772_950_000_000;
    let active = false;
    const fetchedRanges: string[] = [];
    let releaseFirstRange!: () => void;
    const firstRangeGate = new Promise<void>((resolve) => {
      releaseFirstRange = resolve;
    });
    let pauseFirst = false;

    const service = new CalendarService({
      directory: dir,
      nowMs: () => now,
      phoneActive: () => active,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/users/me/calendarList')) {
          return new Response(
            JSON.stringify({
              items: [{ id: 'main@example.com', summary: 'Main', accessRole: 'owner' }],
            }),
            { status: 200 },
          );
        }
        if (url.pathname.endsWith('/events')) {
          const timeMin = url.searchParams.get('timeMin')!;
          fetchedRanges.push(timeMin);
          if (pauseFirst) {
            pauseFirst = false;
            await firstRangeGate;
          }
          return new Response(
            JSON.stringify({
              items: Array.from({ length: 55 }, (_, i) => ({
                id: `ev_${i}`,
                status: 'confirmed',
                summary: `Row ${i}`,
                start: { dateTime: timeMin, timeZone: 'UTC' },
                end: { dateTime: new Date(Date.parse(timeMin) + 60_000).toISOString(), timeZone: 'UTC' },
              })),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ id: 'meta', labelProperties: { eventLabels: [] } }), { status: 200 });
      },
    });
    services.push(service);

    service.sources({});
    await service.flush();
    const s = service.sources({});
    await service.select({ sourceIds: [s.sources[0]!.sourceId], expectedRevision: s.selectionRevision });

    // Rapid navigation: R1 starts (paused), R2 queued, R3 replaces R2 in pending slot!
    pauseFirst = true;
    const r1 = { startDate: '2026-03-01', days: 1, timeZone: 'UTC' };
    const r2 = { startDate: '2026-03-02', days: 1, timeZone: 'UTC' };
    const r3 = { startDate: '2026-03-03', days: 1, timeZone: 'UTC' };
    service.read(r1);
    service.read(r2);
    service.read(r3);
    releaseFirstRange();
    await service.flush();

    // Only R1 and R3 were fetched; obsolete R2 pending job was superseded!
    expect(fetchedRanges).toEqual(['2026-03-01T00:00:00.000Z', '2026-03-03T00:00:00.000Z']);

    // Manual refresh invalidates active cursor immediately, and coalesces repeats within 15s
    const pageBeforeRefresh = service.read(r3);
    expect(pageBeforeRefresh.nextCursor).not.toBeNull();
    now += 20_000;
    service.read({ ...r3, refresh: true });
    // Old cursor is immediately invalid even before flush
    expect(service.read({ ...r3, cursor: pageBeforeRefresh.nextCursor! }).errorCode).toBe('CALENDAR_CURSOR_EXPIRED');
    await service.flush();
    const countAfterFirstManual = fetchedRanges.length;

    // Another refresh 5s later (<15s coalesce spacing) does not trigger another upstream fetch
    now += 5_000;
    service.read({ ...r3, refresh: true });
    await service.flush();
    expect(fetchedRanges.length).toBe(countAfterFirstManual);

    // Idle phone at +3 minutes (<15m idle interval) does not trigger periodic event refresh
    active = false;
    now += 3 * 60 * 1000;
    service.read(r3);
    await service.flush();
    expect(fetchedRanges.length).toBe(countAfterFirstManual);

    // Active phone at +3 minutes (>=2m active interval) triggers periodic event refresh
    active = true;
    service.read(r3);
    await service.flush();
    expect(fetchedRanges.length).toBe(countAfterFirstManual + 1);

    // Selection change invalidates existing cursors with CALENDAR_SELECTION_CHANGED
    const freshPage = service.read(r3);
    expect(freshPage.nextCursor).not.toBeNull();
    const latestSources = service.sources({});
    await service.select({ sourceIds: [], expectedRevision: latestSources.selectionRevision });
    expect(service.read({ ...r3, cursor: freshPage.nextCursor! }).errorCode).toBe('CALENDAR_SELECTION_CHANGED');
  });
});
