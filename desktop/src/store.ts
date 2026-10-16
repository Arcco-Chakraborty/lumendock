import { HostStateSchema, HubSnapshotSchema, LIMITS, SelectedNotificationSchema, claudeWindowStale, UsageObservationSchema, type ErrorCode, type HostState, type HubSnapshot, type Provider, type SelectedNotification, type UsageSource } from '@phone-monitor/protocol';

const emptySource = (provider: Provider): UsageSource => ({provider,source:provider === 'claude' ? 'claude_statusline' : 'codex_app_server',state:'awaiting_data',observedAtEpochMs:null,lastSuccessAtEpochMs:null,stale:true,windows:[],errorCode:null});
export interface StoreOptions {initialSnapshot?: HubSnapshot; notificationAllowlist?: readonly string[]}
export class HubStore {
  private readonly usage: {claude:UsageSource;codex:UsageSource};
  private readonly allowlist: Set<string>;
  private notifications: HubSnapshot['notifications'];
  private lastPhoneActivity: number | null = null;
  private host: HostState | null = null;
  constructor(options: StoreOptions = {}) {
    const initial = options.initialSnapshot ? HubSnapshotSchema.parse(options.initialSnapshot) : null;
    this.usage = initial ? structuredClone(initial.usage) : {claude:emptySource('claude'),codex:emptySource('codex')};
    this.allowlist = new Set(options.notificationAllowlist ?? []);
    this.notifications = {state:this.allowlist.size ? (initial?.notifications.state ?? 'unavailable') : 'disabled',errorCode:this.allowlist.size ? (initial?.notifications.errorCode ?? null) : null,items:[]};
    for (const item of initial?.notifications.items ?? []) this.addNotification(item);
  }
  updateUsage(provider: Provider, input: unknown): boolean {
    const parsed = UsageObservationSchema.safeParse(input);
    if (!parsed.success || parsed.data.provider !== provider) return false;
    const incoming = parsed.data; const prior = this.usage[provider];
    const capacity = provider === 'claude' ? LIMITS.claudeWindows : LIMITS.codexWindows;
    if (incoming.windows.length > capacity) {
      this.usage[provider] = {...prior,state:'unsupported',observedAtEpochMs:incoming.observedAtEpochMs,stale:true,errorCode:'SOURCE_CAPACITY_EXCEEDED'};
      return false;
    }
    if (incoming.state !== 'available') {
      this.usage[provider] = {...prior,state:incoming.state,observedAtEpochMs:incoming.observedAtEpochMs,stale:true,errorCode:incoming.errorCode};
    } else this.usage[provider] = structuredClone(incoming);
    return true;
  }
  addNotification(input: unknown): boolean {
    const parsed = SelectedNotificationSchema.safeParse(input);
    if (!parsed.success || !this.allowlist.has(parsed.data.appId)) return false;
    const item = parsed.data;
    this.notifications.items = this.notifications.items.filter(n => n.id !== item.id);
    this.notifications.items.push(structuredClone(item));
    this.notifications.items.sort((a,b)=>a.receivedAtEpochMs-b.receivedAtEpochMs);
    this.notifications.items = this.notifications.items.slice(-LIMITS.notifications);
    return true;
  }
  setNotificationState(state:'disabled'|'available'|'unavailable',errorCode:ErrorCode|null = null): void {
    const parsed = HubSnapshotSchema.shape.notifications.shape.errorCode.parse(errorCode);
    this.notifications.state = this.allowlist.size ? state : 'disabled';
    this.notifications.errorCode = this.allowlist.size ? parsed : null;
  }
  // Settings change: retain only events from still-allowed apps; an empty list disables the feed.
  setNotificationAllowlist(labels: readonly string[]): void {
    this.allowlist.clear(); for (const label of labels) this.allowlist.add(label);
    this.notifications.items = this.notifications.items.filter(n=>this.allowlist.has(n.appId));
    if (!this.allowlist.size) {this.notifications.state = 'disabled'; this.notifications.errorCode = null;}
    else if (this.notifications.state === 'disabled') this.notifications.state = 'unavailable';
  }
  setHost(input: unknown): boolean {
    const parsed = HostStateSchema.safeParse(input);
    if (parsed.success) this.host = parsed.data;
    return parsed.success;
  }
  markPhoneActivity(monotonicMs: number): void { this.lastPhoneActivity = monotonicMs; }
  isPhoneActive(monotonicMs: number): boolean { return this.lastPhoneActivity !== null && monotonicMs >= this.lastPhoneActivity && monotonicMs-this.lastPhoneActivity < 10000; }
  snapshot(nowMs: number): HubSnapshot {
    const usage = structuredClone(this.usage);
    for (const provider of ['claude','codex'] as const) {
      const source = usage[provider];
      const old = (at:number|null,limit:number) => at === null || nowMs-at >= limit || nowMs < at;
      source.stale = source.stale || source.state !== 'available' || (provider === 'codex'
        ? old(source.lastSuccessAtEpochMs,LIMITS.codexStaleMs)
        : source.windows.length === 0 || source.windows.some(w=>claudeWindowStale(w,nowMs)));
    }
    // Expired notifications never reach a response and never persist on disk.
    this.notifications.items = this.notifications.items.filter(n=>n.expiresAtEpochMs > nowMs);
    const items: SelectedNotification[] = structuredClone(this.notifications.items);
    const result: HubSnapshot = {v:1,serverNowEpochMs:nowMs,usage,notifications:{...this.notifications,items},...(this.host ? {host:structuredClone(this.host)} : {})};
    while(Buffer.byteLength(JSON.stringify(result),'utf8') > LIMITS.hubBytes && items.length) items.shift();
    return HubSnapshotSchema.parse(result);
  }
}
