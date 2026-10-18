import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { HubStore } from '../src/store.js';
import { WindowsHostHelper, parseWindowsHostState, type HelperProcess } from '../src/win/host-helper.js';
import { executeWindowsAction } from '../src/win/actions.js';
import { WindowsVitalsReader, type WindowsVitalsIo } from '../src/win/vitals.js';
import { WindowsNotificationCollector, labelMatchesApp, parseToast, type NotificationDb } from '../src/win/notifications.js';

// Synthetic data only: no real helper, toast database or app is touched. These run on every platform.

class FakeHelper extends EventEmitter implements HelperProcess {
  stdout = new PassThrough();
  written: string[] = [];
  killed = false;
  constructor(private readonly answer: (word: string) => string | null) { super(); }
  stdin = { write: (text: string) => { this.written.push(text); const reply = this.answer(text.trim()); if (reply !== null) setImmediate(() => this.stdout.write(`${reply}\n`)); return true; }, end: () => undefined };
  kill() { this.killed = true; this.emit('exit'); return true; }
  ready() { this.stdout.write('{"ok":true,"ready":true}\n'); return this; }
}

describe('Windows host helper protocol', () => {
  it('starts once, serializes fixed words and pairs each reply with its request', async () => {
    let spawned = 0;
    const child = new FakeHelper(word => JSON.stringify({ ok: true, data: { echo: word } }));
    const helper = new WindowsHostHelper(() => { spawned++; setImmediate(() => child.ready()); return child; });
    const [a, b] = await Promise.all([helper.request('state'), helper.request('vitals')]);
    expect(a.data).toEqual({ echo: 'state' }); expect(b.data).toEqual({ echo: 'vitals' });
    expect(child.written).toEqual(['state\n', 'vitals\n']); expect(spawned).toBe(1);
    helper.stop();
  });
  it('fails a request and backs off when the helper exits instead of answering', async () => {
    let now = 0, spawned = 0;
    const helper = new WindowsHostHelper(() => { spawned++; const c = new FakeHelper(() => null); setImmediate(() => c.emit('exit')); return c; }, () => now);
    await expect(helper.request('state')).rejects.toThrow();
    await expect(helper.request('state')).rejects.toThrow('HELPER_BACKOFF');
    expect(spawned).toBe(1);
    now = 120_000;
    await expect(helper.request('state')).rejects.toThrow();
    expect(spawned).toBe(2);
  });
  it('maps state onto the shared schema, clipping text and nulling what it could not read', () => {
    const state = parseWindowsHostState({ media: { player: 'P'.repeat(60), status: 'playing', title: 'T\u0007itle', artist: 'A' }, volumePercent: 99.6, muted: false, micMuted: 'x', doNotDisturb: true });
    expect(state).toEqual({ media: { player: 'P'.repeat(40), status: 'playing', title: 'T itle', artist: 'A' }, volumePercent: 100, muted: false, micMuted: null, doNotDisturb: true });
    expect(parseWindowsHostState({ media: null, volumePercent: null })).toEqual({ media: null, volumePercent: null, muted: null, micMuted: null, doNotDisturb: null });
  });
});

describe('Windows Deck keys', () => {
  const run = (action: string, installed: string[] = []) => {
    const launches: Array<[string, string[]]> = [];
    const result = executeWindowsAction(action, {
      launch: async (file, args) => { launches.push([file, args]); return true; },
      exists: path => installed.some(part => path.includes(part)), env: { LOCALAPPDATA: 'C:\\Synthetic\\Local', ProgramFiles: 'C:\\Synthetic\\PF' },
      helper: { request: async (word: string) => ({ ok: word !== 'mic_mute' }) } as unknown as WindowsHostHelper,
    });
    return { result, launches };
  };
  it('opens installed Store apps by their fixed identity and falls back to the web', async () => {
    const installed = run('open_whatsapp', ['5319275A.WhatsAppDesktop_cv1g1gvanyjgm']);
    expect(await installed.result).toEqual({ success: true, message: 'Opening WhatsApp' });
    expect(installed.launches).toEqual([['explorer.exe', ['shell:AppsFolder\\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App']]]);
    const web = run('open_chatgpt');
    expect(await web.result).toMatchObject({ success: true });
    expect(web.launches).toEqual([['explorer.exe', ['https://chatgpt.com']]]);
    const claude = run('open_claude', ['AnthropicClaude']);
    await claude.result;
    expect(claude.launches).toEqual([['explorer.exe', ['shell:AppsFolder\\com.squirrel.AnthropicClaude.claude']]]);
  });
  it('uses fixed system commands and the helper for media, volume and microphone', async () => {
    expect((await run('lock_screen').result).success).toBe(true);
    expect(run('lock_screen').launches).toEqual([['rundll32.exe', ['user32.dll,LockWorkStation']]]);
    expect(await run('volume_up').result).toEqual({ success: true, message: 'Volume +5%' });
    expect(await run('mic_mute').result).toEqual({ success: false, message: 'Action failed' });
    const dnd = run('dnd_toggle');
    expect(await dnd.result).toEqual({ success: true, message: 'Notification center opened' });
    expect(dnd.launches).toEqual([['explorer.exe', ['ms-actioncenter:']]]);
    expect(await run('rm -rf').result).toMatchObject({ success: false });
  });
});

