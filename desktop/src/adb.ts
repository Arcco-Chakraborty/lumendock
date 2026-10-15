import { execFile } from 'node:child_process';

// Selected-device USB reverse management. Every adb call is an argv array run
// without a shell. Errors carry fixed codes/messages and never echo adb output,
// because adb output can contain device serials.

export const HUB_PORT = 8765;
const PORT_SPEC = `tcp:${HUB_PORT}`;
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_DEVICE_LINES = 64;
const MAX_LINE_LENGTH = 512;
const MAX_BACKOFF_MS = 10_000;

export type AdbErrorCode =
  | 'INVALID_SERIAL' | 'SELECTION_REQUIRED' | 'DEVICE_NOT_FOUND' | 'WIRELESS_DEVICE_REJECTED' | 'DEVICE_NOT_USB'
  | 'DEVICE_UNAUTHORIZED' | 'DEVICE_OFFLINE' | 'DEVICE_NO_PERMISSIONS' | 'DEVICE_NOT_READY'
  | 'PORT_CONFLICT' | 'REVERSE_FAILED' | 'REVERSE_VERIFY_FAILED'
  | 'ADB_UNAVAILABLE' | 'ADB_TIMEOUT' | 'ADB_OUTPUT_TOO_LARGE' | 'STOPPED' | 'ALREADY_STARTED';

export const ADB_ERROR_MESSAGES: Record<AdbErrorCode, string> = {
  INVALID_SERIAL: 'The device serial is not a valid USB serial. Copy it from `adb devices -l`.',
  SELECTION_REQUIRED: 'Select the phone explicitly with --serial SERIAL; no device is chosen automatically.',
  DEVICE_NOT_FOUND: 'The selected device is not attached. Check the cable and the serial, then retry.',
  WIRELESS_DEVICE_REJECTED: 'Wireless/mDNS devices are not used. Connect the phone by USB cable and select its USB serial.',
  DEVICE_NOT_USB: 'The selected device is not a physical USB device (no USB port reported).',
  DEVICE_UNAUTHORIZED: 'The phone has not authorized this computer. Unlock it and tap "Allow USB debugging" on the phone.',
  DEVICE_OFFLINE: 'The device is offline. Reconnect the cable or toggle USB debugging on the phone.',
  DEVICE_NO_PERMISSIONS: 'This user cannot access the USB device (missing udev rules/plugdev group). Fix permissions, then retry.',
  DEVICE_NOT_READY: 'The device is not in normal "device" state (bootloader/recovery/connecting). Wait or reboot it normally.',
  PORT_CONFLICT: `Port ${HUB_PORT} is already in use or mapped differently. Close the other program or reverse mapping that uses tcp:${HUB_PORT}; nothing was stopped for you.`,
  REVERSE_FAILED: 'adb could not create the reverse mapping. Check `adb devices -l` and retry.',
  REVERSE_VERIFY_FAILED: 'The reverse mapping was not present after setup. Retry; if it persists restart adb manually.',
  ADB_UNAVAILABLE: 'adb could not be run. Install Android platform-tools or pass --adb PATH.',
  ADB_TIMEOUT: 'adb did not answer in time.',
  ADB_OUTPUT_TOO_LARGE: 'adb produced unexpectedly large output.',
  STOPPED: 'The operation was stopped.',
  ALREADY_STARTED: 'A connection watcher is already running; stop it first.'
};
export class AdbError extends Error {
  constructor(readonly code: AdbErrorCode) { super(ADB_ERROR_MESSAGES[code]); this.name = 'AdbError'; }
}

