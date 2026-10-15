import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { LIMITS, type ErrorCode } from '@phone-monitor/protocol';
import { isValidNotificationLabel, MAX_NOTIFICATION_APPS } from '../config.js';
import type { HubStore } from '../store.js';

// Capture of GNOME's session-bus Notify calls through one `busctl monitor` child per allowed app label.
// Nothing from a notification is retained, logged or forwarded unless its app label is allowlisted;
// capability failures are fixed error codes, never raw subprocess text.
export const NOTIFICATION_LINE_BYTES = 256 * 1024;
export const NOTIFICATION_DEDUPE_MS = 2000;
const INTERFACE = 'org.freedesktop.Notifications', SIGNATURE = 'susssasa{sv}i';
const GRACE_MS = 1000, STABLE_MS = 30000, KILL_MS = 2000, REAP_MS = 1000, CLASSIFY_MS = 20, MAX_DEDUPE = 500;
export interface MonitorChild {
  stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream; kill(signal?: NodeJS.Signals): unknown;
  on(event: 'exit' | 'close' | 'error', listener: (...args: unknown[]) => void): unknown;
  off(event: 'exit' | 'close' | 'error', listener: (...args: unknown[]) => void): unknown;
}
export type MonitorRunner = (command: string, args: string[], options: {shell: false; stdio: ['ignore','pipe','pipe']}) => MonitorChild;
export interface NotificationClock {nowMs(): number; monotonicMs?(): number}
export interface NotificationCollectorOptions {
  runner?: MonitorRunner; store: HubStore; clock?: NotificationClock; busctlPath?: string;
  startupGraceMs?: number;
}
export type NotificationCapability = {state: 'disabled' | 'available' | 'unavailable'; errorCode: ErrorCode | null};
interface Monitor {
  label: string; child: MonitorChild | null; closed: boolean; confirmed: boolean; failures: number; spawnedAt: number;
  code: ErrorCode | null; denied: boolean; stderr: string; pending: Buffer[]; bytes: number; discarding: boolean;
  timer: ReturnType<typeof setTimeout> | null; grace: ReturnType<typeof setTimeout> | null; classify: ReturnType<typeof setTimeout> | null;
}
const ENTITIES: Record<string,string> = {lt:'<',gt:'>',quot:'"',apos:"'",amp:'&'};
// Plain text only: drop simple Notify markup, decode the five XML entities once, flatten control characters.
export function plainText(value: string, maxCodePoints: number): string {
  const bounded = (value.length > 4000 ? value.slice(0,4000) : value).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,'\ufffd');
  const text = bounded.replace(/<\/?(?:b|i|u|a|img)\b[^>]*>/gi,'').replace(/&(lt|gt|quot|apos|amp);/g,(_match:string,name:string)=>ENTITIES[name] ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g,' ').trim();
  return [...text].slice(0,maxCodePoints).join('');
}
export function matchExpression(label: string): string {
  if (!isValidNotificationLabel(label)) throw new Error('BAD_APP_LABEL');
  return `type='method_call',interface='${INTERFACE}',member='Notify',arg0='${label}'`;
}
const object = (v: unknown): Record<string,unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : null;
export class NotificationCollector {
  private readonly monitors = new Map<string,Monitor>();
  private readonly seen = new Map<string,number>();
  private tail: Promise<void> = Promise.resolve();
  private sequence = 0; private current: NotificationCapability = {state:'disabled',errorCode:null};
  private readonly runner: MonitorRunner; private readonly store: HubStore; private readonly clock: NotificationClock;
  constructor(private readonly options: NotificationCollectorOptions) {
    this.store = options.store; this.clock = options.clock ?? {nowMs:Date.now};
    this.runner = options.runner ?? ((command,args,spawnOptions)=>nodeSpawn(command,args,spawnOptions) as unknown as MonitorChild);
  }
  get capability(): NotificationCapability { return {...this.current}; }
  /** Reconciles running monitors with the allowlist (invalid labels are dropped, at most ten kept). Never throws. */
  start(allowlist: readonly string[]): Promise<void> { return this.enqueue(() => this.apply(allowlist)); }
  stop(): Promise<void> { return this.enqueue(() => this.apply([])); }
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(task,task); this.tail = run.catch(()=>undefined); return run;
  }
  private async apply(allowlist: readonly string[]): Promise<void> {
    const wanted: string[] = [];
    for (const label of allowlist) if (isValidNotificationLabel(label) && !wanted.includes(label) && wanted.length < MAX_NOTIFICATION_APPS) wanted.push(label);
    this.store.setNotificationAllowlist(wanted);
    const removed = [...this.monitors.values()].filter(m => !wanted.includes(m.label));
    for (const m of removed) this.monitors.delete(m.label);
    await Promise.all(removed.map(m => this.terminate(m)));
    if (!wanted.length) this.seen.clear();
    for (const label of wanted) if (!this.monitors.has(label)) { const m = this.create(label); this.monitors.set(label,m); this.spawn(m); }
    this.refresh();
  }
  private create(label: string): Monitor {
    return {label,child:null,closed:false,confirmed:false,failures:0,spawnedAt:0,code:null,denied:false,stderr:'',pending:[],bytes:0,discarding:false,timer:null,grace:null,classify:null};
  }
  private refresh(): void {
    const all = [...this.monitors.values()];
    const state = !all.length ? 'disabled' : all.some(m => m.confirmed) ? 'available' : 'unavailable';
    const errorCode = state === 'unavailable' ? (all.find(m => m.code)?.code ?? 'NOTIFICATION_MONITOR_UNAVAILABLE') : null;
    this.current = {state,errorCode}; this.store.setNotificationState(state,errorCode);
  }
  private spawn(m: Monitor): void {
    if (m.closed || m.child) return;
    let child: MonitorChild;
    try { child = this.runner(this.options.busctlPath ?? 'busctl',['--user','--json=short','--no-pager',`--match=${matchExpression(m.label)}`,'monitor'],{shell:false,stdio:['ignore','pipe','pipe']}); }
    catch { m.code = 'NOTIFICATION_MONITOR_UNAVAILABLE'; this.scheduleRestart(m); this.refresh(); return; }
    m.child = child; m.spawnedAt = this.mono(); m.confirmed = false; m.code = null; m.denied = false; m.stderr = ''; m.pending = []; m.bytes = 0; m.discarding = false;
    child.stdout.on('data',(chunk: Buffer) => { if (m.child === child && !m.closed) this.consume(m,Buffer.from(chunk)); });
    // Stderr is used only to tell "denied" from "unavailable"; it is bounded, never stored or logged.
    child.stderr.on('data',(chunk: Buffer) => { if (m.child === child && m.stderr.length < 2048) { m.stderr += chunk.toString('utf8',0,2048); if (/denied|not permitted|permission|policy|not authori[sz]ed/i.test(m.stderr)) m.denied = true; } });
    child.stdout.on('error',()=>{}); child.stderr.on('error',()=>{});
    const gone = () => this.gone(m,child);
    child.on('error',gone); child.on('exit',gone); child.on('close',()=>{ if (m.classify) { this.classifyNow(m); } });
    m.grace = setTimeout(() => { m.grace = null; if (m.child === child && !m.closed) { m.confirmed = true; this.refresh(); } },this.options.startupGraceMs ?? GRACE_MS);
  }
  private gone(m: Monitor, child: MonitorChild): void {
    if (m.child !== child) return;
    m.child = null; if (m.grace) clearTimeout(m.grace); m.grace = null; m.confirmed = false;
    if (m.closed) return;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    if (this.mono() - m.spawnedAt >= STABLE_MS) m.failures = 0;
    m.code = m.denied ? 'NOTIFICATION_MONITOR_DENIED' : 'NOTIFICATION_MONITOR_UNAVAILABLE';
    // Stderr can arrive just after exit: refine the fixed code once, shortly, then drop the text.
    m.classify = setTimeout(() => this.classifyNow(m),CLASSIFY_MS);
    this.scheduleRestart(m); this.refresh();
  }
  private classifyNow(m: Monitor): void {
    if (m.classify) clearTimeout(m.classify); m.classify = null;
    if (m.closed) return;
    if (!m.child) { m.code = m.denied ? 'NOTIFICATION_MONITOR_DENIED' : 'NOTIFICATION_MONITOR_UNAVAILABLE'; this.refresh(); }
    m.stderr = '';
  }
  private scheduleRestart(m: Monitor): void {
    if (m.closed) return;
    if (m.timer) clearTimeout(m.timer);
    const delay = Math.min(60000,1000 * 2 ** Math.min(m.failures++,6));
    m.timer = setTimeout(() => { m.timer = null; this.spawn(m); },delay);
  }
  private terminate(m: Monitor): Promise<void> {
    m.closed = true; m.confirmed = false;
    for (const key of ['timer','grace','classify'] as const) { const t = m[key]; if (t) clearTimeout(t); m[key] = null; }
    const child = m.child; m.child = null; m.pending = []; m.bytes = 0;
    if (!child) return Promise.resolve();
    return new Promise<void>(resolve => {
      let force: ReturnType<typeof setTimeout> | undefined, reap: ReturnType<typeof setTimeout> | undefined, complete = false;
      const done = () => { if (complete) return; complete = true; clearTimeout(force); clearTimeout(reap); child.off('exit',done); child.off('close',done); child.off('error',done); resolve(); };
      child.on('exit',done); child.on('close',done); child.on('error',done);
      force = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } reap = setTimeout(done,REAP_MS); },KILL_MS);
      try { child.kill('SIGTERM'); } catch { done(); }
    });
  }
  // Bounded line framing: a line over the cap is discarded up to its newline, then decoding resumes.
  private consume(m: Monitor, chunk: Buffer): void {
    let start = 0;
    for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10,start)) {
      const part = chunk.subarray(start,i); start = i + 1;
      if (m.discarding) m.discarding = false;
      else if (m.bytes + part.length <= NOTIFICATION_LINE_BYTES) { const line = m.pending.length ? Buffer.concat([...m.pending,part]) : part; this.line(m,line); }
      m.pending = []; m.bytes = 0;
      if (m.closed || !m.child) return;
    }
    const rest = chunk.subarray(start);
    if (m.discarding || !rest.length) return;
    if (m.bytes + rest.length > NOTIFICATION_LINE_BYTES) { m.discarding = true; m.pending = []; m.bytes = 0; }
    else { m.pending.push(Buffer.from(rest)); m.bytes += rest.length; }
  }
  private line(m: Monitor, bytes: Buffer): void {
    let message: Record<string,unknown> | null;
    try { message = object(JSON.parse(bytes.toString('utf8'))); } catch { return; }
    if (!message) return;
    if (!m.confirmed) { m.confirmed = true; if (m.grace) clearTimeout(m.grace); m.grace = null; this.refresh(); }
    if (message.type !== 'method_call' || message.interface !== INTERFACE || message.member !== 'Notify') return;
    const payload = object(message.payload), data = payload?.data;
    if (payload?.type !== SIGNATURE || !Array.isArray(data) || data.length !== 8) return;
    const [app,id,icon,summary,body,actions,hints,timeout] = data as unknown[];
    // Allowlist gate first: only this monitor's own label proceeds; no other field is touched.
    if (app !== m.label) return;
    if (typeof id !== 'number' || typeof icon !== 'string' || typeof summary !== 'string' || typeof body !== 'string' || !Array.isArray(actions) || !object(hints) || typeof timeout !== 'number') return;
    const title = plainText(summary,100), text = plainText(body,280);
    if (!title && !text) return;
    const now = this.clock.nowMs();
    if (this.duplicate(m.label,title,text,now)) return;
    this.store.addNotification({id:`n${now.toString(36)}-${++this.sequence}`,appId:m.label,title,body:text,receivedAtEpochMs:now,expiresAtEpochMs:now + LIMITS.notificationTtlMs});
  }
  private duplicate(label: string, title: string, body: string, now: number): boolean {
    for (const [key,at] of this.seen) if (now - at >= NOTIFICATION_DEDUPE_MS || now < at) this.seen.delete(key);
    const key = createHash('sha256').update(`${label}\0${title}\0${body}`).digest('hex'), last = this.seen.get(key);
    if (last !== undefined) return true;
    if (this.seen.size >= MAX_DEDUPE) this.seen.delete(this.seen.keys().next().value as string);
    this.seen.set(key,now); return false;
  }
  private mono(): number { return (this.clock.monotonicMs ?? (() => performance.now()))(); }
}
