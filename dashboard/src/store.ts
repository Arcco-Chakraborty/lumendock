import {
  LIMITS,
  type AppStatus,
  type EspSnapshot,
  type EspHistory,
  type BridgeReplyData,
  type HubSnapshot,
  type LinkSnapshot,
  type UsageSource,
} from "@phone-monitor/protocol";
import {
  DeviceError,
  systemClock,
  type Clock,
  type DeviceAdapter,
} from "./device.js";
export type HubLink = LinkSnapshot<HubSnapshot>;
export interface DashboardSnapshot {
  hub: HubLink;
  esp: EspSnapshot;
  history: LinkSnapshot<EspHistory> | null;
  app: AppStatus | null;
  appError: string | null;
  laptopNowEpochMs: number | null;
}
const emptyHub = (): HubLink => ({
  state: "disconnected",
  ageMs: null,
  stale: true,
  data: null,
  errorCode: null,
});
const emptyEsp = (): EspSnapshot => ({
  ...emptyHub(),
  data: null,
  commands: { state: null, timer: null },
});
export class DashboardStore {
  private hub = emptyHub();
  private esp = emptyEsp();
  private app: AppStatus | null = null;
  private history: LinkSnapshot<EspHistory> | null = null;
  private historyOpen = false;
  private appError: string | null = null;
  private hubReceived = 0;
  private espReceived = 0;
  private epochAnchor: number | null = null;
  private epochAt = 0;
  private adapter: DeviceAdapter | null = null;
  private visible = true;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private statusRefreshQueued = false;
  private inflight = new Set<string>();
  private last = new Map<string, number>();
  private listeners = new Set<() => void>();
  private cached: DashboardSnapshot | null = null;
  private cachedSecond = -1;
  constructor(private readonly clock: Clock = systemClock) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify() {
    this.cached = null;
    for (const fn of this.listeners) fn();
  }
  estimatedLaptopNow(): number | null {
    return this.epochAnchor === null
      ? null
      : this.epochAnchor + Math.max(0, this.clock.now() - this.epochAt);
  }
  snapshot = (): DashboardSnapshot => {
    // A snapshot remains stable between notifications for React's external-store API.
    // The public read also notices elapsed injected-clock time when no loop is running.
    const now = this.clock.now(),
      epoch = this.estimatedLaptopNow();
    if (this.cached && this.cachedSecond === Math.floor(now / 1000))
      return this.cached;
    this.cachedSecond = Math.floor(now / 1000);
    const aged = <T>(
      link: LinkSnapshot<T>,
      received: number,
      threshold: number,
    ): LinkSnapshot<T> => {
      const age =
        link.ageMs === null ? null : link.ageMs + Math.max(0, now - received);
      return {
        ...link,
        ageMs: age,
        stale: link.stale || age === null || age >= threshold,
      };
    };
    const hub = aged(this.hub, this.hubReceived, LIMITS.laptopStaleMs);
    if (hub.data && epoch !== null) {
      const source = (value: UsageSource, threshold: number): UsageSource => ({
        ...value,
        stale:
          value.stale ||
          value.lastSuccessAtEpochMs === null ||
          epoch - value.lastSuccessAtEpochMs >= threshold,
      });
      hub.data = {
        ...hub.data,
        usage: {
          claude: source(hub.data.usage.claude, LIMITS.claudeStaleMs),
          codex: source(hub.data.usage.codex, LIMITS.codexStaleMs),
        },
        notifications: {
          ...hub.data.notifications,
          items: hub.data.notifications.items.filter(
            (item) => item.expiresAtEpochMs > epoch,
          ),
        },
      };
    }
    this.cached = {
      hub,
      esp: {
        ...aged(this.esp, this.espReceived, LIMITS.espStaleMs),
        commands: this.esp.commands,
      },
      history: this.history,
      app: this.app,
      appError: this.appError,
      laptopNowEpochMs: epoch,
    };
    return this.cached;
  };
  applyHub(link: HubLink) {
    if (this.disposed) return;
    const now = this.clock.now(),
      previous = this.snapshot().hub;
    this.hub = {
      ...link,
      data: link.data ?? previous.data,
      ageMs: link.data ? link.ageMs : previous.ageMs,
    };
    this.hubReceived = now;
    if (link.data && link.ageMs !== null) {
      this.epochAnchor = Math.max(
        this.estimatedLaptopNow() ?? 0,
        link.data.serverNowEpochMs + link.ageMs,
      );
      this.epochAt = now;
    }
    this.notify();
  }
  applyEsp(link: EspSnapshot) {
    if (this.disposed) return;
    const previous = this.snapshot().esp;
    this.esp = {
      ...link,
      data: link.data ?? previous.data,
      ageMs: link.data ? link.ageMs : previous.ageMs,
    };
    this.espReceived = this.clock.now();
    this.notify();
  }
  applyAppStatus(status: AppStatus) {
    if (this.disposed) return;
    this.app = status;
    this.appError = null;
    this.notify();
  }
  start(adapter: DeviceAdapter, visible = true) {
    if (this.disposed || this.adapter) return;
    this.adapter = adapter;
    this.visible = visible;
    void this.poll("app.status");
    if (visible) {
      this.readSources();
      this.schedule();
    }
  }
  setVisible(visible: boolean) {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    if (visible && this.adapter) {
      this.readSources();
      // Also re-read a missing AppStatus (e.g. the first read hit SESSION_ENDED after renderer recreation).
      if (this.settingUp() || this.app === null) void this.poll("app.status");
      this.schedule();
    }
  }
  async setup(op: "app.setupHub" | "app.connectEsp") {
    if (!this.adapter || this.disposed) throw new DeviceError("SESSION_ENDED");
    const result = await this.adapter.request(op);
    if (!this.disposed) {
      if (this.inflight.has("app.status")) this.statusRefreshQueued = true;
      else void this.poll("app.status");
    }
    return result;
  }
  async setDisplay(
    op: "app.setScreenOn",
    args: { enabled: boolean },
  ): Promise<BridgeReplyData<"app.setScreenOn">>;
  async setDisplay(
    op: "app.setBrightness",
    args: { value: number },
  ): Promise<BridgeReplyData<"app.setBrightness">>;
  async setDisplay(
    op: "app.setScreenOn" | "app.setBrightness",
    args: { enabled: boolean } | { value: number },
  ) {
    if (!this.adapter || this.disposed) throw new DeviceError("SESSION_ENDED");
    const result =
      op === "app.setScreenOn"
        ? await this.adapter.request(op, args as { enabled: boolean })
        : await this.adapter.request(op, args as { value: number });
    if (!this.disposed && this.app) {
      this.app = {
        ...this.app,
        screenOn: result.screenOn,
        brightness: result.brightness,
      };
      this.notify();
    }
    return result;
  }
  setHistoryOpen(open: boolean) {
    this.historyOpen = open;
    if (open && this.visible) void this.poll("esp.history");
  }
  private settingUp() {
    return (
      this.app?.setup.hub.state === "in_progress" ||
      this.app?.setup.esp.state === "in_progress"
    );
  }
  private readSources() {
    void this.poll("hub.snapshot");
    void this.poll("esp.state");
  }
  private async poll(
    op: "hub.snapshot" | "esp.state" | "esp.history" | "app.status",
  ) {
    if (!this.adapter || this.disposed || this.inflight.has(op)) return;
    this.inflight.add(op);
    this.last.set(op, this.clock.now());
    try {
      if (op === "hub.snapshot") this.applyHub(await this.adapter.request(op));
      else if (op === "esp.state")
        this.applyEsp(await this.adapter.request(op));
      else if (op === "esp.history") {
        this.history = await this.adapter.request(op);
        this.notify();
      } else this.applyAppStatus(await this.adapter.request(op));
    } catch (error) {
      if (this.disposed) return;
      const code = error instanceof DeviceError ? error.code : "BAD_PAYLOAD";
      if (op === "hub.snapshot")
        this.applyHub({
          ...this.snapshot().hub,
          state: "disconnected",
          stale: true,
          errorCode: code,
        });
      else if (op === "esp.state")
        this.applyEsp({
          ...this.snapshot().esp,
          state: "disconnected",
          stale: true,
          errorCode: code,
        });
      else if (op === "esp.history") {
        this.history = {
          state: "error",
          data: this.history?.data ?? null,
          ageMs: this.history?.ageMs ?? null,
          stale: true,
          errorCode: code,
        };
        this.notify();
      } else {
        this.appError = code;
        this.notify();
      }
    } finally {
      this.inflight.delete(op);
      if (op === "app.status" && this.statusRefreshQueued && !this.disposed) {
        this.statusRefreshQueued = false;
        void this.poll("app.status");
      }
    }
  }
  async dispatchAction(action: string): Promise<{ success: boolean; message?: string }> {
    if (!this.adapter) return { success: false, message: "No adapter" };
    try {
      const res = await this.adapter.request("hub.action", { action });
      return res as { success: boolean; message?: string };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Action failed" };
    }
  }
  private schedule() {
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (!this.visible || this.disposed) return;
      const now = this.clock.now();
      if (now - (this.last.get("hub.snapshot") ?? -Infinity) >= 2000)
        void this.poll("hub.snapshot");
      if (now - (this.last.get("esp.state") ?? -Infinity) >= 3000)
        void this.poll("esp.state");
      if (
        this.historyOpen &&
        now - (this.last.get("esp.history") ?? -Infinity) >= 30000
      )
        void this.poll("esp.history");
      const statusAge = now - (this.last.get("app.status") ?? -Infinity);
      // Poll during setup; otherwise retry a failed first read every 5 s, since light writes
      // stay disabled until AppStatus provides the generation floor.
      if (
        (this.settingUp() && statusAge >= 2000) ||
        (this.app === null && this.appError !== null && statusAge >= 5000)
      )
        void this.poll("app.status");
      this.notify();
      this.schedule();
    }, 1000);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.adapter?.dispose();
    this.listeners.clear();
  }
}
