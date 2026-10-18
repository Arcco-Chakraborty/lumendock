import { execFile } from 'node:child_process';
import { cpus, freemem, totalmem, type CpuInfo } from 'node:os';
import type { HostVitals } from '@phone-monitor/protocol';
import { cleanCpuName, cleanGpuName, GPU_BACKOFF_MS, GPU_QUIET_SAMPLES } from '../collectors/vitals.js';
import { sharedHostHelper } from './host-helper.js';

/**
 * Laptop vitals on Windows. CPU load per thread and memory come from Node's os module; the
 * current clock (base clock x "% Processor Performance"), the hottest ACPI thermal zone (which
 * follows the CPU on laptops), integrated-GPU load, page file use and battery come from the
 * resident PowerShell helper; an NVIDIA GPU is asked through nvidia-smi with the same idle
 * backoff as on Linux. SSD temperature and CPU package power need administrator rights or a
 * hardware-monitoring driver, so they stay null.
 */
export interface WindowsVitalsIo {
  cpus(): CpuInfo[];
  memory(): { total: number; free: number };
  nvidiaSmi(): Promise<string>;
  helperVitals(): Promise<unknown>;
  now(): number;
}
const systemIo: WindowsVitalsIo = {
  cpus,
  memory: () => ({ total: totalmem(), free: freemem() }),
  nvidiaSmi: () => new Promise((resolve, reject) => execFile('nvidia-smi',
    ['--query-gpu=name,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total,clocks.gr', '--format=csv,noheader,nounits'],
    { timeout: 4000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))),
  helperVitals: async () => { const reply = await sharedHostHelper().request('vitals'); if (!reply.ok) throw Error('HELPER_FAILED'); return reply.data; },
  now: Date.now,
};

const round1 = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const ticks = (cpu: CpuInfo): [number, number] => {
  const { user, nice, sys, irq, idle } = cpu.times;
  return [user + nice + sys + irq, user + nice + sys + irq + idle];
};

export class WindowsVitalsReader {
  private previous: Array<[number, number]> | null = null;
  private gpuQuiet = 0;
  private gpuBackoffUntil = 0;
  private gpuName: string | null = null;
  private gpuMemoryTotal: number | null = null;
  private hasNvidia = true;
  constructor(private readonly io: WindowsVitalsIo = systemIo) {}

  private cpu(clockMhz: number | null, tempC: number | null): HostVitals['cpu'] {
    const list = this.io.cpus();
    if (!list.length) return null;
    const current = list.map(ticks);
    const all = current.reduce<[number, number]>((sum, [busy, total]) => [sum[0] + busy, sum[1] + total], [0, 0]);
    const before = this.previous;
    this.previous = [all, ...current];
    const usage = (now: [number, number], then: [number, number] | undefined) =>
      !then || now[1] <= then[1] ? null : round1(clamp(((now[0] - then[0]) / (now[1] - then[1])) * 100, 0, 100));
    const threads = current.slice(0, 128).map((now, i) => usage(now, before?.[i + 1])).filter((v): v is number => v !== null);
    return {
      name: cleanCpuName(list[0]!.model), usagePercent: usage(all, before?.[0]), threadUsage: threads, tempC: tempC === null ? null : round1(clamp(tempC, -50, 200)),
      clockMhz: clockMhz === null ? null : Math.round(clamp(clockMhz, 0, 20000)), powerW: null,
    };
  }

  private async nvidia(): Promise<HostVitals['gpu']> {
    if (!this.hasNvidia) return null;
    const idle = (state: 'active' | 'asleep'): HostVitals['gpu'] => ({ name: this.gpuName ?? 'NVIDIA GPU', state, usagePercent: null, tempC: null, hotspotC: null, powerW: null, memoryUsedMb: null, memoryTotalMb: this.gpuMemoryTotal, clockMhz: null });
    if (this.io.now() < this.gpuBackoffUntil) return idle('active');
    let row: string;
    try { row = (await this.io.nvidiaSmi()).split(/\r?\n/)[0] ?? ''; }
    catch (error) {
      // No driver tool at all: this laptop has no NVIDIA GPU to show.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.hasNvidia = false; return null; }
      return this.gpuName ? idle('asleep') : null;
    }
    const [name, util, temp, power, used, total, clock] = row.split(',').map(field => field.trim());
    const value = (field: string | undefined) => (field === undefined || field === '' || /N\/A|\[/.test(field) ? null : finite(Number(field)));
    if (name) this.gpuName = cleanGpuName(name);
    const memoryTotal = value(total);
    if (memoryTotal !== null) this.gpuMemoryTotal = Math.round(memoryTotal);
    const usage = value(util);
    // Our own query keeps the GPU awake; when it has been idle a while, stop asking so it can sleep.
    this.gpuQuiet = usage === 0 ? this.gpuQuiet + 1 : 0;
    if (this.gpuQuiet >= GPU_QUIET_SAMPLES) { this.gpuQuiet = 0; this.gpuBackoffUntil = this.io.now() + GPU_BACKOFF_MS; }
    const memoryUsed = value(used), mhz = value(clock), watts = value(power), celsius = value(temp);
    return {
      name: this.gpuName ?? 'NVIDIA GPU', state: 'active',
      usagePercent: usage === null ? null : clamp(usage, 0, 100),
      tempC: celsius === null ? null : clamp(celsius, -50, 200), hotspotC: null,
      powerW: watts === null ? null : round1(clamp(watts, 0, 2000)),
      memoryUsedMb: memoryUsed === null ? null : Math.max(0, Math.round(memoryUsed)),
      memoryTotalMb: this.gpuMemoryTotal,
      clockMhz: mhz === null ? null : Math.round(clamp(mhz, 0, 20000)),
    };
  }

  private memory(swap: unknown): HostVitals['memory'] {
    const { total, free } = this.io.memory();
    if (!(total > 0)) return null;
    const s = swap !== null && typeof swap === 'object' ? swap as Record<string, unknown> : {};
    const mb = (value: unknown) => Math.max(0, Math.round((finite(value) ?? 0) * 1024 * 1024));
    return { usedBytes: Math.max(0, Math.round(total - free)), totalBytes: Math.round(total), swapUsedBytes: mb(s.usedMb), swapTotalBytes: mb(s.totalMb) };
  }

  private static power(raw: unknown): HostVitals['power'] {
    const p = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    if (!p) return null;
    const ac = typeof p.ac === 'boolean' ? p.ac : null;
    if (p.hasBattery !== true && ac === null) return null;
    const percent = finite(p.batteryPercent), minutes = finite(p.minutesLeft);
    return {
      source: ac ? 'ac' : p.hasBattery === true ? 'battery' : 'unknown',
      batteryPercent: percent === null ? null : clamp(Math.round(percent), 0, 100),
      charging: typeof p.charging === 'boolean' ? p.charging : null, watts: null,
      minutesLeft: minutes === null ? null : Math.min(100000, Math.max(0, Math.round(minutes))),
    };
  }

  async read(): Promise<HostVitals> {
    const [helper, gpu] = await Promise.all([this.io.helperVitals().catch(() => null), this.nvidia().catch(() => null)]);
    const h = helper !== null && typeof helper === 'object' ? helper as Record<string, unknown> : {};
    const igpu = finite(h.igpuPercent);
    return {
      cpu: this.cpu(finite(h.clockMhz), finite(h.cpuTempC)), gpu,
      igpu: igpu === null ? null : { usagePercent: clamp(igpu, 0, 100), tempC: null },
      memory: this.memory(h.swap), power: WindowsVitalsReader.power(h.power), storageTempC: null,
    };
  }
}
