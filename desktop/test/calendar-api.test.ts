import { describe, expect, it } from 'vitest';
import { CalendarEventSchema, CalendarSourceSchema } from '@phone-monitor/protocol';
import {
  CalendarApiError,
  fetchCalendarSourceEvents,
  fetchCalendarSourcesAndMetadata,
  reapplySourceMetadata,
  toOpaqueEventId,
  toOpaqueSourceId,
  zonedMidnightEpochMs,
} from '../src/calendar/api.js';

describe('Google Calendar API bounded collection and normalization', () => {
  it('computes exact date-zone boundaries across America/New_York spring-forward DST', () => {
    // 2026-03-08 00:00 America/New_York is EST (UTC-5) -> 05:00Z
    const startMs = zonedMidnightEpochMs('2026-03-08', 'America/New_York');
    // 2026-03-09 00:00 America/New_York is EDT (UTC-4) -> 04:00Z (23 hours later)
    const nextDayMs = zonedMidnightEpochMs('2026-03-09', 'America/New_York');
    expect(new Date(startMs).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(new Date(nextDayMs).toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(nextDayMs - startMs).toBe(23 * 3600 * 1000);
  });

  it('fetches all calendarList pages (showHidden=true), two same-name calendars, capabilities, and label metadata', async () => {
    const urls: string[] = [];
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      urls.push(url.pathname + url.search);
      if (url.pathname.endsWith('/users/me/calendarList')) {
        expect(url.searchParams.get('showHidden')).toBe('true');
        const page = url.searchParams.get('pageToken');
        if (!page) {
          return new Response(
            JSON.stringify({
              nextPageToken: 'page2',
              items: [
                {
                  id: 'alice.work@example.com',
                  summary: 'Shared Team',
                  backgroundColor: '#22d3ee',
                  accessRole: 'owner',
                  defaultReminders: [{ method: 'popup', minutes: 10 }],
                },
                {
                  id: 'bob.work@example.com',
                  summary: 'Shared Team',
                  backgroundColor: '#0088ff',
                  accessRole: 'reader',
                  hidden: true,
                  defaultReminders: [{ method: 'email', minutes: 30 }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'busy@example.com',
                summary: 'Busy Room',
                accessRole: 'freeBusyReader',
              },
              {
                id: 'deleted@example.com',
                summary: 'Deleted',
                deleted: true,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.pathname.includes('/calendars/alice.work%40example.com')) {
        return new Response(
          JSON.stringify({
            id: 'alice.work@example.com',
            summary: 'Shared Team',
            labelProperties: {
              eventLabels: [
                { id: 'lbl_focus', name: 'Deep Focus', color: '#112233' },
                { id: 'lbl_unnamed', name: '', backgroundColor: '#445566' },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (url.pathname.includes('/calendars/bob.work%40example.com')) {
        // Metadata failure on one calendar must not hide the calendar or fail enumeration
        return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const discovered = await fetchCalendarSourcesAndMetadata({
      accessToken: 'synthetic-token',
      fetch: fakeFetch,
    });

    expect(discovered).toHaveLength(3);
    const [first, second, third] = discovered;
    expect(first!.name).toBe('Shared Team');
    expect(second!.name).toBe('Shared Team');
    expect(first!.sourceId).not.toBe(second!.sourceId);
    expect(first!.sourceId).not.toContain('alice');
    expect(second!.sourceId).not.toContain('bob');
    expect(first!.capability).toBe('read');
    expect(second!.capability).toBe('read');
    expect(third!.capability).toBe('busy');
    expect(first!.defaultReminderMinutes).toBe(10);
    expect(second!.defaultReminderMinutes).toBe(30);
    expect(first!.labels.get('lbl_focus')).toEqual({ name: 'Deep Focus', color: '#112233' });
    expect(first!.labels.get('lbl_unnamed')).toEqual({ name: null, color: '#445566' });
    expect(second!.labelMetadataAvailable).toBe(false);

    for (const s of discovered) {
      expect(
        CalendarSourceSchema.safeParse({
          sourceId: s.sourceId,
          name: s.name,
          color: s.color,
          selected: s.capability === 'read',
          capability: s.capability,
          state: 'available',
          lastSuccessAtEpochMs: 1_700_000_000_000,
          errorCode: null,
        }).success,
      ).toBe(true);
    }
  });

  it('normalizes all event types, recurring exceptions, cancelled rows, self-declined confirmed invitations, labels, and fallback on 400', async () => {
    const source = {
      rawCalendarId: 'team@example.com',
      sourceId: toOpaqueSourceId('team@example.com'),
      name: 'Engineering',
      color: '#22D3EE',
      capability: 'read' as const,
      defaultReminderMinutes: 15,
      timeZone: 'America/New_York',
      labels: new Map([
        ['lbl_1', { name: 'Sprint', color: '#0088FF' }],
        ['lbl_empty', { name: null, color: '#AABBCC' }],
      ]),
      labelMetadataAvailable: true,
    };

    let sawLabelOptIn = false;
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('singleEvents')).toBe('true');
      expect(url.searchParams.get('showHiddenInvitations')).toBe('true');
      expect(url.searchParams.get('eventTypes')).toBeNull();
      if (url.searchParams.get('eventLabelVersion') === '1') {
        sawLabelOptIn = true;
      }
      const pageToken = url.searchParams.get('pageToken');
      if (!pageToken) {
        return new Response(
          JSON.stringify({
            nextPageToken: 'next_ev_page',
            items: [
              {
                id: 'recurring_1_20260308T140000Z',
                status: 'confirmed',
                summary: '',
                eventType: 'focusTime',
                eventLabelId: 'lbl_1',
                start: { dateTime: '2026-03-08T10:00:00-04:00', timeZone: 'America/New_York' },
                end: { dateTime: '2026-03-08T11:00:00-04:00', timeZone: 'America/New_York' },
                reminders: { useDefault: true },
                description: 'Private description must be stripped',
                hangoutLink: 'https://meet.google.com/secret',
                organizer: { email: 'boss@example.com' },
                attendees: [
                  { email: 'colleague@example.com', responseStatus: 'accepted' },
                  { email: 'me@example.com', self: true, responseStatus: 'declined' },
                ],
              },
              {
                id: 'cancelled_instance',
                status: 'cancelled',
                summary: 'Deleted meeting',
                start: { dateTime: '2026-03-08T12:00:00-04:00' },
                end: { dateTime: '2026-03-08T13:00:00-04:00' },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'all_day_holiday',
              status: 'tentative',
              summary: 'Company Offsite',
              start: { date: '2026-03-08' },
              end: { date: '2026-03-10' },
              eventLabelId: 'unknown_label_id',
              colorId: '2',
              reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const result = await fetchCalendarSourceEvents({
      accessToken: 'synthetic-token',
      source,
      range: { startDate: '2026-03-08', days: 7, timeZone: 'America/New_York' },
      fetch: fakeFetch,
    });

    expect(sawLabelOptIn).toBe(true);
    expect(result.events).toHaveLength(2);

    const timed = result.events.find((e) => e.start.kind === 'time')!;
    expect(CalendarEventSchema.parse(timed)).toEqual(timed);
    expect(timed.id).toBe(toOpaqueEventId('team@example.com', 'recurring_1_20260308T140000Z'));
    expect(timed.title).toBe('Untitled event');
    expect(timed.status).toBe('confirmed');
    expect(timed.selfResponseStatus).toBe('declined');
    expect(timed.eventType).toBe('focusTime');
    expect(timed.label).toEqual({ name: 'Sprint', color: '#0088FF' });
    expect(timed.reminderMinutes).toBe(15);
    expect(JSON.stringify(timed)).not.toContain('boss@example.com');
    expect(JSON.stringify(timed)).not.toContain('meet.google.com');

    const allDay = result.events.find((e) => e.start.kind === 'date')!;
    expect(CalendarEventSchema.parse(allDay)).toEqual(allDay);
    expect(allDay.start).toEqual({ kind: 'date', date: '2026-03-08' });
    expect(allDay.end).toEqual({ kind: 'date', date: '2026-03-10' });
    expect(allDay.status).toBe('tentative');
    expect(allDay.reminderMinutes).toBe(60);
    // Unresolved eventLabelId falls back to neutral unnamed color without hiding the event
    expect(allDay.label).toEqual({ name: null, color: '#33B679' });

    // Reapplying updated label metadata updates cached event labels without refetching events
    const updatedSource = {
      ...source,
      name: 'Engineering Renamed',
      labels: new Map([
        ['lbl_1', { name: 'Renamed Sprint', color: '#FF0055' }],
        ['unknown_label_id', { name: 'Resolved Later', color: '#123456' }],
      ]),
    };
    const reapplied = reapplySourceMetadata(result.events, updatedSource, result.rawLabelRefs);
    expect(reapplied[0]!.calendarName).toBe('Engineering Renamed');
    expect(reapplied[0]!.label).toEqual({ name: 'Renamed Sprint', color: '#FF0055' });
    expect(reapplied[1]!.label).toEqual({ name: 'Resolved Later', color: '#123456' });
  });

  it('falls back cleanly when upstream rejects eventLabelVersion=1 with HTTP 400 and enforces 2 MiB upstream cap', async () => {
    const source = {
      rawCalendarId: 'fallback@example.com',
      sourceId: toOpaqueSourceId('fallback@example.com'),
      name: 'Fallback Calendar',
      color: '#22D3EE',
      capability: 'read' as const,
      defaultReminderMinutes: null,
      timeZone: 'UTC',
      labels: new Map(),
      labelMetadataAvailable: false,
    };

    let attempts = 0;
    const res = await fetchCalendarSourceEvents({
      accessToken: 'synthetic-token',
      source,
      range: { startDate: '2026-03-08', days: 1, timeZone: 'UTC' },
      fetch: async (input) => {
        attempts++;
        const url = new URL(String(input));
        if (url.searchParams.has('eventLabelVersion')) {
          return new Response(JSON.stringify({ error: { code: 400, message: 'Unknown parameter eventLabelVersion' } }), { status: 400 });
        }
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'ev_legacy',
                status: 'confirmed',
                summary: 'Legacy Event',
                colorId: '1',
                start: { dateTime: '2026-03-08T10:00:00Z' },
                end: { dateTime: '2026-03-08T11:00:00Z' },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    expect(attempts).toBe(2);
    expect(res.labelOptInFallback).toBe(true);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.label).toEqual({ name: null, color: '#7986CB' });

    // Oversized upstream response (> 2 MiB) fails with CALENDAR_CAPACITY
    await expect(
      fetchCalendarSourceEvents({
        accessToken: 'synthetic-token',
        source,
        range: { startDate: '2026-03-08', days: 1, timeZone: 'UTC' },
        fetch: async () => new Response('x'.repeat(2 * 1024 * 1024 + 10), { status: 200 }),
      }),
    ).rejects.toThrow(CalendarApiError);
  });
});