export interface ProcessResult { code: number | null; stdout: string; stderr: string }
export interface ProcessRunner {
  exec(file: string, args: readonly string[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ProcessResult>;
}
export interface TimerClock { setTimer(fn: () => void, ms: number): unknown; clearTimer(handle: unknown): void }

/** Real runner: execFile never uses a shell; a non-zero exit is a result, not an exception. */
export const nodeRunner: ProcessRunner = {
  exec: (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, [...args], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: options?.timeoutMs ?? COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES, ...(options?.signal ? { signal: options.signal } : {})
    }, (error, stdout, stderr) => {
      if (!error) { resolve({ code: 0, stdout, stderr }); return; }
      const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      if (options?.signal?.aborted || e.name === 'AbortError') reject(new AdbError('STOPPED'));
      else if (e.code === 'ENOENT' || e.code === 'EACCES') reject(new AdbError('ADB_UNAVAILABLE'));
      else if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new AdbError('ADB_OUTPUT_TOO_LARGE'));
      else if (e.killed) reject(new AdbError('ADB_TIMEOUT'));
      else resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  })
};
export const realClock: TimerClock = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export type AdbDeviceState = 'device' | 'offline' | 'unauthorized' | 'no_permissions' | 'other_ready_state';
export interface AdbDevice { serial: string; state: AdbDeviceState; transport: 'usb' | 'wireless' | 'other'; model?: string }

const SERIAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WIRELESS_PATTERN = /:|tcp|mdns|_adb|^adb-/i;
const KNOWN_OTHER_STATES = new Set(['authorizing', 'connecting', 'bootloader', 'recovery', 'sideload', 'rescue', 'host', 'detached']);
const USB_PORT_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$/;
const MODEL_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;

export const isWirelessSerial = (serial: string): boolean => WIRELESS_PATTERN.test(serial);

/** Parses `adb devices -l`. Unknown/hostile/oversized lines are dropped, never thrown on. */
export function parseAdbDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  const seen = new Set<string>();
  for (const raw of output.split(/\r?\n/).slice(0, 2000)) {
    if (raw.length > MAX_LINE_LENGTH) continue;
    const tokens = raw.trim().split(/\s+/);
    const serial = tokens[0] ?? '';
    if (tokens.length < 2 || seen.has(serial)) continue;
    const wireless = isWirelessSerial(serial);
    // Wireless forms contain characters (':' ...) outside the USB serial pattern; keep them so they can be rejected explicitly.
    if (!wireless && !SERIAL_PATTERN.test(serial)) continue;
    if (wireless && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(serial)) continue;
    const stateToken = tokens[1] ?? '';
    let state: AdbDeviceState;
    if (stateToken === 'device' || stateToken === 'offline' || stateToken === 'unauthorized') state = stateToken;
    else if (stateToken === 'no' && tokens[2] === 'permissions') state = 'no_permissions';
    else if (KNOWN_OTHER_STATES.has(stateToken)) state = 'other_ready_state';
    else continue;
    const attributes = new Map<string, string>();
    for (const token of tokens.slice(2)) {
      const index = token.indexOf(':');
      if (index > 0 && !attributes.has(token.slice(0, index))) attributes.set(token.slice(0, index), token.slice(index + 1));
    }
    const usb = attributes.get('usb');
    const model = attributes.get('model');
    const transport = wireless ? 'wireless' : usb !== undefined && USB_PORT_PATTERN.test(usb) ? 'usb' : 'other';
    devices.push({ serial, state, transport, ...(model !== undefined && MODEL_PATTERN.test(model) ? { model } : {}) });
    seen.add(serial);
    if (devices.length >= MAX_DEVICE_LINES) break;
  }
  return devices;
}

export interface ReverseMapping { remote: string; local: string }
/** Parses `adb reverse --list` lines `(reverse) tcp:A tcp:B`. */
export function parseReverseList(output: string): ReverseMapping[] {
  const mappings: ReverseMapping[] = [];
  for (const line of output.split(/\r?\n/).slice(0, 200)) {
    if (line.length > MAX_LINE_LENGTH) continue;
    const tokens = line.trim().split(/\s+/);
    if (tokens.length === 3 && /^[a-z]+:\S+$/.test(tokens[1]!) && /^[a-z]+:\S+$/.test(tokens[2]!)) mappings.push({ remote: tokens[1]!, local: tokens[2]! });
  }
  return mappings;
}

/** Hides the last four characters (all of a short serial) so shared output never carries a full serial. */
export function maskSerial(serial: string): string {
  return `${serial.slice(0, Math.min(4, Math.max(0, serial.length - 4)))}****`;
}

