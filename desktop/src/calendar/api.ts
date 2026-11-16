import { createHash } from 'node:crypto';
import type { CalendarErrorCode, CalendarEvent, CalendarMoment } from '@phone-monitor/protocol';

export const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
export const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_SOURCES_CAPACITY = 100;
export const MAX_CONCURRENT_UPSTREAM = 2;

const LEGACY_EVENT_COLORS: Readonly<Record<string, string>> = Object.freeze({
  '1': '#7986CB',
  '2': '#33B679',
  '3': '#8E24AA',
  '4': '#E67C73',
  '5': '#F6BF26',
  '6': '#F4511E',
  '7': '#039BE5',
  '8': '#616161',
  '9': '#3F51B5',
  '10': '#0B8043',
  '11': '#D50000',
});

export class CalendarApiError extends Error {
  readonly code: CalendarErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: CalendarErrorCode, options: { status?: number; retryAfterMs?: number } = {}) {
    super(code);
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export function toOpaqueSourceId(rawCalendarId: string): string {
  return `cal_${createHash('sha256').update(rawCalendarId).digest('base64url').slice(0, 24)}`;
}

export function toOpaqueEventId(rawCalendarId: string, rawEventId: string): string {
  return `evt_${createHash('sha256').update(`${rawCalendarId}\0${rawEventId}`).digest('base64url').slice(0, 24)}`;
}

export function trimCodePoints(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : points.slice(0, max).join('');
}

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toUpperCase() : null;
}

export function isValidGregorianDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= maxDay;
}

export function isValidIanaTimeZone(value: string): boolean {
  if (!value || value.length > 80 || /^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function addGregorianDays(dateStr: string, days: number): string {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(5, 7));
  const day = Number(dateStr.slice(8, 10));
  const dt = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0, 0));
  const y = dt.getUTCFullYear().toString().padStart(4, '0');
  const m = (dt.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = dt.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getZoneOffsetMs(epochMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(new Date(epochMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'second') second = Number(part.value);
  }
  const asUtc = Date.UTC(year, month - 1, day, hour === 24 ? 0 : hour, minute, second, 0);
  const roundedEpoch = Math.floor(epochMs / 1000) * 1000;
  return asUtc - roundedEpoch;
}

export function zonedMidnightEpochMs(dateStr: string, timeZone: string): number {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(5, 7));
  const day = Number(dateStr.slice(8, 10));
  const utcMidnight = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const firstGuess = utcMidnight - getZoneOffsetMs(utcMidnight, timeZone);
  return utcMidnight - getZoneOffsetMs(firstGuess, timeZone);
}

export function parseRetryAfterMs(headerValue: string | null, nowMs = Date.now()): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.floor(seconds * 1000), 3_600_000);
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate) && parsedDate > nowMs) {
    return Math.min(parsedDate - nowMs, 3_600_000);
  }
  return undefined;
}

async function readUpstreamJson(response: Response): Promise<Record<string, unknown>> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > MAX_UPSTREAM_RESPONSE_BYTES) {
      throw new CalendarApiError('CALENDAR_CAPACITY');
    }
  }

  let text = '';
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > MAX_UPSTREAM_RESPONSE_BYTES) {
            await reader.cancel().catch(() => {});
            throw new CalendarApiError('CALENDAR_CAPACITY');
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_UPSTREAM_RESPONSE_BYTES) {
      throw new CalendarApiError('CALENDAR_CAPACITY');
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CalendarApiError('CALENDAR_UNAVAILABLE');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CalendarApiError('CALENDAR_UNAVAILABLE');
  }
  return parsed as Record<string, unknown>;
}

async function googleGetJson(
  url: string,
  accessToken: string,
  fetchFn: typeof globalThis.fetch,
  nowMs: () => number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!url.startsWith(`${GOOGLE_CALENDAR_API_BASE}/`)) {
    throw new CalendarApiError('CALENDAR_UNAVAILABLE');
  }
  let response: Response;
  try {
    const timeoutSignal = AbortSignal.timeout(15_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
      redirect: 'error',
      signal: combinedSignal,
    });
  } catch (err) {
    if (err instanceof CalendarApiError) throw err;
    throw new CalendarApiError('CALENDAR_UNAVAILABLE');
  }

  if (response.status === 401) {
    throw new CalendarApiError('CALENDAR_AUTH_REQUIRED', { status: 401 });
  }
  if (response.status === 429 || response.status === 503 || (response.status >= 500 && response.status <= 599)) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), nowMs());
    throw new CalendarApiError('CALENDAR_UNAVAILABLE', {
      status: response.status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (response.status !== 200) {
    throw new CalendarApiError('CALENDAR_UNAVAILABLE', { status: response.status });
  }

  return readUpstreamJson(response);
}

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let failed = false;
  let firstError: unknown;
  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      if (failed) break;
      const idx = nextIndex++;
      if (idx >= items.length) break;
      try {
        results[idx] = await worker(items[idx]!);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  });
  // Drain every in-flight runner before the caller may refresh credentials/retry.
  await Promise.all(runners);
  if (failed) throw firstError;
  return results;
}

