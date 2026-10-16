import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdbConnection, AdbError, type ProcessResult, type ProcessRunner, type TimerClock } from '../src/adb.js';
import { runDoctor, formatDoctorText, type DoctorInput } from '../src/doctor.js';
import { parseOptions, runConnectCommand, runDoctorCommand, runInstallHubCommand, runUninstallHubCommand } from '../src/setup-cli.js';
import { SERVICE_NAME } from '../src/service.js';

const SERIAL = 'SYNTH0001ABCD';
const ok = (stdout = '', stderr = ''): ProcessResult => ({ code: 0, stdout, stderr });
class Runner implements ProcessRunner {
  calls: string[][] = [];
  missing = new Set<string>();
  mapped = false;
  devices = `List of devices attached\n${SERIAL}\tdevice usb:1-2 product:p model:Synthetic_Phone device:d transport_id:1\nSYNTH0002WXYZ\tunauthorized usb:1-3\n10.0.0.2:5555\tdevice model:W\n`;
  async exec(file: string, args: readonly string[]): Promise<ProcessResult> {
    this.calls.push([file, ...args]);
    if (this.missing.has(file)) throw new AdbError('ADB_UNAVAILABLE');
    const joined = args.join(' ');
    if (file.endsWith('java')) return ok('', 'openjdk version "17.0.20.1" 2026-01-20\n');
    if (file === 'claude') return ok('2.1.300 (Claude Code)\n');
    if (file === 'codex') return ok('codex-cli 0.162.0-alpha.17.2\n');
    if (joined === 'version') return ok('Android Debug Bridge version 1.0.41\nVersion 34.0.5-12345\nInstalled as /x/adb\n');
    if (joined === 'devices -l') return ok(this.devices);
    if (args[2] === 'reverse' && args[3] === 'tcp:8765') { this.mapped = true; return ok(); }
    if (args[2] === 'reverse' && args[3] === '--list') return ok(this.mapped ? '(reverse) tcp:8765 tcp:8765\n' : '');
    if (args[2] === 'shell') return ok({ 'ro.product.model': 'Synthetic Phone', 'ro.build.version.release': '10', 'ro.build.version.sdk': '29', 'ro.miui.ui.version.name': 'V12' }[args[4]!] ?? '');
    return { code: 1, stdout: '', stderr: '' };
  }
}
const input = (runner: Runner, extra: Partial<DoctorInput> = {}): DoctorInput => ({
  nodeVersion: '24.22.0', env: { JAVA_HOME: '/synthetic/jdk17', ANDROID_HOME: '/synthetic/sdk' }, artifacts: { hub: true, apk: false }, runner,
  fileExists: p => ['/synthetic/jdk17/bin/javac', '/synthetic/sdk/platforms/android-36'].includes(p), listDir: () => ['34.0.0', '36.0.0'], ...extra
});
const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { out: (l: string) => { out.push(l); }, err: (l: string) => { err.push(l); } } }; };

