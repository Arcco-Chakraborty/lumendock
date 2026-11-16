import type {
  CalendarEvent,
  CalendarPage,
  CalendarRangeRequest,
  CalendarSource,
  CalendarState,
  ErrorCode,
} from "@phone-monitor/protocol";
import {
  DeviceError,
  systemClock,
  type Clock,
  type DeviceAdapter,
} from "../device.js";
import { dateInZone, defaultTimeZone } from "./time.js";

export interface CalendarRange {
  startDate: string;
  days: number;
  timeZone: string;
}

export interface CalendarSnapshot {
  clearRevision: number;
  range: CalendarRange;
  page: CalendarPage | null;
  items: CalendarEvent[];
  sources: CalendarSource[];
  sourcesState: CalendarState | null;
  sourcesErrorCode: ErrorCode | null;
  selectionRevision: string | null;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  loadingSources: boolean;
  selecting: boolean;
  offline: boolean;
  stale: boolean;
  ageMs: number | null;
  lastSuccessAtEpochMs: number | null;
  nowEpochMs: number;
  errorCode: ErrorCode | null;
}

const ACTIVE_POLL_MS = 5000;
const LOADING_POLL_MS = 2000;
const STALE_THRESHOLD_MS = 180_000;

function defaultRange(): CalendarRange {
  const timeZone = defaultTimeZone();
  return {
    startDate: dateInZone(Date.now(), timeZone),
    days: 7,
    timeZone,
  };
}

export class CalendarStore {
  private range: CalendarRange;
  private page: CalendarPage | null = null;
  private items: CalendarEvent[] = [];
  private pageSources: CalendarSource[] = [];
  private enumeratedSources: CalendarSource[] | null = null;
  private sourcesState: CalendarState | null = null;
  private sourcesErrorCode: ErrorCode | null = null;
  private selectionRevision: string | null = null;
  private requiredSelectionRevision: string | null = null;
  private nextCursor: string | null = null;
  private hasLoadedMore = false;
  private loading = false;
  private loadingMore = false;
  private loadingSources = false;
  private selecting = false;
  private offline = false;
  private linkStale = false;
  private linkAgeMs: number | null = null;
  private linkReceivedAt = 0;
  private serverNowAnchor: number | null = null;
  private serverNowAt = 0;
  private errorCode: ErrorCode | null = null;
  private active = false;
  private visible = true;
  private disposed = false;
  private generation = 0;
  private datasetVersion = 0;
  private sourceGeneration = 0;
  private readRequest = 0;
  private clearRevision = 0;
  private followToday: boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private contextListeners = new Set<(context: string) => void>();
  private contextKey: string | null = null;
  private cached: CalendarSnapshot | null = null;
  private cachedAt = -1;

