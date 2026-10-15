import { listNotificationApps } from './config.js';

// Applies private-config allowlist changes (made by the laptop CLI) to the running collector without a hub restart.
// A missing/unreadable config means "no apps allowed": capture stays off rather than failing the hub.
export interface AllowlistSyncOptions {
  configDir: string; apply: (labels: string[]) => Promise<void>; intervalMs?: number; list?: (dir: string) => string[];
}
export class AllowlistSync {
  private timer: ReturnType<typeof setInterval>|null = null;
  private last: string|null = null; private busy = false; private generation = 0;
  constructor(private readonly options: AllowlistSyncOptions) {}
  async start(): Promise<void> {
    if (this.timer) return;
    const generation = ++this.generation;
    this.timer = setInterval(() => { void this.sync(generation); }, this.options.intervalMs ?? 2000);
    await this.sync(generation);
  }
  private async sync(generation: number): Promise<void> {
    if (this.busy || generation !== this.generation) return;
    this.busy = true;
    try {
      let labels: string[];
      try { labels = (this.options.list ?? listNotificationApps)(this.options.configDir); } catch { labels = []; }
      const key = JSON.stringify(labels);
      if (key === this.last) return;
      this.last = key;
      await this.options.apply(labels);
    } catch { this.last = null; /* retry on the next tick */ }
    finally { this.busy = false; }
  }
  stop(): void { this.generation++; if (this.timer) clearInterval(this.timer); this.timer = null; this.last = null; }
}