export function validateSerial(serial: string | undefined): string {
  if (serial === undefined || serial === '') throw new AdbError('SELECTION_REQUIRED');
  if (isWirelessSerial(serial)) throw new AdbError('WIRELESS_DEVICE_REJECTED');
  if (!SERIAL_PATTERN.test(serial)) throw new AdbError('INVALID_SERIAL');
  return serial;
}

/** Returns the explicitly selected device only when it is an authorized physical USB device. */
export function selectDevice(devices: readonly AdbDevice[], serial: string | undefined): AdbDevice {
  const selected = validateSerial(serial);
  const device = devices.find(d => d.serial === selected);
  if (!device) throw new AdbError('DEVICE_NOT_FOUND');
  if (device.transport === 'wireless') throw new AdbError('WIRELESS_DEVICE_REJECTED');
  if (device.transport !== 'usb') throw new AdbError('DEVICE_NOT_USB');
  switch (device.state) {
    case 'device': return device;
    case 'unauthorized': throw new AdbError('DEVICE_UNAUTHORIZED');
    case 'offline': throw new AdbError('DEVICE_OFFLINE');
    case 'no_permissions': throw new AdbError('DEVICE_NO_PERMISSIONS');
    default: throw new AdbError('DEVICE_NOT_READY');
  }
}

function classifyFailure(stderr: string): AdbErrorCode {
  if (/address already in use|already in use|cannot bind|in use/i.test(stderr)) return 'PORT_CONFLICT';
  if (/unauthorized/i.test(stderr)) return 'DEVICE_UNAUTHORIZED';
  if (/offline/i.test(stderr)) return 'DEVICE_OFFLINE';
  if (/not found|no devices|no such device/i.test(stderr)) return 'DEVICE_NOT_FOUND';
  return 'REVERSE_FAILED';
}
const hubMapping = (mappings: readonly ReverseMapping[]) => mappings.filter(m => m.remote === PORT_SPEC);

export interface ReverseResult { serial: string; model?: string; port: number }
export type AdbEvent =
  | { state: 'connected'; serial: string; port: number }
  | { state: 'waiting'; code: AdbErrorCode; message: string };
export interface AdbConnectionOptions {
  runner?: ProcessRunner; clock?: TimerClock; adbPath?: string; pollIntervalMs?: number;
}
interface Run { serial: string; signal: AbortSignal; abort: AbortController; timer: unknown; inflight: Promise<void> | null; stopped: boolean; failures: number; last: string | null; listener: ((event: AdbEvent) => void) | undefined }

export class AdbConnection {
  private readonly runner: ProcessRunner;
  private readonly clock: TimerClock;
  private readonly adbPath: string;
  private readonly pollIntervalMs: number;
  private active: Run | null = null;

  constructor(options: AdbConnectionOptions = {}) {
    this.runner = options.runner ?? nodeRunner;
    this.clock = options.clock ?? realClock;
    this.adbPath = options.adbPath ?? 'adb';
    this.pollIntervalMs = Math.min(30_000, Math.max(500, options.pollIntervalMs ?? 2000));
  }

  private async adb(args: string[], signal?: AbortSignal): Promise<ProcessResult> {
    try { return await this.runner.exec(this.adbPath, args, { timeoutMs: COMMAND_TIMEOUT_MS, ...(signal ? { signal } : {}) }); }
    catch (error) { throw error instanceof AdbError ? error : new AdbError('ADB_UNAVAILABLE'); }
  }
  private async listDevices(signal?: AbortSignal): Promise<AdbDevice[]> {
    const result = await this.adb(['devices', '-l'], signal);
    if (result.code !== 0) throw new AdbError('ADB_UNAVAILABLE');
    return parseAdbDevices(result.stdout);
  }
  /** Reads the mapping state: true when exactly the hub mapping exists; throws PORT_CONFLICT on a different local port. */
  private async mappingPresent(serial: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.adb(['-s', serial, 'reverse', '--list'], signal);
    if (result.code !== 0) return false;
    const mine = hubMapping(parseReverseList(result.stdout));
    if (mine.some(m => m.local === PORT_SPEC)) return true;
    if (mine.length > 0) throw new AdbError('PORT_CONFLICT');
    return false;
  }
  private async applyReverse(device: AdbDevice, signal?: AbortSignal): Promise<ReverseResult> {
    const set = await this.adb(['-s', device.serial, 'reverse', PORT_SPEC, PORT_SPEC], signal);
    if (set.code !== 0) throw new AdbError(classifyFailure(set.stderr));
    if (!await this.mappingPresent(device.serial, signal)) throw new AdbError('REVERSE_VERIFY_FAILED');
    return { serial: device.serial, port: HUB_PORT, ...(device.model ? { model: device.model } : {}) };
  }

