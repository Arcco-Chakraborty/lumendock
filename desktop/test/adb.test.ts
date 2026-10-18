import { describe, it, expect } from 'vitest';
import { AdbConnection, AdbError, defaultAdbPath, maskSerial, parseAdbDevices, parseReverseList, type AdbEvent, type ProcessResult, type ProcessRunner, type TimerClock } from '../src/adb.js';

// All serials below are recognizably synthetic.
const SERIAL = 'SYNTH0001ABCD';
const OTHER = 'SYNTH0002EFGH';
const usbLine = (serial: string, state = 'device', extra = 'usb:1-2 product:synth model:Synthetic_Phone device:synth transport_id:3') => `${serial}\t${state} ${extra}`;
const listing = (...lines: string[]) => `List of devices attached\n${lines.join('\n')}\n\n`;

interface Call { file: string; args: string[]; signal: AbortSignal | undefined }
class FakeRunner implements ProcessRunner {
  calls: Call[] = [];
  devices = listing(usbLine(SERIAL));
  reverseList = '';
  reverseSet: ProcessResult = { code: 0, stdout: '8765\n', stderr: '' };
  mapOnSet = true;
  hang = false;
  failAll: Error | null = null;
  inflight = 0;
  async exec(file: string, args: readonly string[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ProcessResult> {
    this.calls.push({ file, args: [...args], signal: options?.signal });
    if (this.failAll) throw this.failAll;
    if (this.hang) {
      this.inflight++;
      await new Promise<void>((_, reject) => options?.signal?.addEventListener('abort', () => { this.inflight--; reject(new AdbError('STOPPED')); }));
    }
    const joined = args.join(' ');
    if (joined === 'devices -l') return { code: 0, stdout: this.devices, stderr: '' };
    if (args[0] === '-s' && args[2] === 'reverse' && args[3] === '--list') return { code: 0, stdout: this.reverseList, stderr: '' };
    if (args[0] === '-s' && args[2] === 'reverse' && args[3] === 'tcp:8765') {
      if (this.reverseSet.code === 0 && this.mapOnSet) this.reverseList = '(reverse) tcp:8765 tcp:8765\n';
      return this.reverseSet;
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  }
  count(predicate: (c: Call) => boolean) { return this.calls.filter(predicate).length; }
  sets() { return this.count(c => c.args.includes('tcp:8765') && c.args[2] === 'reverse' && c.args[3] === 'tcp:8765'); }
}
class FakeClock implements TimerClock {
  now = 0; private seq = 0; timers = new Map<number, { at: number; fn: () => void }>();
  setTimer(fn: () => void, ms: number) { const id = ++this.seq; this.timers.set(id, { at: this.now + ms, fn }); return id; }
  clearTimer(handle: unknown) { this.timers.delete(handle as number); }
  async advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]); this.now = due[1].at; due[1].fn();
      await flush();
    }
    this.now = target;
  }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise(r => setImmediate(r)); };
const make = (runner = new FakeRunner(), clock = new FakeClock()) => ({ runner, clock, adb: new AdbConnection({ runner, clock, pollIntervalMs: 2000 }) });
const code = async (promise: Promise<unknown>) => { try { await promise; } catch (e) { return (e as AdbError).code; } return 'NO_ERROR'; };