export interface DiscoveredCalendarSource {
  rawCalendarId: string;
  sourceId: string;
  name: string;
  color: string | null;
  capability: 'read' | 'busy' | 'unavailable';
  defaultReminderMinutes: number | null;
  timeZone: string | null;
  labels: Map<string, { name: string | null; color: string }>;
  labelMetadataAvailable: boolean;
  labelMetadataErrorCode?: CalendarErrorCode;
  labelMetadataRetryAfterMs?: number;
}

function parseReminderMinutes(reminders: unknown): number | null {
  if (!Array.isArray(reminders) || reminders.length === 0) return null;
  let fallback: number | null = null;
  for (const entry of reminders) {
    if (entry === null || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const minutes = rec.minutes;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > 40320) continue;
    if (rec.method === 'popup') return minutes;
    if (fallback === null) fallback = minutes;
  }
  return fallback;
}

function sanitizeCalendarDisplayName(rawId: string, summaryOverride: unknown, summary: unknown, primary: unknown): string {
  const override = typeof summaryOverride === 'string' ? summaryOverride.trim() : '';
  if (override && !override.includes('@')) return trimCodePoints(override, 120);
  const base = typeof summary === 'string' ? summary.trim() : '';
  if (base && !(base === rawId && base.includes('@')) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(base)) {
    return trimCodePoints(base, 120);
  }
  if (override && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(override)) {
    return trimCodePoints(override, 120);
  }
  return primary === true ? 'Primary calendar' : 'Calendar';
}

function parseCapability(accessRole: unknown): 'read' | 'busy' | 'unavailable' {
  if (accessRole === 'owner' || accessRole === 'writer' || accessRole === 'reader') return 'read';
  if (accessRole === 'freeBusyReader') return 'busy';
  return 'unavailable';
}

export interface FetchSourcesOptions {
  accessToken: string;
  fetch?: typeof globalThis.fetch;
  nowMs?: () => number;
  signal?: AbortSignal;
}

