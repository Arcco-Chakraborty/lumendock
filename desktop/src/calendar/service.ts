import { randomBytes } from 'node:crypto';
import {
  CalendarRangeRequestSchema,
  CalendarSelectRequestSchema,
  CalendarSourcesRequestSchema,
  type CalendarErrorCode,
  type CalendarEvent,
  type CalendarPage,
  type CalendarRangeRequest,
  type CalendarSelectReply,
  type CalendarSelectRequest,
  type CalendarSource,
  type CalendarSourcesPage,
  type CalendarSourcesRequest,
  type CalendarState,
} from '@phone-monitor/protocol';
import {
  CalendarApiError,
  MAX_CONCURRENT_UPSTREAM,
  fetchCalendarSourceEvents,
  fetchCalendarSourcesAndMetadata,
  reapplySourceMetadata,
  runWithConcurrency,
  zonedMidnightEpochMs,
  type DiscoveredCalendarSource,
  type RangeStagingBudget,
  type RawEventLabelRef,
} from './api.js';
import { CalendarConnectionStore, generationId } from './connection.js';
import { refreshCalendarTokens } from './oauth.js';

export const ACTIVE_EVENT_REFRESH_MS = 2 * 60 * 1000;
export const IDLE_EVENT_REFRESH_MS = 15 * 60 * 1000;
export const METADATA_REFRESH_MS = 15 * 60 * 1000;
export const MANUAL_REFRESH_COALESCE_MS = 15 * 1000;
export const CURSOR_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_ERROR_BACKOFF_MS = 30 * 1000;
export const MAX_CACHED_RANGES = 3;
export const MAX_CACHE_BYTES = 16 * 1024 * 1024;
export const MAX_RANGE_OCCURRENCES = 10_000;
export const MAX_STAGING_BYTES = 16 * 1024 * 1024;
export const MAX_PAGE_ITEMS = 50;
export const MAX_PAGE_SOURCES = 50;
export const MAX_PAGE_SERIALIZED_BYTES = 128 * 1024;