describe('defaultAdbPath', () => {
  it('keeps plain adb on Linux and finds platform-tools under LOCALAPPDATA on Windows', () => {
    const has = (...paths: string[]) => (path: string) => paths.includes(path);
    expect(defaultAdbPath({ LOCALAPPDATA: 'L' }, () => true, 'linux')).toBe('adb');
    const local = require('node:path').join('L', 'Android', 'platform-tools', 'adb.exe');
    expect(defaultAdbPath({ LOCALAPPDATA: 'L', PATH: '' }, has(local), 'win32')).toBe(local);
    expect(defaultAdbPath({ LOCALAPPDATA: 'L', PATH: 'P' }, has(require('node:path').join('P', 'adb.exe'), local), 'win32')).toBe('adb');
    expect(defaultAdbPath({ PATH: '' }, () => false, 'win32')).toBe('adb');
  });
});
describe('parseAdbDevices', () => {
  it('treats a local serial without a usb: path as USB only on Windows', () => {
    const out = ['List of devices attached', `${SERIAL}\tdevice product:synth model:Synthetic_Phone device:synth transport_id:1`,
      'emulator-5554\tdevice product:sdk', '192.0.2.10:5555\tdevice product:x'].join('\n');
    expect(parseAdbDevices(out, 'win32').map(d => d.transport)).toEqual(['usb', 'other', 'wireless']);
    expect(parseAdbDevices(out, 'linux').map(d => d.transport)).toEqual(['other', 'other', 'wireless']);
  });
  it('parses usb, wireless, emulator, unauthorized and ignores hostile lines', () => {
    const out = [
      '* daemon not running; starting now at tcp:5037', '* daemon started successfully', 'List of devices attached',
      usbLine(SERIAL), usbLine(OTHER, 'unauthorized'), `${'X'.repeat(600)}\tdevice usb:1-1`,
      '192.168.1.9:5555\tdevice product:a model:b device:c transport_id:9', 'adb-SYNTH-abc._adb-tls-connect._tcp\tdevice model:W',
      'emulator-5554\tdevice product:sdk', 'garbage line without tab semantics', '', '\u0000\u0001\tdevice', `SYNTH0003\tweird_state usb:1-9`,
      `-s\tdevice usb:1-3`, 'SYNTH0004\tdevice usb:1-4 model:Evil;rm$(x)'
    ].join('\r\n');
    const devices = parseAdbDevices(out);
    const by = new Map(devices.map(d => [d.serial, d]));
    expect(by.get(SERIAL)).toMatchObject({ state: 'device', transport: 'usb', model: 'Synthetic_Phone' });
    expect(by.get(OTHER)).toMatchObject({ state: 'unauthorized', transport: 'usb' });
    expect(by.get('192.168.1.9:5555')?.transport).toBe('wireless');
    expect(by.get('adb-SYNTH-abc._adb-tls-connect._tcp')?.transport).toBe('wireless');
    expect(by.get('emulator-5554')?.transport).toBe('other');
    expect(by.has('SYNTH0003')).toBe(false); // unknown state ignored
    expect(by.has('garbage')).toBe(false);
    expect(by.has('-s')).toBe(false);
    expect(by.get('SYNTH0004')?.model).toBeUndefined();
    expect(devices.some(d => d.serial.length > 128 || /[\u0000-\u001f]/.test(d.serial))).toBe(false);
  });
  it('maps the no-permissions state', () => {
    expect(parseAdbDevices(`${SERIAL}\tno permissions (user in plugdev group; are your udev rules wrong?) usb:1-2`)[0]?.state).toBe('no_permissions');
  });
  it('bounds the number of parsed lines', () => {
    const many = Array.from({ length: 5000 }, (_, i) => usbLine(`SYNTH${i}`)).join('\n');
    expect(parseAdbDevices(many).length).toBeLessThanOrEqual(64);
  });
});

describe('parseReverseList / maskSerial', () => {
  it('parses mappings and ignores garbage', () => {
    expect(parseReverseList('(reverse) tcp:8765 tcp:8765\nnonsense\n(reverse) tcp:1 tcp:2 extra\n')).toEqual([{ remote: 'tcp:8765', local: 'tcp:8765' }]);
  });
  it('masks serials', () => {
    expect(maskSerial(SERIAL)).toBe('SYNT****');
    expect(maskSerial('ABCD')).toBe('****');
    expect(maskSerial('ABCDEFGH')).toBe('ABCD****');
    expect(maskSerial(SERIAL)).not.toContain('ABCD');
  });
});

describe('ensureReverse selection safety', () => {
  it('sets and verifies the mapping with serial passed only as argv', async () => {
    const { runner, adb } = make();
    const result = await adb.ensureReverse(SERIAL);
    expect(result).toMatchObject({ serial: SERIAL, port: 8765 });
    expect(runner.calls.map(c => c.args)).toEqual([
      ['devices', '-l'], ['-s', SERIAL, 'reverse', 'tcp:8765', 'tcp:8765'], ['-s', SERIAL, 'reverse', '--list']
    ]);
    expect(runner.calls.every(c => c.file === 'adb')).toBe(true);
  });
  it('treats hostile serial strings as data or rejects them before any process', async () => {
    const { runner, adb } = make();
    for (const bad of ['a b', '$(touch x)', 'x;y', '-s', '--help', '', '..\n', 'A'.repeat(65)]) expect(await code(adb.ensureReverse(bad))).toMatch(/INVALID_SERIAL|SELECTION_REQUIRED/);
    expect(runner.calls).toHaveLength(0);
  });
  it('requires an explicit selection even when only one device exists', async () => {
    const { runner, adb } = make();
    expect(await code(adb.ensureReverse(undefined))).toBe('SELECTION_REQUIRED');
    expect(runner.sets()).toBe(0);
  });
  it('rejects multiple devices when none is selected and a wrong serial among many', async () => {
    const { runner, adb } = make();
    runner.devices = listing(usbLine(SERIAL), usbLine(OTHER));
    expect(await code(adb.ensureReverse(undefined))).toBe('SELECTION_REQUIRED');
    expect(await code(adb.ensureReverse('SYNTH9999ZZZZ'))).toBe('DEVICE_NOT_FOUND');
    expect(runner.sets()).toBe(0);
  });
  it('rejects offline, unauthorized and no-permission devices without running reverse', async () => {
    for (const [state, expected] of [['offline', 'DEVICE_OFFLINE'], ['unauthorized', 'DEVICE_UNAUTHORIZED'], ['recovery', 'DEVICE_NOT_READY']] as const) {
      const { runner, adb } = make();
      runner.devices = listing(usbLine(SERIAL, state));
      expect(await code(adb.ensureReverse(SERIAL))).toBe(expected);
      expect(runner.sets()).toBe(0);
    }
    const { runner, adb } = make();
    runner.devices = `${SERIAL}\tno permissions (udev) usb:1-2`;
    expect(await code(adb.ensureReverse(SERIAL))).toBe('DEVICE_NO_PERMISSIONS');
  });
  it('never uses wireless, mdns or emulator transports', async () => {
    const { runner, adb } = make();
    runner.devices = listing('192.168.1.9:5555\tdevice model:x', 'adb-SYNTH-abc._adb-tls-connect._tcp\tdevice model:x', 'emulator-5554\tdevice product:sdk');
    for (const serial of ['192.168.1.9:5555', 'adb-SYNTH-abc._adb-tls-connect._tcp', 'SYNTHtcpPHONE']) expect(await code(adb.ensureReverse(serial))).toBe('WIRELESS_DEVICE_REJECTED');
    expect(await code(adb.ensureReverse('emulator-5554'))).toBe('DEVICE_NOT_USB');
    expect(runner.sets()).toBe(0);
  });
});