export async function fetchCalendarSourcesAndMetadata(options: FetchSourcesOptions): Promise<DiscoveredCalendarSource[]> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const nowMs = options.nowMs ?? (() => Date.now());
  const rawCalendars: Array<{
    rawCalendarId: string;
    sourceId: string;
    name: string;
    color: string | null;
    capability: 'read' | 'busy' | 'unavailable';
    defaultReminderMinutes: number | null;
    timeZone: string | null;
  }> = [];

  const seenCalendarIds = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;

  for (;;) {
    const url = new URL(`${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList`);
    url.searchParams.set('showHidden', 'true');
    url.searchParams.set('maxResults', '250');
    url.searchParams.set(
      'fields',
      'nextPageToken,items(id,summary,summaryOverride,backgroundColor,accessRole,defaultReminders,timeZone,primary,deleted,hidden,selected)',
    );
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const body = await googleGetJson(url.toString(), options.accessToken, fetchFn, nowMs, options.signal);
    const items = Array.isArray(body.items) ? body.items : [];
    for (const raw of items) {
      if (raw === null || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (item.deleted === true) continue;
      const rawId = typeof item.id === 'string' ? item.id.trim() : '';
      if (!rawId || seenCalendarIds.has(rawId)) continue;
      seenCalendarIds.add(rawId);

      if (rawCalendars.length >= MAX_SOURCES_CAPACITY) {
        throw new CalendarApiError('CALENDAR_CAPACITY');
      }

      const sourceId = toOpaqueSourceId(rawId);
      const name = sanitizeCalendarDisplayName(rawId, item.summaryOverride, item.summary, item.primary);
      const color = normalizeHexColor(item.backgroundColor);
      const capability = parseCapability(item.accessRole);
      const defaultReminderMinutes = parseReminderMinutes(item.defaultReminders);
      const tz = typeof item.timeZone === 'string' && isValidIanaTimeZone(item.timeZone) ? item.timeZone : null;

      rawCalendars.push({
        rawCalendarId: rawId,
        sourceId,
        name,
        color,
        capability,
        defaultReminderMinutes,
        timeZone: tz,
      });
    }

    const next = typeof body.nextPageToken === 'string' && body.nextPageToken.trim() ? body.nextPageToken.trim() : undefined;
    if (!next) break;
    if (seenPageTokens.has(next)) throw new CalendarApiError('CALENDAR_UNAVAILABLE');
    seenPageTokens.add(next);
    pageToken = next;
  }

  return runWithConcurrency(rawCalendars, MAX_CONCURRENT_UPSTREAM, async (base) => {
    const labels = new Map<string, { name: string | null; color: string }>();
    let labelMetadataAvailable = false;
    let labelMetadataErrorCode: CalendarErrorCode | undefined;
    let labelMetadataRetryAfterMs: number | undefined;
    let timeZone = base.timeZone;

    if (base.capability === 'read') {
      const metaUrl = new URL(`${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(base.rawCalendarId)}`);
      metaUrl.searchParams.set('fields', 'id,summary,timeZone,labelProperties');
      try {
        const meta = await googleGetJson(metaUrl.toString(), options.accessToken, fetchFn, nowMs, options.signal);
        if (!timeZone && typeof meta.timeZone === 'string' && isValidIanaTimeZone(meta.timeZone)) {
          timeZone = meta.timeZone;
        }
        const labelProps =
          meta.labelProperties !== null && typeof meta.labelProperties === 'object'
            ? (meta.labelProperties as Record<string, unknown>)
            : null;
        const eventLabels = labelProps && Array.isArray(labelProps.eventLabels) ? labelProps.eventLabels : null;
        if (eventLabels) {
          labelMetadataAvailable = true;
          for (const rawLabel of eventLabels) {
            if (rawLabel === null || typeof rawLabel !== 'object') continue;
            const l = rawLabel as Record<string, unknown>;
            const id = typeof l.id === 'string' ? l.id.trim() : '';
            if (!id) continue;
            const rawName = typeof l.name === 'string' ? l.name.trim() : '';
            const name = rawName ? trimCodePoints(rawName, 50) : null;
            const color =
              normalizeHexColor(l.color) ??
              normalizeHexColor(l.backgroundColor) ??
              base.color ??
              '#64748B';
            labels.set(id, { name, color });
          }
        }
      } catch (err) {
        if (err instanceof CalendarApiError && (err.code === 'CALENDAR_AUTH_REQUIRED' || err.code === 'CALENDAR_CAPACITY')) throw err;
        labelMetadataAvailable = false;
        labelMetadataErrorCode = 'CALENDAR_UNAVAILABLE';
        labelMetadataRetryAfterMs = err instanceof CalendarApiError ? err.retryAfterMs : undefined;
      }
    }

    return {
      ...base,
      timeZone,
      labels,
      labelMetadataAvailable,
      ...(!labelMetadataAvailable && base.capability === 'read' ? { labelMetadataErrorCode: labelMetadataErrorCode ?? 'CALENDAR_UNSUPPORTED' as const } : {}),
      ...(labelMetadataRetryAfterMs !== undefined ? { labelMetadataRetryAfterMs } : {}),
    };
  });
}

export interface RawEventLabelRef {
  eventLabelId?: string;
  colorId?: string;
}

export function resolveEventLabel(
  source: DiscoveredCalendarSource,
  ref: RawEventLabelRef | undefined,
): { name: string | null; color: string } | null {
  if (!ref) return null;
  const legacyColor = ref.colorId ? LEGACY_EVENT_COLORS[ref.colorId] ?? null : null;
  if (ref.eventLabelId) {
    const defined = source.labels.get(ref.eventLabelId);
    if (defined) {
      return { name: defined.name, color: defined.color };
    }
    return {
      name: null,
      color: legacyColor ?? source.color ?? '#64748B',
    };
  }
  if (legacyColor) {
    return { name: null, color: legacyColor };
  }
  return null;
}

export function reapplySourceMetadata(
  events: readonly CalendarEvent[],
  source: DiscoveredCalendarSource,
  rawLabelRefs: ReadonlyMap<string, RawEventLabelRef>,
): CalendarEvent[] {
  return events.map((event) => {
    if (event.sourceId !== source.sourceId) return event;
    const ref = rawLabelRefs.get(event.id);
    return {
      ...event,
      calendarName: source.name,
      calendarColor: source.color,
      label: resolveEventLabel(source, ref),
    };
  });
}

export interface RangeStagingBudget {
  occurrences: number;
  bytes: number;
  maxOccurrences: number;
  maxBytes: number;
}