describe('doctor', () => {
  it('reports versions and masks serials and omits paths', async () => {
    const report = await runDoctor(input(new Runner()));
    expect(report.ok).toBe(true);
    expect(report.checks.find(c => c.id === 'adb')?.version).toBe('34.0.5-12345');
    expect(report.checks.find(c => c.id === 'jdk')).toMatchObject({ status: 'ok', version: '17.0.20.1' });
    expect(report.checks.find(c => c.id === 'android-sdk')?.status).toBe('ok');
    expect(report.checks.find(c => c.id === 'codex')?.detail).toBeUndefined();
    expect(report.devices).toMatchObject({ unauthorized: 1, wirelessIgnored: 1 });
    expect(report.devices.authorizedUsb).toEqual([{ index: 1, serialMasked: 'SYNT****', model: 'Synthetic_Phone' }]);
    const shared = JSON.stringify(report) + formatDoctorText(report);
    expect(shared).not.toContain(SERIAL); expect(shared).not.toContain('SYNTH0002WXYZ'); expect(shared).not.toContain('10.0.0.2'); expect(shared).not.toContain('/synthetic');
  });
  it('shows full serials only with --show-serial and passes the serial as argv for property reads', async () => {
    const runner = new Runner();
    const report = await runDoctor(input(runner, { showSerial: true, selectedSerial: SERIAL }));
    expect(report.devices.authorizedUsb[0]?.serial).toBe(SERIAL);
    expect(report.devices.selected).toEqual({ model: 'Synthetic Phone', androidRelease: '10', apiLevel: '29', miuiVersion: 'V12' });
    expect(runner.calls.filter(c => c.includes('getprop')).every(c => c[1] === '-s' && c[2] === SERIAL)).toBe(true);
    const masked = await runDoctor(input(new Runner(), { selectedSerial: SERIAL }));
    expect(JSON.stringify(masked)).not.toContain(SERIAL);
  });
  it('degrades without throwing when tools are missing and fails only for node/adb', async () => {
    const runner = new Runner(); runner.missing = new Set(['adb', 'claude', 'codex']);
    const report = await runDoctor(input(runner, { nodeVersion: '20.20.2', env: {} }));
    expect(report.ok).toBe(false);
    expect(Object.fromEntries(report.checks.map(c => [c.id, c.status]))).toMatchObject({ node: 'fail', adb: 'fail', claude: 'warn', codex: 'warn' });
    expect(report.devices.authorizedUsb).toEqual([]);
  });
  it('marks physical checks UNRUN when no authorized device is attached', async () => {
    const runner = new Runner(); runner.devices = 'List of devices attached\n\n';
    expect((await runDoctor(input(runner))).notes.join(' ')).toMatch(/UNRUN/);
  });
  it('command: json and text modes, strict arguments, exit codes', async () => {
    const collect = async (o: object) => input(new Runner(), o);
    const j = io();
    expect(await runDoctorCommand(['--json'], { io: j.io, collect })).toBe(0);
    expect(JSON.parse(j.out[0]!).v).toBe(1);
    const t = io();
    expect(await runDoctorCommand([], { io: t.io, collect })).toBe(0);
    expect(t.out[0]).toContain('LumenDock doctor');
    const bad = io();
    expect(await runDoctorCommand(['--serial'], { io: bad.io, collect })).toBe(2);
    expect(await runDoctorCommand(['--nope'], { io: bad.io, collect })).toBe(2);
    expect(await runDoctorCommand(['--toString'], { io: bad.io, collect })).toBe(2);
  });
});

describe('parseOptions', () => {
  it('rejects unknown, duplicate and valueless options', () => {
    const spec = { '--a': 'flag', '--b': 'value' } as const;
    expect(typeof parseOptions(['--c'], spec)).toBe('string');
    expect(typeof parseOptions(['--a', '--a'], spec)).toBe('string');
    expect(typeof parseOptions(['--b', '--a'], spec)).toBe('string');
    expect(typeof parseOptions(['positional'], spec)).toBe('string');
  });
});

describe('connect command', () => {
  class FakeClock implements TimerClock { timers = 0; setTimer() { this.timers++; return this.timers; } clearTimer() { this.timers = Math.max(0, this.timers - 1); } }
  const make = (runner: Runner) => () => new AdbConnection({ runner, clock: new FakeClock() });
  it('requires an explicit serial and rejects bad usage without touching adb', async () => {
    const runner = new Runner(); const c = io();
    expect(await runConnectCommand([], { io: c.io, createAdb: make(runner), signal: new AbortController().signal })).toBe(2);
    expect(await runConnectCommand(['--serial'], { io: c.io, createAdb: make(runner), signal: new AbortController().signal })).toBe(2);
    expect(runner.calls).toHaveLength(0);
  });
  it('--once reports success with a masked serial', async () => {
    const runner = new Runner(); const c = io();
    expect(await runConnectCommand(['--serial', SERIAL, '--once'], { io: c.io, createAdb: make(runner), signal: new AbortController().signal })).toBe(0);
    expect(c.out.join('\n')).toContain('SYNT****'); expect(c.out.join('\n')).not.toContain(SERIAL);
    expect(runner.calls.some(a => a.join(' ') === `adb -s ${SERIAL} reverse tcp:8765 tcp:8765`)).toBe(true);
  });
  it('fails closed with an actionable message for wireless and unauthorized devices', async () => {
    const runner = new Runner(); const c = io();
    expect(await runConnectCommand(['--serial', '10.0.0.2:5555', '--once'], { io: c.io, createAdb: make(runner), signal: new AbortController().signal })).toBe(1);
    expect(await runConnectCommand(['--serial', 'SYNTH0002WXYZ', '--once'], { io: c.io, createAdb: make(runner), signal: new AbortController().signal })).toBe(1);
    expect(c.err.join('\n')).toMatch(/USB cable/); expect(c.err.join('\n')).toMatch(/Allow USB debugging/);
    expect(runner.calls.some(a => a.includes('reverse'))).toBe(false);
  });
  it('foreground mode watches until the signal aborts, then stops cleanly', async () => {
    const runner = new Runner(); const c = io(); const abort = new AbortController();
    const done = runConnectCommand(['--serial', SERIAL], { io: c.io, createAdb: make(runner), signal: abort.signal });
    await new Promise(r => setTimeout(r, 20)); abort.abort();
    expect(await done).toBe(0);
    expect(c.out.join('\n')).toMatch(/Connected: reverse tcp:8765/); expect(c.out.at(-1)).toBe('Stopped.');
  });
});

