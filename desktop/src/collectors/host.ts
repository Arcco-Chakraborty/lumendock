import { execFile } from 'node:child_process';
import { HostStateSchema, type HostMedia, type HostState } from '@phone-monitor/protocol';
import type { HubStore } from '../store.js';
import type { VitalsReader } from './vitals.js';

/** Runs a fixed command without a shell and resolves its stdout; rejects on failure. */
export type HostRunner = (command: string, args: string[]) => Promise<string>;
export const execRunner: HostRunner = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, {timeout: 1500, maxBuffer: 256 * 1024}, (error, stdout) => error ? reject(error) : resolve(stdout));
});

const clip = (value: string, max: number) => [...value].slice(0, max).join('');
const MPRIS = 'org.mpris.MediaPlayer2';
const STATUS: Record<string, HostMedia['status']> = {Playing: 'playing', Paused: 'paused', Stopped: 'stopped'};

/** `wpctl get-volume` prints e.g. "Volume: 0.68" or "Volume: 0.40 [MUTED]". */
export function parseVolume(output: string): {percent: number | null; muted: boolean | null} {
  const match = /Volume:\s*([0-9.]+)/.exec(output);
  if (!match) return {percent: null, muted: null};
  return {percent: Math.min(150, Math.round(Number(match[1]) * 100)), muted: /\[MUTED\]/.test(output)};
}

async function property(run: HostRunner, name: string, iface: string, prop: string): Promise<{type: string; data: unknown}> {
  return JSON.parse(await run('busctl', ['--user', '--json=short', 'get-property', name, '/org/mpris/MediaPlayer2', iface, prop]));
}

/** The playing MPRIS player, else the first paused one, else null. Only title, artist and player name leave the laptop. */
export async function readMedia(run: HostRunner): Promise<HostMedia | null> {
  const names = (JSON.parse(await run('busctl', ['--user', '--json=short', 'list'])) as Array<{name?: unknown}>)
    .map(entry => entry.name).filter((name): name is string => typeof name === 'string' && name.startsWith(`${MPRIS}.`));
  const players: HostMedia[] = [];
  for (const name of names.slice(0, 8)) {
    try {
      const status = STATUS[String((await property(run, name, `${MPRIS}.Player`, 'PlaybackStatus')).data)] ?? 'stopped';
      const metadata = (await property(run, name, `${MPRIS}.Player`, 'Metadata')).data as Record<string, {data?: unknown}>;
      let player = name.slice(MPRIS.length + 1).split('.')[0] ?? 'Player';
      try { player = String((await property(run, name, MPRIS, 'Identity')).data); } catch { /* keep bus name */ }
      const title = metadata['xesam:title']?.data;
      const artist = metadata['xesam:artist']?.data;
      players.push({
        player: clip(player, 40), status,
        title: clip(typeof title === 'string' ? title : '', 120),
        artist: clip(Array.isArray(artist) ? artist.filter(a => typeof a === 'string').join(', ') : typeof artist === 'string' ? artist : '', 120),
      });
    } catch { /* a player that vanished mid-read is skipped */ }
  }
  return players.find(p => p.status === 'playing') ?? players.find(p => p.status === 'paused') ?? null;
}

/** Reads every part independently; a missing tool leaves only its own fields null. */
export async function readHostState(run: HostRunner): Promise<HostState> {
  const settle = async <T>(read: () => Promise<T>, fallback: T) => { try { return await read(); } catch { return fallback; } };
  const [media, sink, source, banners] = await Promise.all([
    settle(() => readMedia(run), null),
    settle(async () => parseVolume(await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'])), {percent: null, muted: null}),
    settle(async () => parseVolume(await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SOURCE@'])), {percent: null, muted: null}),
    settle(async () => (await run('gsettings', ['get', 'org.gnome.desktop.notifications', 'show-banners'])).trim(), ''),
  ]);
  return HostStateSchema.parse({
    media, volumePercent: sink.percent, muted: sink.muted, micMuted: source.muted,
    doNotDisturb: banners === 'false' ? true : banners === 'true' ? false : null,
  });
}

export interface HostCollectorOptions {
  store: HubStore; run?: HostRunner; intervalMs?: number;
  /** Laptop vitals, sampled only while `active()` says the phone is watching. */
  vitals?: {reader: VitalsReader; active: () => boolean};
}
/** Polls laptop media/audio/notification state for the Deck. */
export class HostCollector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private readonly run: HostRunner;
  constructor(private readonly options: HostCollectorOptions) { this.run = options.run ?? execRunner; }
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const state = await readHostState(this.run);
      const vitals = this.options.vitals;
      if (vitals?.active()) state.vitals = await vitals.reader.read().catch(() => null);
      this.options.store.setHost(state);
    } finally { this.busy = false; }
  }
  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.options.intervalMs ?? 2000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