export interface FetchSourceEventsOptions {
  accessToken: string;
  source: DiscoveredCalendarSource;
  range: { startDate: string; days: number; timeZone: string };
  fetch?: typeof globalThis.fetch;
  nowMs?: () => number;
  signal?: AbortSignal;
  staging?: RangeStagingBudget;
}

export interface FetchSourceEventsResult {
  events: CalendarEvent[];
  rawLabelRefs: Map<string, RawEventLabelRef>;
  labelOptInFallback: boolean;
}

function parseSelfResponseStatus(attendees: unknown): 'needsAction' | 'declined' | 'tentative' | 'accepted' | null {
  if (!Array.isArray(attendees)) return null;
  for (const raw of attendees) {
    if (raw === null || typeof raw !== 'object') continue;
    const attendee = raw as Record<string, unknown>;
    if (attendee.self !== true) continue;
    const status = attendee.responseStatus;
    if (status === 'needsAction' || status === 'declined' || status === 'tentative' || status === 'accepted') {
      return status;
    }
    return null;
  }
  return null;
}

function parseEventReminder(reminders: unknown, defaultReminderMinutes: number | null): number | null {
  if (reminders === null || typeof reminders !== 'object') return defaultReminderMinutes;
  const rec = reminders as Record<string, unknown>;
  if (rec.useDefault === false) {
    return parseReminderMinutes(rec.overrides);
  }
  return defaultReminderMinutes;
}

function parseEndpoints(
  startRaw: unknown,
  endRaw: unknown,
  fallbackTimeZone: string,
): { start: CalendarMoment; end: CalendarMoment } | null {
  if (startRaw === null || typeof startRaw !== 'object' || endRaw === null || typeof endRaw !== 'object') {
    return null;
  }
  const s = startRaw as Record<string, unknown>;
  const e = endRaw as Record<string, unknown>;

  if (typeof s.date === 'string' && typeof e.date === 'string' && s.dateTime === undefined && e.dateTime === undefined) {
    if (!isValidGregorianDate(s.date) || !isValidGregorianDate(e.date) || !(s.date < e.date)) {
      return null;
    }
    return {
      start: { kind: 'date', date: s.date },
      end: { kind: 'date', date: e.date },
    };
  }

  if (typeof s.dateTime === 'string' && typeof e.dateTime === 'string' && s.date === undefined && e.date === undefined) {
    const startMs = Date.parse(s.dateTime);
    const endMs = Date.parse(e.dateTime);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      endMs < 0 ||
      startMs > Number.MAX_SAFE_INTEGER ||
      endMs > Number.MAX_SAFE_INTEGER ||
      !( Math.floor(startMs) < Math.floor(endMs))
    ) {
      return null;
    }
    const startTz = typeof s.timeZone === 'string' && isValidIanaTimeZone(s.timeZone) ? s.timeZone : fallbackTimeZone;
    const endTz = typeof e.timeZone === 'string' && isValidIanaTimeZone(e.timeZone) ? e.timeZone : startTz;
    return {
      start: { kind: 'time', epochMs: Math.floor(startMs), timeZone: startTz },
      end: { kind: 'time', epochMs: Math.floor(endMs), timeZone: endTz },
    };
  }

  return null;
}