describe('ensureReverse failures', () => {
  it('maps port conflicts to a fixed actionable error without killing anything', async () => {
    const { runner, adb } = make();
    runner.reverseSet = { code: 1, stdout: '', stderr: `adb: error: cannot bind 'tcp:8765' for ${SERIAL}: Address already in use` };
    const error = await adb.ensureReverse(SERIAL).catch(e => e as AdbError);
    expect(error.code).toBe('PORT_CONFLICT');
    expect(error.message).toMatch(/8765/);
    expect(error.message).not.toContain(SERIAL);
    expect(runner.calls.some(c => c.args.includes('kill-server') || c.args.includes('--remove-all') || c.file === 'kill' || c.file === 'pkill')).toBe(false);
  });
  it('detects a conflicting existing mapping and an unverifiable one', async () => {
    const a = make();
    a.runner.mapOnSet = false; a.runner.reverseList = '(reverse) tcp:8765 tcp:9999\n';
    expect(await code(a.adb.ensureReverse(SERIAL))).toBe('PORT_CONFLICT');
    const b = make();
    b.runner.mapOnSet = false;
    expect(await code(b.adb.ensureReverse(SERIAL))).toBe('REVERSE_VERIFY_FAILED');
  });
  it('maps other adb failures without leaking stderr', async () => {
    const { runner, adb } = make();
    runner.reverseSet = { code: 1, stdout: '', stderr: `error: device '${SERIAL}' not found` };
    const error = await adb.ensureReverse(SERIAL).catch(e => e as AdbError);
    expect(error.code).toBe('DEVICE_NOT_FOUND');
    expect(error.message).not.toContain(SERIAL);
    runner.reverseSet = { code: 1, stdout: '', stderr: 'weird' };
    expect(await code(adb.ensureReverse(SERIAL))).toBe('REVERSE_FAILED');
  });
  it('reports a missing adb binary as unavailable', async () => {
    const { runner, adb } = make();
    runner.failAll = new Error('spawn adb ENOENT');
    expect(await code(adb.ensureReverse(SERIAL))).toBe('ADB_UNAVAILABLE');
  });
});

