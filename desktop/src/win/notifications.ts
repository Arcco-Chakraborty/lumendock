import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from '@phone-monitor/protocol';
import { isValidNotificationLabel, MAX_NOTIFICATION_APPS } from '../config.js';
import type { HubStore } from '../store.js';
import { notificationDisplayLabel } from '../notification-sources.js';
import { NOTIFICATION_DEDUPE_MS, plainText, type NotificationCapability, type NotificationClock } from '../collectors/notifications.js';

// Windows has no session bus to watch. Every toast the shell shows is recorded in the user's
// own notification database; this collector polls it read-only for rows newer than the hub's
// start. The allowlist gate runs on the app identity first, and a toast's payload is read only
// for an allowed app. Nothing is retained, logged or forwarded otherwise.
export const notificationDatabasePath = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');

export interface ToastRef { id: number; app: string }
export interface NotificationDb {
  maxId(): number;
  newer(afterId: number, limit: number): ToastRef[];
  payload(id: number): string | null;
  close(): void;
}
export type NotificationDbOpener = () => Promise<NotificationDb>;

export const openNotificationDb = (path = notificationDatabasePath()): NotificationDbOpener => async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  const max = db.prepare('SELECT coalesce(max(Id), 0) AS id FROM Notification');
  const newer = db.prepare("SELECT n.Id AS id, h.PrimaryId AS app FROM Notification n JOIN NotificationHandler h ON h.RecordId = n.HandlerId WHERE n.Type = 'toast' AND n.Id > ? ORDER BY n.Id LIMIT ?");
  const payload = db.prepare('SELECT Payload AS payload FROM Notification WHERE Id = ?');
  return {
    maxId: () => Number((max.get() as { id: number | bigint }).id),
    newer: (afterId, limit) => (newer.all(afterId, limit) as Array<{ id: number | bigint; app: unknown }>)
      .map(row => ({ id: Number(row.id), app: typeof row.app === 'string' ? row.app : '' })),
    payload: id => {
      const value = (payload.get(id) as { payload?: unknown } | undefined)?.payload;
      if (typeof value === 'string') return value;
      return value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : null;
    },
    close: () => db.close(),
  };
};

/** An allowlist label selects a Windows app when its identity contains the label (case and spaces ignored). */
export function labelMatchesApp(label: string, appId: string): boolean {
  const key = label.toLowerCase().replace(/\s+/g, '');
  return key.length >= 3 && appId.toLowerCase().includes(key);
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
const decodeOnce = (text: string) => text.replace(/&(?:(lt|gt|quot|apos|amp)|#(\d{1,7})|#x([0-9a-fA-F]{1,6}));/g, (match, name: string | undefined, dec: string | undefined, hex: string | undefined) => {
  if (name) return NAMED[name]!;
  const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
});
/** Title and body of a toast's first visual binding: its first text line, then the rest (attribution lines are dropped). */
export function parseToast(xml: string): { title: string; body: string } {
  const binding = /<binding\b[^>]*>([\s\S]*?)<\/binding>/i.exec(xml.slice(0, 64 * 1024))?.[1] ?? '';
  const lines: string[] = [];
  for (const match of binding.matchAll(/<text\b([^>]*?)(?:\/>|>([\s\S]*?)<\/text>)/gi)) {
    if (/placement\s*=\s*["']attribution["']/i.test(match[1] ?? '')) continue;
    // Decode entities exactly once, then hand plainText an escaped '&' so it cannot decode a second time.
    const text = decodeOnce((match[2] ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/&/g, '&amp;');
    if (text.trim()) lines.push(text);
    if (lines.length >= 8) break;
  }
  return { title: plainText(lines[0] ?? '', 100), body: plainText(lines.slice(1).join(' '), 280) };
}

export interface WindowsNotificationCollectorOptions {
  store: HubStore; clock?: NotificationClock; open?: NotificationDbOpener; intervalMs?: number;
}
export class WindowsNotificationCollector {
  private labels: string[] = [];
  private db: NotificationDb | null = null;
  private lastId: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private sequence = 0;
  private readonly seen = new Map<string, number>();
  private current: NotificationCapability = { state: 'disabled', errorCode: null };
  private readonly clock: NotificationClock;
  private readonly open: NotificationDbOpener;
  constructor(private readonly options: WindowsNotificationCollectorOptions) {
    this.clock = options.clock ?? { nowMs: Date.now };
    this.open = options.open ?? openNotificationDb();
  }
  get capability(): NotificationCapability { return { ...this.current }; }

  /** Applies the allowlist (invalid labels dropped, at most ten kept). Never throws. */
  async start(allowlist: readonly string[]): Promise<void> {
    const wanted: string[] = [];
    for (const label of allowlist) if (isValidNotificationLabel(label) && !wanted.includes(label) && wanted.length < MAX_NOTIFICATION_APPS) wanted.push(label);
    this.labels = wanted;
    this.options.store.setNotificationAllowlist(wanted.map(notificationDisplayLabel));
    if (!wanted.length) { this.halt(); this.set('disabled'); return; }
    if (!this.timer) this.timer = setInterval(() => void this.poll(), this.options.intervalMs ?? 2000);
    await this.poll();
  }
  async stop(): Promise<void> { this.labels = []; this.halt(); this.set('disabled'); }

  private halt(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.lastId = null; this.seen.clear();
    try { this.db?.close(); } catch { /* already closed */ }
    this.db = null;
  }
  private set(state: NotificationCapability['state']): void {
    this.current = { state, errorCode: state === 'unavailable' ? 'NOTIFICATION_MONITOR_UNAVAILABLE' : null };
    this.options.store.setNotificationState(this.current.state, this.current.errorCode);
  }
  async poll(): Promise<void> {
    if (this.busy || !this.labels.length) return;
    this.busy = true;
    try {
      this.db ??= await this.open();
      const max = this.db.maxId();
      // First look (or a recreated database): start after what is already there, never replay history.
      if (this.lastId === null || max < this.lastId) { this.lastId = max; this.set('available'); return; }
      for (const row of this.db.newer(this.lastId, 50)) {
        this.lastId = Math.max(this.lastId, row.id);
        const label = this.labels.find(candidate => labelMatchesApp(candidate, row.app));
        if (!label) continue;
        const xml = this.db.payload(row.id);
        if (xml) this.deliver(notificationDisplayLabel(label), parseToast(xml));
      }
      if (this.current.state !== 'available') this.set('available');
    } catch {
      try { this.db?.close(); } catch { /* gone */ }
      this.db = null;
      if (this.labels.length) this.set('unavailable');
    } finally { this.busy = false; }
  }
  private deliver(label: string, { title, body }: { title: string; body: string }): void {
    if (!title && !body) return;
    const now = this.clock.nowMs();
    for (const [key, at] of this.seen) if (now - at >= NOTIFICATION_DEDUPE_MS || now < at) this.seen.delete(key);
    const key = createHash('sha256').update(`${label}\0${title}\0${body}`).digest('hex');
    if (this.seen.has(key)) return;
    this.seen.set(key, now);
    this.options.store.addNotification({ id: `n${now.toString(36)}-${++this.sequence}`, appId: label, title, body, receivedAtEpochMs: now, expiresAtEpochMs: now + LIMITS.notificationTtlMs });
  }
}