export async function fetchCalendarSourceEvents(options: FetchSourceEventsOptions): Promise<FetchSourceEventsResult> {
  const { source, range } = options;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const nowMs = options.nowMs ?? (() => Date.now());

  const rangeStartDate = range.startDate;
  const rangeEndDate = addGregorianDays(range.startDate, range.days);
  const rangeStartEpochMs = zonedMidnightEpochMs(rangeStartDate, range.timeZone);
  const rangeEndEpochMs = zonedMidnightEpochMs(rangeEndDate, range.timeZone);

  const events: CalendarEvent[] = [];
  const rawLabelRefs = new Map<string, RawEventLabelRef>();
  const seenEventIds = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  let useLabelOptIn = true;
  let labelOptInFallback = false;

  for (;;) {
    const buildEventsUrl = (withLabelOptIn: boolean): string => {
      const url = new URL(`${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(source.rawCalendarId)}/events`);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('showHiddenInvitations', 'true');
      url.searchParams.set('showDeleted', 'false');
      url.searchParams.set('maxResults', '250');
      url.searchParams.set('timeMin', new Date(rangeStartEpochMs).toISOString());
      url.searchParams.set('timeMax', new Date(rangeEndEpochMs).toISOString());
      if (withLabelOptIn) {
        url.searchParams.set('eventLabelVersion', '1');
        url.searchParams.set(
          'fields',
          'nextPageToken,timeZone,items(id,status,summary,start,end,eventType,eventLabelId,colorId,reminders,attendees(self,responseStatus))',
        );
      } else {
        url.searchParams.set(
          'fields',
          'nextPageToken,timeZone,items(id,status,summary,start,end,eventType,colorId,reminders,attendees(self,responseStatus))',
        );
      }
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      return url.toString();
    };

    let body: Record<string, unknown>;
    try {
      body = await googleGetJson(buildEventsUrl(useLabelOptIn), options.accessToken, fetchFn, nowMs, options.signal);
    } catch (err) {
      if (useLabelOptIn && err instanceof CalendarApiError && err.status === 400) {
        useLabelOptIn = false;
        labelOptInFallback = true;
        body = await googleGetJson(buildEventsUrl(false), options.accessToken, fetchFn, nowMs, options.signal);
      } else {
        throw err;
      }
    }

    const calendarTz =
      typeof body.timeZone === 'string' && isValidIanaTimeZone(body.timeZone)
        ? body.timeZone
        : source.timeZone ?? range.timeZone;

    const items = Array.isArray(body.items) ? body.items : [];
    for (const raw of items) {
      if (raw === null || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (item.status === 'cancelled') continue;
      const rawId = typeof item.id === 'string' ? item.id.trim() : '';
      if (!rawId) continue;

      const endpoints = parseEndpoints(item.start, item.end, calendarTz);
      if (!endpoints) continue;

      if (endpoints.start.kind === 'date' && endpoints.end.kind === 'date') {
        if (!(endpoints.start.date < rangeEndDate && endpoints.end.date > rangeStartDate)) continue;
      } else if (endpoints.start.kind === 'time' && endpoints.end.kind === 'time') {
        if (!(endpoints.start.epochMs < rangeEndEpochMs && endpoints.end.epochMs > rangeStartEpochMs)) continue;
      }

      const id = toOpaqueEventId(source.rawCalendarId, rawId);
      if (seenEventIds.has(id)) continue;
      seenEventIds.add(id);

      const rawSummary = typeof item.summary === 'string' ? item.summary.trim() : '';
      const title = rawSummary ? trimCodePoints(rawSummary, 256) : 'Untitled event';
      const rawEventType = typeof item.eventType === 'string' && item.eventType.trim() ? item.eventType.trim() : 'default';
      const eventType = trimCodePoints(rawEventType, 40);
      const status = item.status === 'tentative' ? 'tentative' : 'confirmed';
      const selfResponseStatus = parseSelfResponseStatus(item.attendees);
      const reminderMinutes = parseEventReminder(item.reminders, source.defaultReminderMinutes);

      const eventLabelId = typeof item.eventLabelId === 'string' && item.eventLabelId.trim() ? item.eventLabelId.trim() : undefined;
      const colorId = typeof item.colorId === 'string' && item.colorId.trim() ? item.colorId.trim() : undefined;
      const ref: RawEventLabelRef | undefined =
        eventLabelId !== undefined || colorId !== undefined
          ? { ...(eventLabelId !== undefined ? { eventLabelId } : {}), ...(colorId !== undefined ? { colorId } : {}) }
          : undefined;
      if (ref) rawLabelRefs.set(id, ref);

      const normalized: CalendarEvent = {
        id,
        sourceId: source.sourceId,
        title,
        start: endpoints.start,
        end: endpoints.end,
        calendarName: source.name,
        calendarColor: source.color,
        label: resolveEventLabel(source, ref),
        eventType,
        status,
        selfResponseStatus,
        reminderMinutes,
      };

      if (options.staging) {
        options.staging.occurrences += 1;
        options.staging.bytes += Buffer.byteLength(JSON.stringify(normalized), 'utf8') +
          (ref ? Buffer.byteLength(JSON.stringify([id, ref]), 'utf8') : 0);
        if (options.staging.occurrences > options.staging.maxOccurrences || options.staging.bytes > options.staging.maxBytes) {
          throw new CalendarApiError('CALENDAR_CAPACITY');
        }
      }

      events.push(normalized);
    }

    const next = typeof body.nextPageToken === 'string' && body.nextPageToken.trim() ? body.nextPageToken.trim() : undefined;
    if (!next) break;
    if (seenPageTokens.has(next)) throw new CalendarApiError('CALENDAR_UNAVAILABLE');
    seenPageTokens.add(next);
    pageToken = next;
  }

  return { events, rawLabelRefs, labelOptInFallback };
}
