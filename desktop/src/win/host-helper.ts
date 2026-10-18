import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { HostStateSchema, type HostState } from '@phone-monitor/protocol';

// Windows counterpart of wpctl/busctl/gsettings: one resident Windows PowerShell process
// (host-helper.ps1) answers fixed command words with one JSON line each. Starting PowerShell
// and compiling its audio interop takes seconds, so it is started once and kept, and
// restarted with a bounded backoff if it dies. Requests are strictly serialized.
// Next to this module: in src for tests, copied into dist/win by the desktop build.
export const HELPER_SCRIPT = fileURLToPath(new URL('./host-helper.ps1', import.meta.url));
export type HelperCommand = 'state' | 'vitals' | 'ping' | 'volume_up' | 'volume_down' | 'media_mute' | 'mic_mute'
  | 'media_play_pause' | 'media_next' | 'media_prev';
export interface HelperReply { ok: boolean; data?: unknown; error?: string }
export interface HelperProcess {
  stdin: { write(text: string): unknown; end(): unknown };
  stdout: NodeJS.ReadableStream;
  kill(): unknown;
  once(event: 'exit', listener: () => void): unknown;
}
export type HelperSpawner = () => HelperProcess;

const READY_TIMEOUT_MS = 45_000, REQUEST_TIMEOUT_MS = 6_000, MAX_BACKOFF_MS = 60_000;
const powershell = (): HelperProcess => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_SCRIPT],
  { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });

export class WindowsHostHelper {
  private child: HelperProcess | null = null;
  private ready: Promise<void> | null = null;
  private waiting: Array<(line: string | null) => void> = [];
  private tail: Promise<unknown> = Promise.resolve();
  private failures = 0;
  private retryAt = 0;
  private stopped = false;
  constructor(private readonly spawner: HelperSpawner = powershell, private readonly now: () => number = Date.now) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    if (this.now() < this.retryAt) return Promise.reject(Error('HELPER_BACKOFF'));
    const child = this.spawner();
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => this.waiting.shift()?.(line));
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = null; this.ready = null;
      for (const resolve of this.waiting.splice(0)) resolve(null);
    });
    this.ready = this.next(READY_TIMEOUT_MS).then(line => {
      if (line === null || !line.includes('"ready":true')) throw Error('HELPER_UNAVAILABLE');
      this.failures = 0;
    }).catch(error => { this.fail(child); throw error; });
    return this.ready;
  }
  private fail(child: HelperProcess): void {
    if (this.child === child) { this.child = null; this.ready = null; }
    try { child.kill(); } catch { /* already gone */ }
    this.retryAt = this.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.failures++, 6));
  }
  private next(timeoutMs: number): Promise<string | null> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { const i = this.waiting.indexOf(done); if (i >= 0) this.waiting.splice(i, 1); resolve(null); }, timeoutMs);
      const done = (line: string | null) => { clearTimeout(timer); resolve(line); };
      this.waiting.push(done);
    });
  }

  /** Sends one command word and resolves its parsed reply; rejects when the helper is unavailable. */
  request(command: HelperCommand): Promise<HelperReply> {
    const run = this.tail.then(async () => {
      if (this.stopped) throw Error('HELPER_STOPPED');
      await this.start();
      const child = this.child!;
      const reply = this.next(REQUEST_TIMEOUT_MS);
      child.stdin.write(`${command}\n`);
      const line = await reply;
      // A lost reply would pair every later answer with the wrong request: restart instead.
      if (line === null) { this.fail(child); throw Error('HELPER_TIMEOUT'); }
      return JSON.parse(line) as HelperReply;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
  stop(): void {
    this.stopped = true;
    const child = this.child;
    this.child = null; this.ready = null;
    if (child) { try { child.stdin.write('exit\n'); child.stdin.end(); } catch { /* gone */ } setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 1000).unref(); }
  }
}

let shared: WindowsHostHelper | null = null;
/** The hub's single helper, shared by the Deck state poll and the Deck keys. */
export const sharedHostHelper = (): WindowsHostHelper => (shared ??= new WindowsHostHelper());

const clip = (value: unknown, max: number) => [...(typeof value === 'string' ? value : '')].slice(0, max).join('').replace(/[\u0000-\u001f\u007f]/g, ' ');
const flag = (value: unknown) => typeof value === 'boolean' ? value : null;

/** Maps the helper's `state` reply onto the shared HostState; a field the helper could not read stays null. */
export function parseWindowsHostState(data: unknown): HostState {
  const d = data !== null && typeof data === 'object' ? data as Record<string, unknown> : {};
  const m = d.media !== null && typeof d.media === 'object' ? d.media as Record<string, unknown> : null;
  const status = m && ['playing', 'paused', 'stopped'].includes(m.status as string) ? m.status as 'playing' | 'paused' | 'stopped' : 'stopped';
  const volume = typeof d.volumePercent === 'number' && Number.isFinite(d.volumePercent) ? Math.min(150, Math.max(0, Math.round(d.volumePercent))) : null;
  return HostStateSchema.parse({
    media: m ? { player: clip(m.player, 40) || 'Player', status, title: clip(m.title, 120), artist: clip(m.artist, 120) } : null,
    volumePercent: volume, muted: flag(d.muted), micMuted: flag(d.micMuted), doNotDisturb: flag(d.doNotDisturb),
  });
}

export async function readWindowsHostState(helper: WindowsHostHelper = sharedHostHelper()): Promise<HostState> {
  const reply = await helper.request('state');
  if (!reply.ok) throw Error('HELPER_FAILED');
  return parseWindowsHostState(reply.data);
}