export function sortRangeEvents(events: readonly CalendarEvent[], displayTimeZone: string): CalendarEvent[] {
  const midnightCache = new Map<string, number>();
  const getStartMs = (event: CalendarEvent): number => {
    if (event.start.kind === 'time') return event.start.epochMs;
    const cached = midnightCache.get(event.start.date);
    if (cached !== undefined) return cached;
    const ms = zonedMidnightEpochMs(event.start.date, displayTimeZone);
    midnightCache.set(event.start.date, ms);
    return ms;
  };
  return [...events].sort((a, b) => {
    const diff = getStartMs(a) - getStartMs(b);
    if (diff !== 0) return diff;
    if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
}

export function computeNextEvent(events: readonly CalendarEvent[], serverNowEpochMs: number): CalendarEvent | null {
  let best: CalendarEvent | null = null;
  let bestOngoing = false;

  for (const event of events) {
    if (event.start.kind !== 'time' || event.end.kind !== 'time') continue;
    if (event.selfResponseStatus === 'declined') continue;
    if (event.end.epochMs <= serverNowEpochMs) continue;

    const ongoing = event.start.epochMs <= serverNowEpochMs;
    if (best === null) {
      best = event;
      bestOngoing = ongoing;
      continue;
    }

    if (ongoing !== bestOngoing) {
      if (ongoing) {
        best = event;
        bestOngoing = true;
      }
      continue;
    }

    const bestStart = best.start.kind === 'time' ? best.start.epochMs : 0;
    if (event.start.epochMs !== bestStart) {
      if (event.start.epochMs < bestStart) {
        best = event;
        bestOngoing = ongoing;
      }
      continue;
    }

    if (event.sourceId !== best.sourceId) {
      if (event.sourceId < best.sourceId) {
        best = event;
        bestOngoing = ongoing;
      }
      continue;
    }

    if (event.id < best.id) {
      best = event;
      bestOngoing = ongoing;
    }
  }

  return best;
}

interface CachedSourceWindow {
  sourceId: string;
  events: CalendarEvent[];
  rawLabelRefs: Map<string, RawEventLabelRef>;
  lastSuccessAtEpochMs: number | null;
  state: CalendarState;
  errorCode: CalendarErrorCode | null;
}

interface CachedRange {
  key: string;
  range: { startDate: string; days: number; timeZone: string };
  revision: string;
  selectionRevision: string;
  bySource: Map<string, CachedSourceWindow>;
  events: CalendarEvent[];
  lastSuccessAtEpochMs: number | null;
  lastSyncAttemptAtMs: number | null;
  state: CalendarState;
  errorCode: CalendarErrorCode | null;
  approxBytes: number;
  lastViewedAtMs: number;
}

interface RangeCursorRecord {
  rangeKey: string;
  revision: string;
  selectionRevision: string;
  offset: number;
  issuedAtMs: number;
}

interface SourceCursorRecord {
  selectionRevision: string;
  metadataRevision: string;
  offset: number;
  issuedAtMs: number;
}

export interface CalendarServiceOptions {
  directory: string;
  nowMs?: () => number;
  fetch?: typeof globalThis.fetch;
  phoneActive?: () => boolean;
  store?: CalendarConnectionStore;
}

function sourceWindowBytes(windows: ReadonlyMap<string, CachedSourceWindow>): number {
  let bytes = 0;
  for (const win of windows.values()) {
    bytes += Buffer.byteLength(JSON.stringify(win.events), 'utf8');
    bytes += Buffer.byteLength(JSON.stringify([...win.rawLabelRefs]), 'utf8');
  }
  return bytes;
}

function makeRangeKey(range: { startDate: string; days: number; timeZone: string }): string {
  return `${range.startDate}|${range.days}|${range.timeZone}`;
}

export class CalendarService {
  private readonly store: CalendarConnectionStore;
  private readonly nowMs: () => number;
  private readonly fetchFn: typeof globalThis.fetch;
  private phoneActiveFn: () => boolean;

  private stopped = false;
  private currentGeneration = 'disconnected';
  private currentSelectionRevision = 'disconnected';
  private connected = false;
  private applied = false;
  private authRequired = false;
  private storageError = false;
  private selectedIds = new Set<string>();

  private discoveredSources: DiscoveredCalendarSource[] = [];
  private metadataLoaded = false;
  private metadataState: CalendarState = 'disabled';
  private metadataErrorCode: CalendarErrorCode | null = null;
  private metadataRevision = generationId();
  private lastMetadataSyncAtMs: number | null = null;
  private lastMetadataSuccessAtMs: number | null = null;

  private sourceStates = new Map<string, { state: CalendarState; lastSuccessAtEpochMs: number | null; errorCode: CalendarErrorCode | null }>();
  private cachedRanges = new Map<string, CachedRange>();
  private lastRequestedRange: { startDate: string; days: number; timeZone: string } | null = null;

  private rangeCursors = new Map<string, RangeCursorRecord>();
  private sourceCursors = new Map<string, SourceCursorRecord>();

  private lastManualRefreshAtMs: number | null = null;
  private backoffUntilMs = 0;

  private pendingMetadataSync = false;
  private activeRangeKey: string | null = null;
  private activeRangeSelectionRevision: string | null = null;
  private pendingRangeRequest: { startDate: string; days: number; timeZone: string } | null = null;
  private workerPromise: Promise<void> | null = null;
  private activeAbortController: AbortController | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CalendarServiceOptions) {
    this.store = options.store ?? new CalendarConnectionStore(options.directory);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.phoneActiveFn = options.phoneActive ?? (() => false);
    this.startWatchdog();
  }

  setPhoneActive(fn: () => boolean): void {
    this.phoneActiveFn = fn;
  }

  stop(): void {
    this.stopped = true;
    this.stopWatchdog();
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.pendingMetadataSync = false;
    this.pendingRangeRequest = null;
  }

  async flush(): Promise<void> {
    while (this.workerPromise !== null) {
      await this.workerPromise;
    }
  }

  private startWatchdog(): void {
    if (this.watchdogTimer !== null || this.stopped) return;
    this.watchdogTimer = setInterval(() => {
      try {
        this.syncConnectionState();
        const entry = this.lastRequestedRange ? this.cachedRanges.get(makeRangeKey(this.lastRequestedRange)) : undefined;
        this.maybeSchedulePeriodicSync(entry);
        if (this.pendingMetadataSync || this.pendingRangeRequest) this.ensureWorkerRunning();
      } catch {
        /* handled inside syncConnectionState */
      }
    }, 2000);
    this.watchdogTimer.unref();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private resetInMemoryState(): void {
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.pendingMetadataSync = false;
    this.activeRangeKey = null;
    this.pendingRangeRequest = null;
    this.discoveredSources = [];
    this.metadataLoaded = false;
    this.metadataRevision = generationId();
    this.lastMetadataSyncAtMs = null;
    this.lastMetadataSuccessAtMs = null;
    this.sourceStates.clear();
    this.cachedRanges.clear();
    this.rangeCursors.clear();
    this.sourceCursors.clear();
    this.lastManualRefreshAtMs = null;
    this.backoffUntilMs = 0;
  }

  private syncConnectionState(): void {
    let disk;
    try {
      disk = this.store.read();
      this.storageError = false;
    } catch {
      this.storageError = true;
      this.resetInMemoryState();
      this.connected = false;
      this.applied = false;
      this.authRequired = false;
      this.metadataState = 'error';
      this.metadataErrorCode = 'CALENDAR_UNAVAILABLE';
      return;
    }

    if (!disk.connected) {
      if (
        this.connected ||
        this.currentGeneration !== disk.generation ||
        this.authRequired !== (disk.authRequired === true)
      ) {
        this.resetInMemoryState();
      }
      this.currentGeneration = disk.generation;
      this.currentSelectionRevision = disk.selectionRevision;
      this.connected = false;
      this.applied = false;
      this.authRequired = disk.authRequired === true;
      this.selectedIds.clear();
      this.metadataState = this.authRequired ? 'auth_required' : 'disabled';
      this.metadataErrorCode = this.authRequired ? 'CALENDAR_AUTH_REQUIRED' : null;
      return;
    }

    if (!this.connected || disk.generation !== this.currentGeneration) {
      this.resetInMemoryState();
      this.currentGeneration = disk.generation;
      this.currentSelectionRevision = disk.selectionRevision;
      this.connected = true;
      this.applied = disk.applied;
      this.authRequired = false;
      this.selectedIds = new Set(disk.selectedIds);
      this.metadataState = disk.applied ? 'loading' : 'setup_required';
      this.metadataErrorCode = null;
      this.queueMetadataSync();
      return;
    }

    if (disk.selectionRevision !== this.currentSelectionRevision || disk.applied !== this.applied) {
      this.applySelectionStateToMemory(disk.selectionRevision, disk.applied, disk.selectedIds);
    }
  }

  private applySelectionStateToMemory(selectionRevision: string, applied: boolean, selectedIds: readonly string[]): void {
    this.currentSelectionRevision = selectionRevision;
    this.applied = applied;
    this.selectedIds = new Set(selectedIds);
    this.rangeCursors.clear();
    this.sourceCursors.clear();

    for (const rangeEntry of this.cachedRanges.values()) {
      rangeEntry.selectionRevision = selectionRevision;
      for (const sourceId of [...rangeEntry.bySource.keys()]) {
        if (!this.selectedIds.has(sourceId)) {
          rangeEntry.bySource.delete(sourceId);
        }
      }
      this.recomputeRangeFromSources(rangeEntry);
    }
  }

  private recomputeRangeFromSources(rangeEntry: CachedRange): void {
    const selectedReadable = this.getSelectedReadableSources();
    const combined: CalendarEvent[] = [];
    let failedCount = 0;
    let hasCapacityFailure = false;
    let missingAnySource = false;

    for (const src of selectedReadable) {
      const win = rangeEntry.bySource.get(src.sourceId);
      if (!win) {
        missingAnySource = true;
        continue;
      }
      combined.push(...win.events);
      if (win.state === 'error' || win.state === 'capacity' || win.state === 'partial') {
        failedCount += 1;
        if (win.errorCode === 'CALENDAR_CAPACITY') hasCapacityFailure = true;
      }
    }

    rangeEntry.events = sortRangeEvents(combined, rangeEntry.range.timeZone);
    rangeEntry.revision = generationId();
    rangeEntry.approxBytes = sourceWindowBytes(rangeEntry.bySource);

    if (!this.applied) {
      rangeEntry.state = 'setup_required';
      rangeEntry.errorCode = null;
      return;
    }

    if (!this.metadataLoaded || this.metadataState === 'error' || this.metadataState === 'capacity') {
      rangeEntry.state = rangeEntry.lastSuccessAtEpochMs !== null ? 'partial' : this.metadataState === 'capacity' ? 'capacity' : this.metadataState === 'error' ? 'error' : 'loading';
      rangeEntry.errorCode = this.metadataErrorCode;
      return;
    }

    if (selectedReadable.length === 0) {
      rangeEntry.state = 'available';
      rangeEntry.errorCode = null;
      if (rangeEntry.lastSuccessAtEpochMs === null) {
        rangeEntry.lastSuccessAtEpochMs = this.nowMs();
      }
      return;
    }

    if (missingAnySource && rangeEntry.events.length === 0 && failedCount === 0) {
      rangeEntry.state = 'loading';
      rangeEntry.errorCode = null;
      return;
    }

    if (failedCount === 0 && !missingAnySource) {
      rangeEntry.state = 'available';
      rangeEntry.errorCode = null;
    } else if (failedCount < selectedReadable.length || rangeEntry.events.length > 0 || rangeEntry.lastSuccessAtEpochMs !== null) {
      rangeEntry.state = 'partial';
      rangeEntry.errorCode = hasCapacityFailure ? 'CALENDAR_CAPACITY' : [...rangeEntry.bySource.values()].some(w => w.errorCode === 'CALENDAR_UNAVAILABLE') ? 'CALENDAR_UNAVAILABLE' : 'CALENDAR_UNSUPPORTED';
    } else {
      rangeEntry.state = hasCapacityFailure ? 'capacity' : 'error';
      rangeEntry.errorCode = hasCapacityFailure ? 'CALENDAR_CAPACITY' : 'CALENDAR_UNAVAILABLE';
    }
  }

  private getSelectedReadableSources(): DiscoveredCalendarSource[] {
    if (!this.applied) return [];
    return this.discoveredSources.filter((s) => this.selectedIds.has(s.sourceId) && s.capability === 'read');
  }

  private toProtocolSource(source: DiscoveredCalendarSource, rangeEntry?: CachedRange): CalendarSource {
    const selected = this.applied ? this.selectedIds.has(source.sourceId) : source.capability === 'read';
    const rangeSource = rangeEntry?.bySource.get(source.sourceId);
    const globalSource = this.sourceStates.get(source.sourceId);

    let state: CalendarState = !this.applied ? 'setup_required' : 'available';
    let errorCode: CalendarErrorCode | null = null;
    let lastSuccessAtEpochMs = rangeSource?.lastSuccessAtEpochMs ?? globalSource?.lastSuccessAtEpochMs ?? this.lastMetadataSuccessAtMs;

    if (source.capability !== 'read') {
      state = selected ? 'error' : !this.applied ? 'setup_required' : 'available';
      errorCode = selected ? 'CALENDAR_UNAVAILABLE' : null;
    } else if (rangeSource) {
      state = rangeSource.state;
      errorCode = rangeSource.errorCode;
      lastSuccessAtEpochMs = rangeSource.lastSuccessAtEpochMs;
    } else if (globalSource) {
      state = !this.applied ? 'setup_required' : globalSource.state;
      errorCode = globalSource.errorCode;
      lastSuccessAtEpochMs = globalSource.lastSuccessAtEpochMs;
    } else if (this.applied && selected && !rangeEntry) {
      state = 'available';
    } else if (this.applied && selected && rangeEntry && !rangeEntry.bySource.has(source.sourceId)) {
      state = 'loading';
    }

    if (source.capability === 'read' && source.labelMetadataErrorCode && (state === 'available' || state === 'partial')) {
      state = 'partial';
      errorCode = source.labelMetadataErrorCode;
    }
    if (selected && this.metadataState === 'error' && state !== 'capacity') {
      state = 'partial';
      errorCode = this.metadataErrorCode;
    }

    return {
      sourceId: source.sourceId,
      name: source.name,
      color: source.color,
      selected,
      capability: source.capability,
      state,
      lastSuccessAtEpochMs: lastSuccessAtEpochMs ?? null,
      errorCode,
    };
  }

  private queueMetadataSync(): void {
    if (this.stopped || !this.connected) return;
    this.pendingMetadataSync = true;
    this.ensureWorkerRunning();
  }

  private queueRangeSync(range: { startDate: string; days: number; timeZone: string }, force = false): void {
    if (this.stopped || !this.connected || !this.applied) return;
    const key = makeRangeKey(range);
    if (
      !force &&
      this.activeRangeKey === key &&
      this.activeRangeSelectionRevision === this.currentSelectionRevision &&
      this.pendingRangeRequest === null
    ) {
      return;
    }
    this.pendingRangeRequest = { ...range };
    this.ensureWorkerRunning();
  }

  private ensureWorkerRunning(): void {
    if (this.workerPromise !== null || this.stopped) return;
    this.startWatchdog();
    this.workerPromise = this.runWorkerLoop().finally(() => {
      this.workerPromise = null;
    });
  }

  private async runWorkerLoop(): Promise<void> {
    while (!this.stopped) {
      this.syncConnectionState();
      if (!this.connected || this.nowMs() < this.backoffUntilMs) break;

      if (this.pendingMetadataSync) {
        this.pendingMetadataSync = false;
        await this.executeMetadataSync();
        continue;
      }

      if (this.applied && this.pendingRangeRequest !== null) {
        const range = this.pendingRangeRequest;
        this.pendingRangeRequest = null;
        if (!this.metadataLoaded) {
          await this.executeMetadataSync();
          this.syncConnectionState();
          if (!this.connected || !this.applied || !this.metadataLoaded) {
            if (this.connected && this.applied) this.pendingRangeRequest ??= range;
            break;
          }
          if (this.nowMs() < this.backoffUntilMs) { this.pendingRangeRequest ??= range; break; }
        }
        this.activeRangeKey = makeRangeKey(range);
        this.activeRangeSelectionRevision = this.currentSelectionRevision;
        try {
          await this.executeRangeSync(range);
        } finally {
          this.activeRangeKey = null;
          this.activeRangeSelectionRevision = null;
        }
        continue;
      }

      break;
    }
  }

  private async callWithTokenRefresh<T>(
    generation: string,
    fn: (accessToken: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const creds = this.store.credentials(generation);
    if (!creds) throw new CalendarApiError('CALENDAR_AUTH_REQUIRED');

    let accessToken = creds.tokens.accessToken;
    const now = this.nowMs();
    if (creds.tokens.expiresAt <= now + 30_000 && creds.tokens.refreshToken) {
      const refreshed = await refreshCalendarTokens({
        store: this.store,
        generation,
        fetch: this.fetchFn,
        nowMs: this.nowMs,
      });
      accessToken = refreshed.accessToken;
    }

    const controller = new AbortController();
    this.activeAbortController = controller;
    try {
      return await fn(accessToken, controller.signal);
    } catch (err) {
      if (err instanceof CalendarApiError && err.code === 'CALENDAR_AUTH_REQUIRED') {
        const latestCreds = this.store.credentials(generation);
        if (!latestCreds || !latestCreds.tokens.refreshToken) {
          await this.store.invalidate(generation);
          throw new CalendarApiError('CALENDAR_AUTH_REQUIRED');
        }
        controller.abort();
        if (this.stopped || controller.signal.aborted && this.currentGeneration !== generation) throw err;
        const refreshed = await refreshCalendarTokens({
          store: this.store,
          generation,
          fetch: this.fetchFn,
          nowMs: this.nowMs,
        });
        const retryController = new AbortController();
        this.activeAbortController = retryController;
        try {
          return await fn(refreshed.accessToken, retryController.signal);
        } catch (retryErr) {
          if (retryErr instanceof CalendarApiError && retryErr.code === 'CALENDAR_AUTH_REQUIRED') {
            await this.store.invalidate(generation);
          }
          throw retryErr;
        } finally {
          if (this.activeAbortController === retryController) this.activeAbortController = null;
        }
      }
      throw err;
    } finally {
      if (this.activeAbortController === controller) {
        this.activeAbortController = null;
      }
    }
  }

  private async executeMetadataSync(): Promise<void> {
    const generation = this.currentGeneration;
    const now = this.nowMs();
    this.lastMetadataSyncAtMs = now;

    try {
      const sources = await this.callWithTokenRefresh(generation, (accessToken, signal) =>
        fetchCalendarSourcesAndMetadata({
          accessToken,
          fetch: this.fetchFn,
          nowMs: this.nowMs,
          signal,
        }),
      );

      this.syncConnectionState();
      if (!this.connected || this.currentGeneration !== generation) return;

      const finishNow = this.nowMs();
      for (const source of sources) {
        if (source.labelMetadataRetryAfterMs !== undefined) {
          this.backoffUntilMs = Math.max(this.backoffUntilMs, finishNow + source.labelMetadataRetryAfterMs);
          this.pendingMetadataSync = true;
        }
      }
      this.discoveredSources = sources;
      this.metadataLoaded = true;
      this.metadataState = this.applied ? 'available' : 'setup_required';
      this.metadataErrorCode = null;
      this.metadataRevision = generationId();
      this.lastMetadataSuccessAtMs = finishNow;
      this.sourceCursors.clear();

      // Propose metadata changes without mutating the published range first.
      const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
      for (const rangeEntry of this.cachedRanges.values()) {
        const proposed = new Map(rangeEntry.bySource);
        for (const [sourceId, win] of proposed) {
          const source = sourceById.get(sourceId);
          if (!source) continue;
          const errorCode = source.labelMetadataErrorCode ?? (win.errorCode === 'CALENDAR_UNSUPPORTED' ? win.errorCode : null);
          proposed.set(sourceId, { ...win, events: reapplySourceMetadata(win.events, source, win.rawLabelRefs),
            ...(win.state === 'available' || win.state === 'partial' ? { state: errorCode ? 'partial' as const : 'available' as const, errorCode } : {}) });
        }
        if (sourceWindowBytes(proposed) > Math.min(MAX_CACHE_BYTES, MAX_STAGING_BYTES)) {
          rangeEntry.state = 'capacity'; rangeEntry.errorCode = 'CALENDAR_CAPACITY'; rangeEntry.revision = generationId();
        } else {
          rangeEntry.bySource = proposed;
          this.recomputeRangeFromSources(rangeEntry);
        }
      }
    } catch (err) {
      this.syncConnectionState();
      if (!this.connected || this.currentGeneration !== generation) return;

      const code = err instanceof CalendarApiError ? err.code : err instanceof Error ? err.message : '';
      if (err instanceof CalendarApiError && err.retryAfterMs !== undefined) {
        this.backoffUntilMs = Math.max(this.backoffUntilMs, this.nowMs() + err.retryAfterMs);
        this.pendingMetadataSync = true;
      } else if (code !== 'CALENDAR_CAPACITY' && code !== 'CALENDAR_AUTH_REQUIRED') {
        this.backoffUntilMs = Math.max(this.backoffUntilMs, this.nowMs() + DEFAULT_ERROR_BACKOFF_MS);
        this.pendingMetadataSync = true;
      }

      if (code === 'CALENDAR_AUTH_REQUIRED') {
        await this.store.invalidate(generation);
        this.syncConnectionState();
        return;
      }

      if (code === 'CALENDAR_CAPACITY') {
        this.metadataState = 'capacity';
        this.metadataErrorCode = 'CALENDAR_CAPACITY';
        this.metadataRevision = generationId();
        return;
      }

      this.metadataState = 'error';
      this.metadataErrorCode = 'CALENDAR_UNAVAILABLE';
      for (const entry of this.cachedRanges.values()) this.recomputeRangeFromSources(entry);
    }
  }

  private getOrCreateCachedRange(range: { startDate: string; days: number; timeZone: string }): CachedRange {
    const key = makeRangeKey(range);
    let existing = this.cachedRanges.get(key);
    if (!existing) {
      existing = {
        key,
        range: { ...range },
        revision: generationId(),
        selectionRevision: this.currentSelectionRevision,
        bySource: new Map(),
        events: [],
        lastSuccessAtEpochMs: null,
        lastSyncAttemptAtMs: null,
        state: !this.applied ? 'setup_required' : 'loading',
        errorCode: null,
        approxBytes: 0,
        lastViewedAtMs: this.nowMs(),
      };
      this.cachedRanges.set(key, existing);
      this.evictRangesIfNeeded(key);
    }
    return existing;
  }

  private evictRangesIfNeeded(pinnedKey: string): void {
    const totalBytes = (): number => {
      let sum = 0;
      for (const entry of this.cachedRanges.values()) sum += entry.approxBytes;
      return sum;
    };

    while (this.cachedRanges.size > MAX_CACHED_RANGES || (this.cachedRanges.size > 1 && totalBytes() > MAX_CACHE_BYTES)) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this.cachedRanges.entries()) {
        if (key === pinnedKey) continue;
        if (entry.lastViewedAtMs < oldestTime) {
          oldestTime = entry.lastViewedAtMs;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.cachedRanges.delete(oldestKey);
    }
  }

  private async executeRangeSync(range: { startDate: string; days: number; timeZone: string }): Promise<void> {
    const generation = this.currentGeneration;
    const selectionRevision = this.currentSelectionRevision;
    if (!this.connected || !this.applied) return;

    const rangeEntry = this.getOrCreateCachedRange(range);
    const attemptNow = this.nowMs();
    rangeEntry.lastSyncAttemptAtMs = attemptNow;

    const selectedSources = this.getSelectedReadableSources();
    if (selectedSources.length === 0) {
      rangeEntry.bySource.clear();
      rangeEntry.events = [];
      rangeEntry.lastSuccessAtEpochMs = attemptNow;
      rangeEntry.state = 'available';
      rangeEntry.errorCode = null;
      rangeEntry.revision = generationId();
      rangeEntry.approxBytes = 0;
      return;
    }

    type SourceFetchOutcome =
      | { ok: true; source: DiscoveredCalendarSource; events: CalendarEvent[]; rawLabelRefs: Map<string, RawEventLabelRef>; labelOptInFallback: boolean }
      | { ok: false; source: DiscoveredCalendarSource; code: CalendarErrorCode; retryAfterMs?: number };

    let outcomes: SourceFetchOutcome[];
    try {
      outcomes = await this.callWithTokenRefresh(generation, async (accessToken, signal) => {
    const staging: RangeStagingBudget = {
      occurrences: 0,
      bytes: 0,
      maxOccurrences: MAX_RANGE_OCCURRENCES,
      maxBytes: MAX_STAGING_BYTES,
    };

        return runWithConcurrency(selectedSources, MAX_CONCURRENT_UPSTREAM, async (source): Promise<SourceFetchOutcome> => {
          try {
            const res = await fetchCalendarSourceEvents({
              accessToken,
              source,
              range,
              fetch: this.fetchFn,
              nowMs: this.nowMs,
              signal,
              staging,
            });
            return { ok: true, source, events: res.events, rawLabelRefs: res.rawLabelRefs, labelOptInFallback: res.labelOptInFallback };
          } catch (err) {
            if (err instanceof CalendarApiError && err.code === 'CALENDAR_AUTH_REQUIRED') {
              throw err;
            }
            const code: CalendarErrorCode = err instanceof CalendarApiError ? err.code : 'CALENDAR_UNAVAILABLE';
            const retryAfterMs = err instanceof CalendarApiError ? err.retryAfterMs : undefined;
            return { ok: false, source, code, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
          }
        });
      });
    } catch (err) {
      this.syncConnectionState();
      if (!this.connected || this.currentGeneration !== generation) return;
      const code = err instanceof CalendarApiError ? err.code : err instanceof Error ? err.message : '';
      if (code === 'CALENDAR_AUTH_REQUIRED') {
        await this.store.invalidate(generation);
        this.syncConnectionState();
        return;
      }
      if (rangeEntry.events.length > 0 || rangeEntry.lastSuccessAtEpochMs !== null) {
        rangeEntry.state = 'partial';
        rangeEntry.errorCode = 'CALENDAR_UNAVAILABLE';
      } else {
        rangeEntry.state = 'error';
        rangeEntry.errorCode = 'CALENDAR_UNAVAILABLE';
      }
      return;
    }

    // Reject late results if connection generation or selection revision changed while syncing
    this.syncConnectionState();
    if (!this.connected || this.currentGeneration !== generation || this.currentSelectionRevision !== selectionRevision) {
      return;
    }

    const finishNow = this.nowMs();
    for (const outcome of outcomes) {
      if (!outcome.ok && outcome.retryAfterMs !== undefined) {
        this.backoffUntilMs = Math.max(this.backoffUntilMs, finishNow + outcome.retryAfterMs);
      } else if (!outcome.ok && outcome.code === 'CALENDAR_UNAVAILABLE') {
        this.backoffUntilMs = Math.max(this.backoffUntilMs, finishNow + DEFAULT_ERROR_BACKOFF_MS);
      }
    }

    // If any source breached range staging capacity (or upstream 2 MiB capacity), fail the proposed range
    // while preserving the previous complete range data!
    const hasCapacityBreach = outcomes.some((o) => !o.ok && o.code === 'CALENDAR_CAPACITY');
    if (hasCapacityBreach) {
      rangeEntry.state = 'capacity';
      rangeEntry.errorCode = 'CALENDAR_CAPACITY';
      rangeEntry.revision = generationId();
      for (const outcome of outcomes) {
        if (!outcome.ok && outcome.code === 'CALENDAR_CAPACITY') {
          const prev = rangeEntry.bySource.get(outcome.source.sourceId);
          if (prev) {
            prev.state = 'capacity';
            prev.errorCode = 'CALENDAR_CAPACITY';
          }
          this.sourceStates.set(outcome.source.sourceId, {
            state: 'capacity',
            lastSuccessAtEpochMs: prev?.lastSuccessAtEpochMs ?? null,
            errorCode: 'CALENDAR_CAPACITY',
          });
        }
      }
      return;
    }

    // Per-source complete replacement: successful sources advance, failed sources retain their last complete result
    let anySucceeded = false;
    const proposed = new Map(rangeEntry.bySource);
    for (const outcome of outcomes) {
      const sourceId = outcome.source.sourceId;
      if (outcome.ok) {
        anySucceeded = true;
        proposed.set(sourceId, {
          sourceId,
          events: outcome.events,
          rawLabelRefs: outcome.rawLabelRefs,
          lastSuccessAtEpochMs: finishNow,
          state: outcome.source.labelMetadataErrorCode || outcome.labelOptInFallback ? 'partial' : 'available',
          errorCode: outcome.source.labelMetadataErrorCode ?? (outcome.labelOptInFallback ? 'CALENDAR_UNSUPPORTED' : null),
        });
      } else {
        const previous = rangeEntry.bySource.get(sourceId);
        proposed.set(sourceId, {
          sourceId,
          events: previous ? previous.events : [],
          rawLabelRefs: previous ? previous.rawLabelRefs : new Map(),
          lastSuccessAtEpochMs: previous?.lastSuccessAtEpochMs ?? null,
          state: 'error',
          errorCode: outcome.code,
        });
      }
    }

    const proposedCount = [...proposed.values()].reduce((sum, win) => sum + win.events.length, 0);
    if (proposedCount > MAX_RANGE_OCCURRENCES || sourceWindowBytes(proposed) > Math.min(MAX_STAGING_BYTES, MAX_CACHE_BYTES)) {
      rangeEntry.state = 'capacity';
      rangeEntry.errorCode = 'CALENDAR_CAPACITY';
      rangeEntry.revision = generationId();
      return;
    }
    rangeEntry.bySource = proposed;
    for (const [sourceId, win] of proposed) this.sourceStates.set(sourceId, { state: win.state, errorCode: win.errorCode, lastSuccessAtEpochMs: win.lastSuccessAtEpochMs });
    if (anySucceeded) {
      rangeEntry.lastSuccessAtEpochMs = finishNow;
    }
    this.recomputeRangeFromSources(rangeEntry);
    this.evictRangesIfNeeded(rangeEntry.key);
  }

  private maybeSchedulePeriodicSync(rangeEntry?: CachedRange): void {
    if (!this.connected) return;
    const now = this.nowMs();
    if (now < this.backoffUntilMs) return;

    if (
      this.lastMetadataSyncAtMs === null ||
      now - this.lastMetadataSyncAtMs >= METADATA_REFRESH_MS
    ) {
      this.queueMetadataSync();
    }

    if (this.applied && rangeEntry) {
      const interval = this.phoneActiveFn() ? ACTIVE_EVENT_REFRESH_MS : IDLE_EVENT_REFRESH_MS;
      if (
        rangeEntry.lastSyncAttemptAtMs === null ||
        now - rangeEntry.lastSyncAttemptAtMs >= interval
      ) {
        this.queueRangeSync(rangeEntry.range);
      }
    }

    if (this.pendingMetadataSync || (this.applied && this.pendingRangeRequest !== null)) {
      this.ensureWorkerRunning();
    }
  }

  private pruneExpiredCursors(now: number): void {
    for (const [token, rec] of this.rangeCursors.entries()) {
      if (now - rec.issuedAtMs > CURSOR_TTL_MS) this.rangeCursors.delete(token);
    }
    for (const [token, rec] of this.sourceCursors.entries()) {
      if (now - rec.issuedAtMs > CURSOR_TTL_MS) this.sourceCursors.delete(token);
    }
  }

  read(request: CalendarRangeRequest): CalendarPage {
    const parsed = CalendarRangeRequestSchema.parse(request);
    const now = this.nowMs();
    this.syncConnectionState();
    this.pruneExpiredCursors(now);

    const range = { startDate: parsed.startDate, days: parsed.days, timeZone: parsed.timeZone };
    this.lastRequestedRange = range;

    if (this.storageError) {
      return {
        v: 1,
        state: 'error',
        errorCode: 'CALENDAR_UNAVAILABLE',
        serverNowEpochMs: now,
        range,
        revision: 'error',
        selectionRevision: this.currentSelectionRevision,
        lastSuccessAtEpochMs: null,
        sourceCount: 0,
        failedSourceCount: 0,
        sources: [],
        items: [],
        nextEvent: null,
        nextCursor: null,
      };
    }

    if (!this.connected) {
      return {
        v: 1,
        state: this.authRequired ? 'auth_required' : 'disabled',
        errorCode: this.authRequired ? 'CALENDAR_AUTH_REQUIRED' : null,
        serverNowEpochMs: now,
        range,
        revision: this.authRequired ? 'auth_required' : 'disabled',
        selectionRevision: this.currentSelectionRevision,
        lastSuccessAtEpochMs: null,
        sourceCount: 0,
        failedSourceCount: 0,
        sources: [],
        items: [],
        nextEvent: null,
        nextCursor: null,
      };
    }

    if (this.metadataState === 'capacity') {
      if (
        parsed.refresh === true &&
        (this.lastManualRefreshAtMs === null || now - this.lastManualRefreshAtMs >= MANUAL_REFRESH_COALESCE_MS) &&
        now >= this.backoffUntilMs
      ) {
        this.lastManualRefreshAtMs = now;
        this.queueMetadataSync();
        if (this.applied) this.queueRangeSync(range, true);
      }
      return {
        v: 1,
        state: 'capacity',
        errorCode: 'CALENDAR_CAPACITY',
        serverNowEpochMs: now,
        range,
        revision: this.metadataRevision,
        selectionRevision: this.currentSelectionRevision,
        lastSuccessAtEpochMs: null,
        sourceCount: 0,
        failedSourceCount: 0,
        sources: [],
        items: [],
        nextEvent: null,
        nextCursor: null,
      };
    }

    if (!this.applied) {
      if (parsed.refresh === true) {
        if (
          (this.lastManualRefreshAtMs === null || now - this.lastManualRefreshAtMs >= MANUAL_REFRESH_COALESCE_MS) &&
          now >= this.backoffUntilMs
        ) {
          this.lastManualRefreshAtMs = now;
          this.queueMetadataSync();
        }
      } else {
        this.maybeSchedulePeriodicSync();
      }

      const setupSources = this.discoveredSources.map((s) => this.toProtocolSource(s));
      const state: CalendarState =
        this.metadataState === 'error' && !this.metadataLoaded ? 'error' : 'setup_required';
      const errorCode: CalendarErrorCode | null =
        state === 'error' ? 'CALENDAR_UNAVAILABLE' : null;

      return {
        v: 1,
        state,
        errorCode,
        serverNowEpochMs: now,
        range,
        revision: this.metadataRevision,
        selectionRevision: this.currentSelectionRevision,
        lastSuccessAtEpochMs: this.lastMetadataSuccessAtMs,
        sourceCount: Math.min(100, setupSources.length),
        failedSourceCount: 0,
        sources: setupSources.slice(0, MAX_PAGE_SOURCES),
        items: [],
        nextEvent: null,
        nextCursor: null,
      };
    }

    const rangeEntry = this.getOrCreateCachedRange(range);
    rangeEntry.lastViewedAtMs = now;

    if (parsed.refresh === true) {
      // Explicit refresh immediately invalidates any active cursor for this range
      rangeEntry.revision = generationId();
      if (
        (this.lastManualRefreshAtMs === null || now - this.lastManualRefreshAtMs >= MANUAL_REFRESH_COALESCE_MS) &&
        now >= this.backoffUntilMs
      ) {
        this.lastManualRefreshAtMs = now;
        this.queueMetadataSync();
        this.queueRangeSync(range);
      }
    } else {
      this.maybeSchedulePeriodicSync(rangeEntry);
    }

    const selectedReadable = this.getSelectedReadableSources();
    const allSelectedSources = this.discoveredSources
      .filter((s) => this.selectedIds.has(s.sourceId))
      .map((s) => this.toProtocolSource(s, rangeEntry));
    const sourceCount = Math.min(100, allSelectedSources.length);
    const failedSourceCount = Math.min(
      100,
      allSelectedSources.filter((s) => s.state === 'error' || s.state === 'capacity' || s.state === 'partial').length,
    );
    const nextEvent = computeNextEvent(rangeEntry.events, now);

    let offset = 0;
    if (parsed.cursor !== undefined) {
      const parts = parsed.cursor.split('.');
      const cursorSelRev = parts[0]?.startsWith('cur_') ? parts[0].slice(4) : '';
      if (cursorSelRev && cursorSelRev !== this.currentSelectionRevision) {
        return {
          v: 1,
          state: 'error',
          errorCode: 'CALENDAR_SELECTION_CHANGED',
          serverNowEpochMs: now,
          range,
          revision: rangeEntry.revision,
          selectionRevision: this.currentSelectionRevision,
          lastSuccessAtEpochMs: rangeEntry.lastSuccessAtEpochMs,
          sourceCount,
          failedSourceCount,
          sources: allSelectedSources.slice(0, MAX_PAGE_SOURCES),
          items: [],
          nextEvent,
          nextCursor: null,
        };
      }

      const rec = this.rangeCursors.get(parsed.cursor);
      if (!rec || rec.selectionRevision !== this.currentSelectionRevision) {
        const code: CalendarErrorCode =
          rec && rec.selectionRevision !== this.currentSelectionRevision
            ? 'CALENDAR_SELECTION_CHANGED'
            : 'CALENDAR_CURSOR_EXPIRED';
        return {
          v: 1,
          state: 'error',
          errorCode: code,
          serverNowEpochMs: now,
          range,
          revision: rangeEntry.revision,
          selectionRevision: this.currentSelectionRevision,
          lastSuccessAtEpochMs: rangeEntry.lastSuccessAtEpochMs,
          sourceCount,
          failedSourceCount,
          sources: allSelectedSources.slice(0, MAX_PAGE_SOURCES),
          items: [],
          nextEvent,
          nextCursor: null,
        };
      }

      if (rec.rangeKey !== rangeEntry.key || rec.revision !== rangeEntry.revision || now - rec.issuedAtMs > CURSOR_TTL_MS) {
        return {
          v: 1,
          state: 'error',
          errorCode: 'CALENDAR_CURSOR_EXPIRED',
          serverNowEpochMs: now,
          range,
          revision: rangeEntry.revision,
          selectionRevision: this.currentSelectionRevision,
          lastSuccessAtEpochMs: rangeEntry.lastSuccessAtEpochMs,
          sourceCount,
          failedSourceCount,
          sources: allSelectedSources.slice(0, MAX_PAGE_SOURCES),
          items: [],
          nextEvent,
          nextCursor: null,
        };
      }

      offset = rec.offset;
    }

    const sourceById = new Map(allSelectedSources.map((s) => [s.sourceId, s]));
    const pageItems: CalendarEvent[] = [];
    const requiredSourceIds = new Set<string>();

    const buildPageSources = (neededIds: ReadonlySet<string>): CalendarSource[] => {
      const result: CalendarSource[] = [];
      const included = new Set<string>();
      for (const id of neededIds) {
        const src = sourceById.get(id);
        if (src) {
          result.push(src);
          included.add(id);
        }
      }
      for (const src of allSelectedSources) {
        if (result.length >= MAX_PAGE_SOURCES) break;
        if (!included.has(src.sourceId)) {
          result.push(src);
          included.add(src.sourceId);
        }
      }
      return result;
    };

    const placeholderCursor = `cur_${this.currentSelectionRevision}.${rangeEntry.revision}.99999.${'x'.repeat(16)}`;

    for (let i = offset; i < rangeEntry.events.length && pageItems.length < MAX_PAGE_ITEMS; i++) {
      const candidateItem = rangeEntry.events[i]!;
      if (!requiredSourceIds.has(candidateItem.sourceId) && requiredSourceIds.size >= MAX_PAGE_SOURCES) {
        break;
      }
      const nextRequired = new Set(requiredSourceIds);
      nextRequired.add(candidateItem.sourceId);
      const candidateItems = [...pageItems, candidateItem];
      const candidateSources = buildPageSources(nextRequired);

      const candidatePage: CalendarPage = {
        v: 1,
        state: rangeEntry.state,
        errorCode: rangeEntry.errorCode,
        serverNowEpochMs: now,
        range,
        revision: rangeEntry.revision,
        selectionRevision: this.currentSelectionRevision,
        lastSuccessAtEpochMs: rangeEntry.lastSuccessAtEpochMs,
        sourceCount,
        failedSourceCount,
        sources: candidateSources,
        items: candidateItems,
        nextEvent,
        nextCursor: placeholderCursor,
      };

      if (Buffer.byteLength(JSON.stringify(candidatePage), 'utf8') > MAX_PAGE_SERIALIZED_BYTES) {
        break;
      }

      pageItems.push(candidateItem);
      requiredSourceIds.add(candidateItem.sourceId);
    }

    let nextCursor: string | null = null;
    const nextOffset = offset + pageItems.length;
    if (nextOffset < rangeEntry.events.length && pageItems.length > 0) {
      nextCursor = `cur_${this.currentSelectionRevision}.${rangeEntry.revision}.${nextOffset}.${randomBytes(9).toString('base64url')}`;
      this.rangeCursors.set(nextCursor, {
        rangeKey: rangeEntry.key,
        revision: rangeEntry.revision,
        selectionRevision: this.currentSelectionRevision,
        offset: nextOffset,
        issuedAtMs: now,
      });
    }

    const metadataFailed = this.metadataState === 'error' || !this.metadataLoaded;
    const finalState: CalendarState = metadataFailed ? rangeEntry.lastSuccessAtEpochMs !== null ? 'partial' : this.metadataState === 'error' ? 'error' : 'loading' : rangeEntry.state;
    const finalError = metadataFailed ? this.metadataErrorCode : rangeEntry.errorCode;

    return {
      v: 1,
      state: finalState,
      errorCode: finalError,
      serverNowEpochMs: now,
      range,
      revision: rangeEntry.revision,
      selectionRevision: this.currentSelectionRevision,
      lastSuccessAtEpochMs: rangeEntry.lastSuccessAtEpochMs,
      sourceCount,
      failedSourceCount,
      sources: buildPageSources(requiredSourceIds),
      items: pageItems,
      nextEvent,
      nextCursor,
    };
  }

  sources(request: CalendarSourcesRequest = {}): CalendarSourcesPage {
    const parsed = CalendarSourcesRequestSchema.parse(request);
    const now = this.nowMs();
    this.syncConnectionState();
    this.pruneExpiredCursors(now);

    if (this.storageError) {
      return {
        v: 1,
        state: 'error',
        errorCode: 'CALENDAR_UNAVAILABLE',
        serverNowEpochMs: now,
        selectionRevision: this.currentSelectionRevision,
        sources: [],
        nextCursor: null,
      };
    }

    if (!this.connected) {
      return {
        v: 1,
        state: this.authRequired ? 'auth_required' : 'disabled',
        errorCode: this.authRequired ? 'CALENDAR_AUTH_REQUIRED' : null,
        serverNowEpochMs: now,
        selectionRevision: this.currentSelectionRevision,
        sources: [],
        nextCursor: null,
      };
    }

    this.maybeSchedulePeriodicSync();

    if (this.metadataState === 'capacity') {
      return {
        v: 1,
        state: 'capacity',
        errorCode: 'CALENDAR_CAPACITY',
        serverNowEpochMs: now,
        selectionRevision: this.currentSelectionRevision,
        sources: [],
        nextCursor: null,
      };
    }

    if (!this.metadataLoaded) {
      const state: CalendarState = this.metadataState === 'error' ? 'error' : !this.applied ? 'setup_required' : 'loading';
      const errorCode: CalendarErrorCode | null = state === 'error' ? 'CALENDAR_UNAVAILABLE' : null;
      return {
        v: 1,
        state,
        errorCode,
        serverNowEpochMs: now,
        selectionRevision: this.currentSelectionRevision,
        sources: [],
        nextCursor: null,
      };
    }

    let offset = 0;
    if (parsed.cursor !== undefined) {
      const parts = parsed.cursor.split('.');
      const cursorSelRev = parts[0]?.startsWith('scur_') ? parts[0].slice(5) : '';
      if (cursorSelRev && cursorSelRev !== this.currentSelectionRevision) {
        return {
          v: 1,
          state: 'error',
          errorCode: 'CALENDAR_SELECTION_CHANGED',
          serverNowEpochMs: now,
          selectionRevision: this.currentSelectionRevision,
          sources: [],
          nextCursor: null,
        };
      }

      const rec = this.sourceCursors.get(parsed.cursor);
      if (!rec || rec.selectionRevision !== this.currentSelectionRevision) {
        return {
          v: 1,
          state: 'error',
          errorCode:
            rec && rec.selectionRevision !== this.currentSelectionRevision
              ? 'CALENDAR_SELECTION_CHANGED'
              : 'CALENDAR_CURSOR_EXPIRED',
          serverNowEpochMs: now,
          selectionRevision: this.currentSelectionRevision,
          sources: [],
          nextCursor: null,
        };
      }
      if (rec.metadataRevision !== this.metadataRevision || now - rec.issuedAtMs > CURSOR_TTL_MS) {
        return {
          v: 1,
          state: 'error',
          errorCode: 'CALENDAR_CURSOR_EXPIRED',
          serverNowEpochMs: now,
          selectionRevision: this.currentSelectionRevision,
          sources: [],
          nextCursor: null,
        };
      }
      offset = rec.offset;
    }

    const allSources = this.discoveredSources.map((s) => this.toProtocolSource(s));
    const pageSources = allSources.slice(offset, offset + MAX_PAGE_SOURCES);
    let nextCursor: string | null = null;
    const nextOffset = offset + pageSources.length;
    if (nextOffset < allSources.length && pageSources.length > 0) {
      nextCursor = `scur_${this.currentSelectionRevision}.${this.metadataRevision}.${nextOffset}.${randomBytes(9).toString('base64url')}`;
      this.sourceCursors.set(nextCursor, {
        selectionRevision: this.currentSelectionRevision,
        metadataRevision: this.metadataRevision,
        offset: nextOffset,
        issuedAtMs: now,
      });
    }

    return {
      v: 1,
      state: !this.applied ? 'setup_required' : this.metadataState === 'error' || allSources.some(s => s.selected && s.state === 'partial') ? 'partial' : 'available',
      errorCode: this.metadataState === 'error' ? this.metadataErrorCode : allSources.find(s => s.selected && s.state === 'partial')?.errorCode ?? null,
      serverNowEpochMs: now,
      selectionRevision: this.currentSelectionRevision,
      sources: pageSources,
      nextCursor,
    };
  }

  async select(request: CalendarSelectRequest): Promise<CalendarSelectReply> {
    const parsed = CalendarSelectRequestSchema.parse(request);
    this.syncConnectionState();

    if (this.storageError) {
      throw Error('CALENDAR_UNAVAILABLE');
    }
    if (!this.connected) {
      throw Error('CALENDAR_AUTH_REQUIRED');
    }
    if (this.metadataState === 'capacity') {
      throw Error('CALENDAR_CAPACITY');
    }
    if (parsed.expectedRevision !== this.currentSelectionRevision) {
      throw Error('CALENDAR_SELECTION_CHANGED');
    }

    if (this.metadataLoaded) {
      const readableIds = new Set(
        this.discoveredSources.filter((s) => s.capability === 'read').map((s) => s.sourceId),
      );
      for (const id of parsed.sourceIds) {
        if (!readableIds.has(id)) {
          throw Error('BAD_PAYLOAD');
        }
      }
    }

    const selectionRevision = await this.store.applySelection(
      this.currentGeneration,
      parsed.expectedRevision,
      parsed.sourceIds,
    );
    this.applySelectionStateToMemory(selectionRevision, true, parsed.sourceIds);

    if (this.lastRequestedRange) {
      this.queueRangeSync(this.lastRequestedRange, true);
    }

    return { selectionRevision };
  }
}