describe('Windows vitals', () => {
  const cpu = (busy: number, idle: number) => ({ model: 'AMD Ryzen 5 5600H with Radeon Graphics', speed: 3301, times: { user: busy, nice: 0, sys: 0, irq: 0, idle } });
  it('derives per-thread load from os counters and reads GPU, memory and battery', async () => {
    let tick = 0;
    const io: WindowsVitalsIo = {
      cpus: () => tick++ === 0 ? [cpu(100, 900), cpu(100, 900)] : [cpu(150, 950), cpu(200, 900)],
      memory: () => ({ total: 16e9, free: 4e9 }),
      nvidiaSmi: async () => 'NVIDIA GeForce RTX 3050 Ti Laptop GPU, 37, 61, 12.34, 512, 4096, 1395\r\n',
      helperVitals: async () => ({ clockMhz: 3912.4, cpuTempC: 61.25, igpuPercent: 12.5, swap: { usedMb: 1024, totalMb: 4096 }, power: { ac: false, hasBattery: true, batteryPercent: 81, charging: false, minutesLeft: 95 } }),
      now: () => 0,
    };
    const reader = new WindowsVitalsReader(io);
    await reader.read();
    const v = await reader.read();
    expect(v.cpu).toEqual({ name: 'AMD Ryzen 5 5600H', usagePercent: 75, threadUsage: [50, 100], tempC: 61.3, clockMhz: 3912, powerW: null });
    expect(v.igpu).toEqual({ usagePercent: 12.5, tempC: null });
    expect(v.gpu).toMatchObject({ name: 'RTX 3050 Ti Laptop GPU', state: 'active', usagePercent: 37, tempC: 61, powerW: 12.3, memoryUsedMb: 512, memoryTotalMb: 4096, clockMhz: 1395 });
    expect(v.memory).toEqual({ usedBytes: 12e9, totalBytes: 16e9, swapUsedBytes: 1024 * 2 ** 20, swapTotalBytes: 4096 * 2 ** 20 });
    expect(v.power).toEqual({ source: 'battery', batteryPercent: 81, charging: false, watts: null, minutesLeft: 95 });
  });
  it('drops the GPU card when nvidia-smi is absent and survives a dead helper', async () => {
    const io: WindowsVitalsIo = {
      cpus: () => [], memory: () => ({ total: 0, free: 0 }),
      nvidiaSmi: async () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); },
      helperVitals: async () => { throw Error('HELPER_UNAVAILABLE'); }, now: () => 0,
    };
    expect(await new WindowsVitalsReader(io).read()).toEqual({ cpu: null, gpu: null, igpu: null, memory: null, power: null, storageTempC: null });
  });
});

describe('Windows notification capture', () => {
  it('parses a toast binding into title and body, dropping attribution and decoding entities once', () => {
    const xml = '<toast><visual><binding template="ToastGeneric"><text>Synthetic &amp; title</text><text>body &amp;lt;b&amp;gt; &#x263A;</text><text placement="attribution">via synthetic</text><text/></binding></visual></toast>';
    expect(parseToast(xml)).toEqual({ title: 'Synthetic & title', body: 'body &lt;b&gt; \u263A' });
  });
  it('matches allowlist labels to app identities ignoring case and spaces', () => {
    expect(labelMatchesApp('WhatsApp', '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App')).toBe(true);
    expect(labelMatchesApp('Claude', 'com.squirrel.AnthropicClaude.claude')).toBe(true);
    expect(labelMatchesApp('Claude Code', 'com.squirrel.AnthropicClaude.claude')).toBe(false);
    expect(labelMatchesApp('ab', 'abc')).toBe(false);
  });
  const fakeDb = () => {
    const rows: Array<{ id: number; app: string; xml: string }> = [{ id: 7, app: 'Synthetic.Old!App', xml: '<toast/>' }];
    const read: number[] = [];
    const db: NotificationDb = {
      maxId: () => Math.max(0, ...rows.map(r => r.id)),
      newer: (after, limit) => rows.filter(r => r.id > after).slice(0, limit).map(({ id, app }) => ({ id, app })),
      payload: id => { read.push(id); return rows.find(r => r.id === id)?.xml ?? null; },
      close: () => undefined,
    };
    return { rows, read, db };
  };
  const toast = (title: string, body: string) => `<toast><visual><binding template="ToastGeneric"><text>${title}</text><text>${body}</text></binding></visual></toast>`;
  it('never replays history, reads payloads only for allowed apps and forwards them', async () => {
    const { rows, read, db } = fakeDb();
    const store = new HubStore();
    const collector = new WindowsNotificationCollector({ store, clock: { nowMs: () => 5_000 }, open: async () => db, intervalMs: 3_600_000 });
    await collector.start(['WhatsApp']);
    expect(collector.capability).toEqual({ state: 'available', errorCode: null });
    rows.push({ id: 8, app: 'Synthetic.Other!App', xml: toast('secret', 'not allowed') }, { id: 9, app: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App', xml: toast('Synthetic sender', 'synthetic message') });
    await collector.poll();
    expect(read).toEqual([9]);
    expect(store.snapshot(5_000).notifications.items).toMatchObject([{ appId: 'WhatsApp', title: 'Synthetic sender', body: 'synthetic message' }]);
    await collector.stop();
    expect(store.snapshot(5_000).notifications.state).toBe('disabled');
  });
  it('reports the capture unavailable when the database cannot be opened', async () => {
    const store = new HubStore();
    const collector = new WindowsNotificationCollector({ store, open: async () => { throw Error('locked'); }, intervalMs: 3_600_000 });
    await collector.start(['WhatsApp']);
    expect(collector.capability).toEqual({ state: 'unavailable', errorCode: 'NOTIFICATION_MONITOR_UNAVAILABLE' });
    await collector.stop();
  });
});