describe('connection watcher', () => {
  const events = () => { const list: AdbEvent[] = []; return { list, on: (e: AdbEvent) => { list.push(e); } }; };
  it('connects, then restores the mapping after unplug and replug', async () => {
    const { runner, clock, adb } = make(); const ev = events();
    await adb.start(SERIAL, ev.on);
    expect(ev.list.map(e => e.state)).toEqual(['connected']);
    expect(runner.sets()).toBe(1);
    // unplugged
    runner.devices = listing(); runner.reverseList = '';
    await clock.advance(2000);
    expect(ev.list.at(-1)).toMatchObject({ state: 'waiting', code: 'DEVICE_NOT_FOUND' });
    // replugged without authorization, then authorized
    runner.devices = listing(usbLine(SERIAL, 'unauthorized'));
    await clock.advance(2000);
    expect(ev.list.at(-1)).toMatchObject({ state: 'waiting', code: 'DEVICE_UNAUTHORIZED' });
    runner.devices = listing(usbLine(SERIAL));
    await clock.advance(2000);
    expect(ev.list.at(-1)).toMatchObject({ state: 'connected' });
    expect(runner.sets()).toBe(2);
    // steady state: no repeated set, no duplicate events
    const before = ev.list.length;
    await clock.advance(6000);
    expect(runner.sets()).toBe(2);
    expect(ev.list).toHaveLength(before);
    await adb.stop();
  });
  it('restores a mapping lost while the device stayed listed (fast replug / server restart)', async () => {
    const { runner, clock, adb } = make();
    await adb.start(SERIAL);
    runner.reverseList = '';
    await clock.advance(2000);
    expect(runner.sets()).toBe(2);
    await adb.stop();
  });
  it('backs off on hard errors but keeps the bounded poll interval while waiting for a device', async () => {
    const { runner, clock, adb } = make();
    runner.devices = listing();
    await adb.start(SERIAL);
    const base = runner.count(c => c.args[0] === 'devices');
    await clock.advance(6000);
    expect(runner.count(c => c.args[0] === 'devices') - base).toBe(3);
    runner.devices = listing(usbLine(SERIAL)); runner.reverseSet = { code: 1, stdout: '', stderr: 'Address already in use' };
    await clock.advance(2000);
    const afterFirst = runner.sets();
    await clock.advance(2000);
    expect(runner.sets()).toBe(afterFirst); // backed off past 2s
    await clock.advance(10_000);
    expect(runner.sets()).toBeGreaterThan(afterFirst);
    await adb.stop();
  });
  it('stop leaves no timers, aborts the in-flight child and ignores late results', async () => {
    const { runner, clock, adb } = make(); const ev = events();
    await adb.start(SERIAL, ev.on);
    expect(clock.timers.size).toBe(1);
    runner.hang = true;
    await clock.advance(2000);
    expect(runner.inflight).toBe(1);
    const signal = runner.calls.at(-1)!.signal!;
    await adb.stop();
    expect(signal.aborted).toBe(true);
    expect(runner.inflight).toBe(0);
    expect(clock.timers.size).toBe(0);
    const calls = runner.calls.length; const count = ev.list.length;
    await clock.advance(60_000);
    expect(runner.calls).toHaveLength(calls);
    expect(ev.list).toHaveLength(count);
  });
  it('stop during the first poll resolves start quietly and leaves nothing behind', async () => {
    const { runner, clock, adb } = make(); runner.hang = true;
    const started = adb.start(SERIAL); await flush();
    await adb.stop(); await started;
    expect(clock.timers.size).toBe(0); expect(runner.inflight).toBe(0);
  });
  it('rejects a second start, allows restart after stop, and validates the serial first', async () => {
    const { runner, clock, adb } = make();
    expect(await code(adb.start('bad serial'))).toBe('INVALID_SERIAL');
    expect(await code(adb.start('10.0.0.5:5555'))).toBe('WIRELESS_DEVICE_REJECTED');
    expect(runner.calls).toHaveLength(0);
    await adb.start(SERIAL);
    expect(await code(adb.start(SERIAL))).toBe('ALREADY_STARTED');
    await adb.stop(); await adb.stop();
    expect(clock.timers.size).toBe(0);
    await adb.start(SERIAL); expect(clock.timers.size).toBe(1);
    await adb.stop(); expect(clock.timers.size).toBe(0);
  });
  // Windows adb never reports a usb: path, so this Linux signal does not exist there.
  it.skipIf(process.platform === 'win32')('a listed device that stops reporting a USB port never gets a mapping', async () => {
    const { runner, clock, adb } = make(); const ev = events();
    await adb.start(SERIAL, ev.on);
    runner.devices = listing(`${SERIAL}\tdevice product:x`); runner.reverseList = '';
    await clock.advance(2000);
    expect(ev.list.at(-1)).toMatchObject({ state: 'waiting', code: 'DEVICE_NOT_USB' });
    expect(runner.sets()).toBe(1);
    await adb.stop();
  });
});

describe('fresh-boot adb server', () => {
  it('settles when the command exits even though a process it started still holds the pipes', async () => {
    const { nodeRunner } = await import('../src/adb.js');
    // Like adb starting its server: the child exits at once, its own child keeps stdout open for 4 s.
    const script = "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:['ignore','inherit','inherit']}).unref();console.log('listed')";
    const started = Date.now();
    const result = await nodeRunner.exec(process.execPath, ['-e', script], { timeoutMs: 8000 });
    expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('listed') });
    expect(Date.now() - started).toBeLessThan(3000);
  });
  it('makes sure a server runs before every device listing', async () => {
    const order: string[] = [];
    const adb = new AdbConnection({
      runner: { exec: async (_file, args) => { order.push(args.join(' ')); return { code: 0, stdout: 'List of devices attached\n', stderr: '' }; } },
      ensureServer: async () => { order.push('ensure'); },
    });
    await expect(adb.ensureReverse('SYNTH0001')).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
    expect(order).toEqual(['ensure', 'devices -l']);
  });
});