describe('install-hub / uninstall-hub commands', () => {
  const dirs = () => {
    const base = mkdtempSync(join(tmpdir(), 'pm-cli-'));
    mkdirSync(join(base, 'dist'), { recursive: true }); writeFileSync(join(base, 'dist', 'main.js'), '');
    const calls: string[][] = [];
    return { base, calls, deps: { systemctl: async (a: readonly string[]) => { calls.push([...a]); return ok(); }, nodePath: process.execPath, hubPath: join(base, 'dist', 'main.js'), configDir: join(base, 'cfg', 'phone-monitor'), unitDir: join(base, 'units'), nodeMajor: 24 } };
  };
  it('--print writes nothing; default install does not enable; --enable is explicit', async () => {
    const d = dirs(); const c = io();
    expect(await runInstallHubCommand(['--print'], { io: c.io, ...d.deps })).toBe(0);
    expect(c.out[0]).toContain('ExecStart='); expect(existsSync(d.deps.unitDir)).toBe(false); expect(d.calls).toEqual([]);
    expect(await runInstallHubCommand([], { io: c.io, ...d.deps })).toBe(0);
    expect(d.calls).toEqual([['daemon-reload']]);
    expect(c.out.join('\n')).toContain('Not enabled or started');
    expect(await runInstallHubCommand(['--enable'], { io: c.io, ...d.deps })).toBe(0);
    expect(d.calls.at(-1)).toEqual(['enable', '--now', SERVICE_NAME]);
  });
  it('refuses a non-24 Node unless --node is explicit and rejects bad usage', async () => {
    const d = dirs(); const c = io();
    expect(await runInstallHubCommand([], { io: c.io, ...d.deps, nodeMajor: 20 })).toBe(1);
    expect(await runInstallHubCommand(['--bogus'], { io: c.io, ...d.deps })).toBe(2);
    expect(d.calls).toEqual([]);
  });
  it('uninstall preserves a modified unit with a clear message and exits non-zero', async () => {
    const d = dirs(); const c = io();
    await runInstallHubCommand([], { io: c.io, ...d.deps });
    const unit = join(d.deps.unitDir, SERVICE_NAME);
    writeFileSync(unit, `${readFileSync(unit, 'utf8')}# mine\n`);
    expect(await runUninstallHubCommand([], { io: c.io, ...d.deps })).toBe(1);
    expect(c.err.join('\n')).toMatch(/modified after installation/); expect(readFileSync(unit, 'utf8')).toContain('# mine');
  });
  it('uninstall removes the owned unit and keeps configuration', async () => {
    const d = dirs(); const c = io();
    await runInstallHubCommand([], { io: c.io, ...d.deps });
    writeFileSync(join(d.deps.configDir, 'phone-token'), 'synthetic');
    expect(await runUninstallHubCommand([], { io: c.io, ...d.deps })).toBe(0);
    expect(existsSync(join(d.deps.unitDir, SERVICE_NAME))).toBe(false); expect(existsSync(join(d.deps.configDir, 'phone-token'))).toBe(true);
    expect(await runUninstallHubCommand([], { io: c.io, ...d.deps })).toBe(0);
    expect(c.out.join('\n')).toMatch(/nothing was changed/);
  });
});