  constructor(
    private readonly adapter: DeviceAdapter | null | undefined,
    initialRange?: CalendarRange,
    private readonly clock: Clock = systemClock,
  ) {
    this.followToday = initialRange === undefined;
    initialRange ??= defaultRange();
    this.range = {
      startDate: initialRange.startDate,
      days: Math.min(31, Math.max(1, Math.trunc(initialRange.days))),
      timeZone: initialRange.timeZone,
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Share account/selection invalidation without sharing either view's date range. */
  subscribeContext = (listener: (context: string) => void) => {
    this.contextListeners.add(listener);
    if (this.contextKey !== null) listener(this.contextKey);
    return () => { this.contextListeners.delete(listener); };
  };

  private publishContext(selectionRevision: string | null, state: CalendarState) {
    const access = ["disabled", "setup_required", "auth_required"].includes(state) ? state : "ready";
    const key = `${selectionRevision ?? "unpaired"}:${access}`;
    if (key === this.contextKey) return;
    this.contextKey = key;
    for (const listener of this.contextListeners) listener(key);
  }

  /** Reject in-flight replies and erase identities learned under a superseded context. */
  invalidate() {
    if (this.disposed) return;
    this.generation += 1;
    this.datasetVersion += 1;
    this.readRequest += 1;
    this.clearRevision += 1;
    this.contextKey = null;
    this.page = null;
    this.items = [];
    this.pageSources = [];
    this.nextCursor = null;
    this.hasLoadedMore = false;
    this.loading = false;
    this.loadingMore = false;
    this.selecting = false;
    this.selectionRevision = null;
    this.requiredSelectionRevision = null;
    this.errorCode = null;
    this.resetSources();
    this.notify();
  }

  private notify() {
    this.cached = null;
    for (const listener of this.listeners) listener();
  }

  snapshot = (): CalendarSnapshot => {
    const now = this.clock.now();
    if (this.cached && Math.abs(now - this.cachedAt) < 1000) {
      return this.cached;
    }
    this.cachedAt = now;
    const elapsedSinceAnchor =
      this.serverNowAnchor === null ? 0 : Math.max(0, now - this.serverNowAt);
    const nowEpochMs =
      this.serverNowAnchor === null
        ? Date.now()
        : this.serverNowAnchor + elapsedSinceAnchor;
    const ageMs =
      this.linkAgeMs === null
        ? null
        : this.linkAgeMs + Math.max(0, now - this.linkReceivedAt);
    const lastSuccessAtEpochMs = this.page?.lastSuccessAtEpochMs ?? null;
    const syncAgeMs =
      lastSuccessAtEpochMs === null
        ? ageMs
        : Math.max(0, nowEpochMs - lastSuccessAtEpochMs);
    const stale =
      this.offline ||
      this.linkStale ||
      (syncAgeMs !== null && syncAgeMs >= STALE_THRESHOLD_MS);
    const sources =
      this.enumeratedSources !== null
        ? this.enumeratedSources
        : this.pageSources;
    this.cached = {
      clearRevision: this.clearRevision,
      range: this.range,
      page: this.page,
      items: this.items,
      sources,
      sourcesState: this.sourcesState ?? this.page?.state ?? null,
      sourcesErrorCode: this.sourcesErrorCode,
      selectionRevision:
        this.selectionRevision ?? this.page?.selectionRevision ?? null,
      nextCursor: this.nextCursor,
      loading: this.loading,
      loadingMore: this.loadingMore,
      loadingSources: this.loadingSources,
      selecting: this.selecting,
      offline: this.offline,
      stale,
      ageMs: syncAgeMs,
      lastSuccessAtEpochMs,
      nowEpochMs,
      errorCode: this.errorCode,
    };
    return this.cached;
  };

  setActive(active: boolean) {
    if (this.disposed || this.active === active) return;
    this.active = active;
    this.syncLoop();
  }

  setVisible(visible: boolean) {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.syncLoop();
  }

  setRange(nextRange: CalendarRange) {
    this.followToday = false;
    this.changeRange(nextRange);
  }

  setToday() {
    this.followToday = true;
    this.changeRange({ ...this.range, startDate: dateInZone(this.snapshot().nowEpochMs, this.range.timeZone) });
  }

  private changeRange(nextRange: CalendarRange) {
    if (this.disposed) return;
    const days = Math.min(31, Math.max(1, Math.trunc(nextRange.days)));
    if (
      nextRange.startDate === this.range.startDate &&
      days === this.range.days &&
      nextRange.timeZone === this.range.timeZone
    ) {
      return;
    }
    this.generation += 1;
    this.datasetVersion += 1;
    this.loadingMore = false;
    this.range = {
      startDate: nextRange.startDate,
      days,
      timeZone: nextRange.timeZone,
    };
    this.page = null;
    this.items = [];
    this.pageSources = [];
    this.nextCursor = null;
    this.hasLoadedMore = false;
    this.errorCode = null;
    this.notify();
    if (this.active && this.visible) {
      this.clearTimer();
      void this.readPage(false);
      this.schedule();
    }
  }

  async refresh(): Promise<void> {
    if (this.disposed || !this.adapter || this.selecting) return;
    this.generation += 1;
    this.nextCursor = null;
    this.hasLoadedMore = false;
    this.clearTimer();
    await this.readPage(true);
    if (this.active && this.visible && !this.disposed) {
      this.schedule();
    }
  }

  async loadMore(): Promise<void> {
    if (
      this.disposed ||
      !this.adapter ||
      !this.nextCursor ||
      this.selecting ||
      this.loadingMore
    ) {
      return;
    }
    const cursor = this.nextCursor;
    const reqGen = this.generation;
    const datasetVersion = this.datasetVersion;
    const expectedRev = this.page?.revision ?? null;
    const expectedSel =
      this.page?.selectionRevision ?? this.selectionRevision ?? null;
    this.loadingMore = true;
    this.notify();
    try {
      const link = await this.adapter.request("hub.calendar", {
        startDate: this.range.startDate,
        days: this.range.days,
        timeZone: this.range.timeZone,
        cursor,
      });
      if (this.disposed || reqGen !== this.generation || datasetVersion !== this.datasetVersion) return;
      if (!link.data) {
        this.applyLinkFailure(link.errorCode ?? "HUB_UNAVAILABLE");
        return;
      }
      const data = link.data;
      if (
        data.range.startDate !== this.range.startDate ||
        data.range.days !== this.range.days ||
        data.range.timeZone !== this.range.timeZone
      ) {
        return;
      }
      if (
        data.errorCode === "CALENDAR_CURSOR_EXPIRED" ||
        data.errorCode === "CALENDAR_SELECTION_CHANGED" ||
        (expectedRev !== null && data.revision !== expectedRev) ||
        (expectedSel !== null && data.selectionRevision !== expectedSel)
      ) {
        this.nextCursor = null;
        this.hasLoadedMore = false;
        this.loadingMore = false;
        await this.readPage(false);
        return;
      }
      this.recordTiming(data.serverNowEpochMs, link.ageMs, link.stale, link.state);
      const seen = new Set(this.items.map((item) => `${item.sourceId}:${item.id}`));
      const merged = [...this.items];
      for (const item of data.items) {
        const key = `${item.sourceId}:${item.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(item);
        }
      }
      const sourceMap = new Map(
        this.pageSources.map((source) => [source.sourceId, source]),
      );
      for (const source of data.sources) {
        sourceMap.set(source.sourceId, source);
      }
      this.items = merged;
      this.pageSources = [...sourceMap.values()];
      this.nextCursor = data.nextCursor;
      this.hasLoadedMore = true;
      this.page = data;
      this.publishContext(data.selectionRevision, data.state);
      this.selectionRevision = data.selectionRevision;
      this.errorCode = data.errorCode ?? link.errorCode;
    } catch (error) {
      if (this.disposed || reqGen !== this.generation || datasetVersion !== this.datasetVersion) return;
      const code = error instanceof DeviceError ? error.code : "BAD_PAYLOAD";
      if (
        code === "CALENDAR_CURSOR_EXPIRED" ||
        code === "CALENDAR_SELECTION_CHANGED"
      ) {
        this.nextCursor = null;
        this.hasLoadedMore = false;
        this.loadingMore = false;
        await this.readPage(false);
        return;
      }
      this.applyLinkFailure(code);
    } finally {
      if (!this.disposed && reqGen === this.generation && datasetVersion === this.datasetVersion) {
        this.loadingMore = false;
        this.notify();
      }
    }
  }

  async loadSources(): Promise<void> {
    if (this.disposed || !this.adapter || this.loadingSources || this.selecting) return;
    const reqGen = this.generation;
    const sourceGen = this.sourceGeneration;
    this.loadingSources = true;
    this.sourcesErrorCode = null;
    this.notify();
    try {
      const collected: CalendarSource[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let expectedSelectionRevision: string | null = null;
      for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
        const link = await (cursor
          ? this.adapter.request("hub.calendarSources", { cursor })
          : this.adapter.request("hub.calendarSources"));
        if (this.disposed || reqGen !== this.generation || sourceGen !== this.sourceGeneration) return;
        if (!link.data) {
          this.sourcesErrorCode = link.errorCode ?? "HUB_UNAVAILABLE";
          break;
        }
        const data = link.data;
        this.recordTiming(
          data.serverNowEpochMs,
          link.ageMs,
          link.stale,
          link.state,
        );
        if (
          expectedSelectionRevision !== null &&
          data.selectionRevision !== expectedSelectionRevision
        ) {
          // Selection revision changed mid-enumeration; restart once cleanly.
          collected.length = 0;
          seen.clear();
          expectedSelectionRevision = null;
          cursor = undefined;
          continue;
        }
        expectedSelectionRevision = data.selectionRevision;
        this.publishContext(data.selectionRevision, data.state);
        this.sourcesState = data.state;
        this.sourcesErrorCode = data.errorCode ?? link.errorCode;
        for (const source of data.sources) {
          if (!seen.has(source.sourceId)) {
            seen.add(source.sourceId);
            collected.push(source);
          }
        }
        if (!data.nextCursor) break;
        cursor = data.nextCursor;
      }
      if (this.selectionRevision !== null && expectedSelectionRevision !== null && this.selectionRevision !== expectedSelectionRevision) {
        this.datasetVersion += 1;
        this.nextCursor = null;
        this.loadingMore = false;
        this.hasLoadedMore = false;
        const allowed = new Set(collected.filter(source => source.selected).map(source => source.sourceId));
        this.items = this.items.filter(item => allowed.has(item.sourceId));
        if (this.page) this.page = { ...this.page, nextEvent: this.page.nextEvent && allowed.has(this.page.nextEvent.sourceId) ? this.page.nextEvent : null };
      }
      this.selectionRevision = expectedSelectionRevision ?? this.selectionRevision;
      this.enumeratedSources = collected;
    } catch (error) {
      if (this.disposed || reqGen !== this.generation || sourceGen !== this.sourceGeneration) return;
      const code = error instanceof DeviceError ? error.code : "BAD_PAYLOAD";
      this.sourcesErrorCode = code;
      if (code === "CALENDAR_UNSUPPORTED") {
        this.errorCode = code;
      }
    } finally {
      if (!this.disposed && reqGen === this.generation && sourceGen === this.sourceGeneration) {
        this.loadingSources = false;
        this.notify();
      }
    }
  }

  async selectSources(sourceIds: string[]): Promise<boolean> {
    if (this.disposed || !this.adapter || this.selecting || this.loadingSources || this.selectionRevision === null) return false;
    const uniqueIds = [...new Set(sourceIds)].slice(0, 100);
    const allowed = new Set(uniqueIds);
    const expectedRevision =
      this.selectionRevision ??
      this.page?.selectionRevision ??
      "initial_selection";
    this.generation += 1;
    this.datasetVersion += 1;
    this.loadingMore = false;
    this.loading = false;
    this.clearTimer();
    const selectGen = this.generation;
    this.selecting = true;
    this.nextCursor = null;
    this.hasLoadedMore = false;
    this.items = this.items.filter((item) => allowed.has(item.sourceId));
    if (this.page) {
      const nextEvent =
        this.page.nextEvent && allowed.has(this.page.nextEvent.sourceId)
          ? this.page.nextEvent
          : null;
      this.page = {
        ...this.page,
        items: this.items,
        nextEvent,
        nextCursor: null,
      };
    }
    if (this.enumeratedSources) {
      this.enumeratedSources = this.enumeratedSources.map((source) => ({
        ...source,
        selected: allowed.has(source.sourceId),
      }));
    }
    this.pageSources = this.pageSources.map((source) => ({
      ...source,
      selected: allowed.has(source.sourceId),
    }));
    this.notify();
    try {
      const reply = await this.adapter.request("hub.calendarSelect", {
        sourceIds: uniqueIds,
        expectedRevision,
      });
      if (this.disposed || selectGen !== this.generation) return false;
      this.publishContext(reply.selectionRevision, "available");
      this.selectionRevision = reply.selectionRevision;
      this.requiredSelectionRevision = reply.selectionRevision;
      if (this.page?.state === "setup_required") {
        this.page = {
          ...this.page,
          state: "loading",
          selectionRevision: reply.selectionRevision,
        };
      }
      if (this.sourcesState === "setup_required") {
        this.sourcesState = "available";
      }
      this.errorCode = null;
      this.sourcesErrorCode = null;
      return true;
    } catch (error) {
      if (this.disposed || selectGen !== this.generation) return false;
      const code = error instanceof DeviceError ? error.code : "BAD_PAYLOAD";
      // Re-read authoritative preferences after a rejected/uncertain transaction.
      this.selecting = false;
      this.requiredSelectionRevision = null;
      this.enumeratedSources = null;
      await this.readPage(false);
      await this.loadSources();
      this.errorCode = code;
      this.sourcesErrorCode = code;
      return false;
    } finally {
      if (!this.disposed) {
        this.selecting = false;
        this.notify();
        if (this.active && this.visible && selectGen === this.generation) {
          void this.readPage(false);
          this.schedule();
        }
      }
    }
  }

  private syncLoop() {
    this.clearTimer();
    if (this.active && this.visible && !this.disposed && this.adapter) {
      void this.readPage(false);
      this.schedule();
    }
  }

  private clearTimer() {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule() {
    this.clearTimer();
    if (!this.active || !this.visible || this.disposed || !this.adapter || this.selecting) return;
    const delay =
      this.page?.state === "loading" ? LOADING_POLL_MS : ACTIVE_POLL_MS;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (!this.active || !this.visible || this.disposed) return;
      void this.readPage(false).finally(() => {
        if (this.active && this.visible && !this.disposed) {
          this.schedule();
        }
      });
    }, delay);
  }

  private recordTiming(
    serverNowEpochMs: number,
    ageMs: number | null,
    stale: boolean,
    linkState: string,
  ) {
    const now = this.clock.now();
    const currentEstimated =
      this.serverNowAnchor === null
        ? 0
        : this.serverNowAnchor + Math.max(0, now - this.serverNowAt);
    this.serverNowAnchor = Math.max(
      currentEstimated,
      // Link age is native receipt age, never the upstream last-success age.
      serverNowEpochMs + (ageMs ?? 0),
    );
    this.serverNowAt = now;
    this.linkAgeMs = ageMs;
    this.linkReceivedAt = now;
    this.linkStale = stale;
    this.offline = linkState === "disconnected" || linkState === "error";
  }

  private applyLinkFailure(code: ErrorCode) {
    this.errorCode = code;
    if (code === "CALENDAR_UNSUPPORTED") {
      this.offline = false;
      this.items = [];
      this.page = null;
      this.nextCursor = null;
      return;
    }
    if (code === "AUTH_REQUIRED") {
      this.publishContext(null, "auth_required");
      this.offline = false;
      this.items = [];
      this.page = null;
      this.nextCursor = null;
      this.resetSources();
      this.clearRevision += 1;
      return;
    }
    // USB / bridge / hub connectivity failures keep session cached rows intact.
    this.offline = true;
    this.linkStale = true;
  }

  private async readPage(refresh: boolean): Promise<void> {
    if (this.disposed || !this.adapter || this.selecting) return;
    if (this.followToday) {
      const today = dateInZone(this.snapshot().nowEpochMs, this.range.timeZone);
      if (today !== this.range.startDate) {
        this.changeRange({ ...this.range, startDate: today });
        return;
      }
    }
    const reqGen = this.generation;
    const requestId = ++this.readRequest;
    const requestedRange = this.range;
    const args: CalendarRangeRequest = refresh
      ? {
          startDate: requestedRange.startDate,
          days: requestedRange.days,
          timeZone: requestedRange.timeZone,
          refresh: true,
        }
      : {
          startDate: requestedRange.startDate,
          days: requestedRange.days,
          timeZone: requestedRange.timeZone,
        };
    this.loading = true;
    this.notify();
    try {
      const link = await this.adapter.request("hub.calendar", args);
      if (this.disposed || reqGen !== this.generation || requestId !== this.readRequest) return;
      if (!link.data) {
        this.applyLinkFailure(link.errorCode ?? "HUB_UNAVAILABLE");
        return;
      }
      const data = link.data;
      if (
        data.range.startDate !== this.range.startDate ||
        data.range.days !== this.range.days ||
        data.range.timeZone !== this.range.timeZone
      ) {
        return;
      }
      if (
        this.requiredSelectionRevision !== null &&
        data.selectionRevision !== this.requiredSelectionRevision &&
        data.state !== "disabled" &&
        data.state !== "setup_required"
      ) {
        return;
      }
      this.recordTiming(
        data.serverNowEpochMs,
        link.ageMs,
        link.stale,
        link.state,
      );
      const selectionChanged = this.selectionRevision !== null && this.selectionRevision !== data.selectionRevision;
      const clearing = data.state === "disabled" || data.state === "setup_required";
      if (selectionChanged || (clearing && this.page?.state !== data.state)) this.resetSources();
      if (selectionChanged || this.page?.revision !== data.revision || clearing) {
        this.datasetVersion += 1;
        this.loadingMore = false;
      }
      if (clearing && (selectionChanged || this.page?.state !== data.state)) this.clearRevision += 1;
      this.publishContext(data.selectionRevision, data.state);
      this.selectionRevision = data.selectionRevision;
      this.errorCode = data.errorCode ?? link.errorCode;

      if (data.state === "disabled" || data.state === "setup_required") {
        this.requiredSelectionRevision = null;
        this.items = [];
        this.pageSources = data.sources;
        this.nextCursor = null;
        this.hasLoadedMore = false;
        this.page = { ...data, items: [], nextEvent: null, nextCursor: null };
        this.sourcesState = data.state;
        return;
      }

      this.requiredSelectionRevision = null;

      if (
        !refresh &&
        this.hasLoadedMore &&
        this.page &&
        data.revision === this.page.revision &&
        data.selectionRevision === this.page.selectionRevision
      ) {
        // Same revision while extra pages are open: update metadata without dropping page > 1.
        this.page = { ...data, nextCursor: this.nextCursor };
        return;
      }

      if (
        data.state === "loading" &&
        this.items.length > 0 &&
        this.page?.selectionRevision === data.selectionRevision
      ) {
        this.page = { ...data, nextEvent: data.nextEvent ?? this.page.nextEvent };
        return;
      }

      this.page = data;
      this.items = data.items;
      this.pageSources = data.sources;
      this.nextCursor = data.nextCursor;
      this.hasLoadedMore = false;
      this.sourcesState = data.state;
    } catch (error) {
      if (this.disposed || reqGen !== this.generation || requestId !== this.readRequest) return;
      const code = error instanceof DeviceError ? error.code : "BAD_PAYLOAD";
      this.applyLinkFailure(code);
    } finally {
      if (!this.disposed && reqGen === this.generation && requestId === this.readRequest) {
        this.loading = false;
        this.notify();
      }
    }
  }

  private resetSources() {
    this.sourceGeneration += 1;
    this.enumeratedSources = null;
    this.sourcesState = null;
    this.sourcesErrorCode = null;
    this.loadingSources = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.listeners.clear();
    this.contextListeners.clear();
  }
}