  /** One-shot: select, set and verify `reverse tcp:8765 tcp:8765` for an explicitly selected authorized USB device. */
  async ensureReverse(serial: string | undefined, signal?: AbortSignal): Promise<ReverseResult> {
    validateSerial(serial);
    const device = selectDevice(await this.listDevices(signal), serial);
    return this.applyReverse(device, signal);
  }

  /**
   * Starts a generation-owned watcher: an initial attempt, then bounded polling that restores the mapping
   * after unplug/replug, reauthorization or adb server restart. At most one timer and one adb child exist.
   */
  async start(serial: string | undefined, listener?: (event: AdbEvent) => void): Promise<void> {
    const selected = validateSerial(serial);
    if (this.active) throw new AdbError('ALREADY_STARTED');
    const abort = new AbortController();
    const run: Run = { serial: selected, signal: abort.signal, abort, timer: null, inflight: null, stopped: false, failures: 0, last: null, listener };
    this.active = run;
    run.inflight = this.tick(run);
    await run.inflight;
  }

  /** Stops the current generation: clears the timer, aborts any in-flight adb child and waits for it. */
  async stop(): Promise<void> {
    const run = this.active;
    if (!run) return;
    this.active = null; run.stopped = true;
    if (run.timer !== null) this.clock.clearTimer(run.timer);
    run.timer = null;
    run.abort.abort();
    await run.inflight?.catch(() => undefined);
  }

  private current(run: Run): boolean { return this.active === run && !run.stopped; }
  private emit(run: Run, event: AdbEvent): void {
    const key = event.state === 'connected' ? 'connected' : event.code;
    if (run.last === key) return;
    run.last = key;
    try { run.listener?.(event); } catch { /* listener faults must not stop recovery */ }
  }
  private async tick(run: Run): Promise<void> {
    let hard = false;
    try {
      const device = selectDevice(await this.listDevices(run.signal), run.serial);
      if (!await this.mappingPresent(device.serial, run.signal)) await this.applyReverse(device, run.signal);
      if (!this.current(run)) return;
      run.failures = 0;
      this.emit(run, { state: 'connected', serial: run.serial, port: HUB_PORT });
    } catch (error) {
      if (!this.current(run)) return;
      const code = error instanceof AdbError ? error.code : 'ADB_UNAVAILABLE';
      // Waiting for a cable/authorization is a cheap read-only poll at the base interval; real adb failures back off.
      hard = !['DEVICE_NOT_FOUND', 'DEVICE_UNAUTHORIZED', 'DEVICE_OFFLINE', 'DEVICE_NOT_READY', 'DEVICE_NOT_USB', 'DEVICE_NO_PERMISSIONS'].includes(code);
      run.failures = hard ? run.failures + 1 : 0;
      this.emit(run, { state: 'waiting', code, message: ADB_ERROR_MESSAGES[code] });
    }
    if (!this.current(run)) return;
    const delay = hard ? Math.min(MAX_BACKOFF_MS, this.pollIntervalMs * 2 ** run.failures) : this.pollIntervalMs;
    run.timer = this.clock.setTimer(() => {
      run.timer = null;
      if (!this.current(run)) return;
      run.inflight = this.tick(run);
    }, delay);
  }
}
