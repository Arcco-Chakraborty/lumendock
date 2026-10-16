import { readFile, readdir } from 'node:fs/promises';
import type { HostVitals } from '@phone-monitor/protocol';
import { execRunner, type HostRunner } from './host.js';

/**
 * Laptop vitals for the phone's Laptop screen, read from /proc and /sys. Only the
 * NVIDIA GPU needs a tool (nvidia-smi), and it is asked only while something else
 * already has the GPU awake: querying a runtime-suspended GPU would wake it and
 * keep it from sleeping, which costs battery on hybrid-graphics laptops.
 */
export interface VitalsIo {
  read(path: string): Promise<string>;
  list(dir: string): Promise<string[]>;
  run: HostRunner;
  now(): number;
}
const systemIo: VitalsIo = { read: path => readFile(path, 'utf8'), list: dir => readdir(dir), run: execRunner, now: Date.now };

type Vitals = HostVitals;
const clip = (value: string, max: number) => [...value].slice(0, max).join('');
const round1 = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const number = (text: string | undefined) => {
  const value = Number((text ?? '').trim());
  return text !== undefined && (text.trim() !== '') && Number.isFinite(value) ? value : null;
};
/** Ages GPU polling out after this many idle samples, then waits before asking again. */
export const GPU_QUIET_SAMPLES = 3;
export const GPU_BACKOFF_MS = 60_000;

export function cleanCpuName(name: string): string {
  return clip(name.replace(/\((R|TM)\)/g, '').replace(/\s+with Radeon Graphics/i, '').replace(/\s+CPU\s+@.*$/i, '').replace(/\s+\d+-Core Processor/i, '').replace(/\s+/g, ' ').trim(), 80);
}
export function cleanGpuName(name: string): string {
  return clip(name.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '').trim(), 80);
}

/** /proc/stat lines as [busy, total] jiffies, aggregate first, then one per thread. */
export function parseStat(text: string): Array<[number, number]> {
  return text.split('\n').filter(line => /^cpu\d*\s/.test(line)).map(line => {
    const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
    const total = fields.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
    const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
    return [total - idle, total];
  });
}

export class VitalsReader {
  private previousStat: Array<[number, number]> | null = null;
  private gpuQuiet = 0;
  private gpuBackoffUntil = 0;
  private gpuName: string | null = null;
  private gpuMemoryTotal: number | null = null;
  constructor(private readonly io: VitalsIo = systemIo) {}

  private async text(path: string): Promise<string | undefined> {
    try { return await this.io.read(path); } catch { return undefined; }
  }
  private async hwmon(): Promise<Map<string, string[]>> {
    const byName = new Map<string, string[]>();
    let entries: string[] = [];
    try { entries = await this.io.list('/sys/class/hwmon'); } catch { return byName; }
    for (const entry of entries.sort()) {
      const dir = `/sys/class/hwmon/${entry}`;
      const name = (await this.text(`${dir}/name`))?.trim();
      if (name) byName.set(name, [...(byName.get(name) ?? []), dir]);
    }
    return byName;
  }
  /** Temperature in °C from the first tempN_input whose label matches, or temp1 when unlabelled. */
  private async temp(dir: string, labels: RegExp | null): Promise<number | null> {
    let files: string[] = [];
    try { files = await this.io.list(dir); } catch { return null; }
    for (const file of files.filter(f => /^temp\d+_input$/.test(f)).sort()) {
      const label = (await this.text(`${dir}/${file.replace('_input', '_label')}`))?.trim() ?? '';
      if (labels && !labels.test(label)) continue;
      const milli = number(await this.text(`${dir}/${file}`));
      if (milli !== null) return round1(clamp(milli / 1000, -50, 200));
    }
    return null;
  }

  private async cpu(hw: Map<string, string[]>): Promise<Vitals['cpu']> {
    const stat = await this.text('/proc/stat');
    if (stat === undefined) return null;
    const current = parseStat(stat);
    const previous = this.previousStat;
    this.previousStat = current;
    const usage = (i: number) => {
      const now = current[i], before = previous?.[i];
      if (!now || !before || now[1] <= before[1]) return null;
      return round1(clamp(((now[0] - before[0]) / (now[1] - before[1])) * 100, 0, 100));
    };
    const threads = current.slice(1, 129).map((_, i) => usage(i + 1)).filter((v): v is number => v !== null);
    const model = (await this.text('/proc/cpuinfo'))?.match(/^model name\s*:\s*(.+)$/m)?.[1] ?? 'CPU';
    const freqs: number[] = [];
    for (let i = 0; i < Math.min(current.length - 1, 128); i += 1) {
      const khz = number(await this.text(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`));
      if (khz !== null) freqs.push(khz);
    }
    let tempC: number | null = null;
    for (const [name, labels] of [['k10temp', /^T(ctl|die)$/], ['zenpower', /^Tdie$/], ['coretemp', /^Package id/]] as const) {
      for (const dir of hw.get(name) ?? []) { tempC ??= await this.temp(dir, labels); }
    }
    // On AMD APUs the integrated GPU's hwmon reports the whole package as "PPT".
    let powerW: number | null = null;
    for (const dir of hw.get('amdgpu') ?? []) {
      if ((await this.text(`${dir}/power1_label`))?.trim() !== 'PPT') continue;
      const micro = number(await this.text(`${dir}/power1_input`)) ?? number(await this.text(`${dir}/power1_average`));
      if (micro !== null) powerW = round1(clamp(micro / 1e6, 0, 2000));
    }
    return {
      name: cleanCpuName(model), usagePercent: usage(0), threadUsage: threads, tempC,
      clockMhz: freqs.length ? Math.min(20000, Math.round(freqs.reduce((a, b) => a + b, 0) / freqs.length / 1000)) : null,
      powerW,
    };
  }

  private async nvidia(): Promise<Vitals['gpu']> {
    let device: string | null = null;
    try {
      for (const entry of (await this.io.list('/sys/bus/pci/devices')).sort()) {
        const dir = `/sys/bus/pci/devices/${entry}`;
        if ((await this.text(`${dir}/vendor`))?.trim() === '0x10de' && (await this.text(`${dir}/class`))?.trim().startsWith('0x03')) { device = dir; break; }
      }
    } catch { return null; }
    if (!device) return null;
    if (!this.gpuName) {
      // The driver's procfs entry names the GPU without waking it.
      const model = (await this.text(`/proc/driver/nvidia/gpus/${device.split('/').pop()}/information`))?.match(/^Model:\s*(.+)$/m)?.[1];
      if (model) this.gpuName = cleanGpuName(model);
    }
    const asleep = (): Vitals['gpu'] => ({ name: this.gpuName ?? 'NVIDIA GPU', state: 'asleep', usagePercent: null, tempC: null, hotspotC: null, powerW: null, memoryUsedMb: null, memoryTotalMb: this.gpuMemoryTotal, clockMhz: null });
    const runtime = (await this.text(`${device}/power/runtime_status`))?.trim();
    if (runtime !== undefined && runtime !== 'active') return asleep();
    if (this.io.now() < this.gpuBackoffUntil) return { ...asleep()!, state: 'active' };
    let row: string;
    try {
      row = (await this.io.run('nvidia-smi', ['--query-gpu=name,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total,clocks.gr', '--format=csv,noheader,nounits'])).split('\n')[0] ?? '';
    } catch { return asleep(); }
    const [name, util, temp, power, used, total, clock] = row.split(',').map(field => field.trim());
    const value = (field: string | undefined) => (field === undefined || /N\/A/.test(field) ? null : number(field));
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
      tempC: celsius === null ? null : clamp(celsius, -50, 200),
      hotspotC: null,
      powerW: watts === null ? null : round1(clamp(watts, 0, 2000)),
      memoryUsedMb: memoryUsed === null ? null : Math.max(0, Math.round(memoryUsed)),
      memoryTotalMb: this.gpuMemoryTotal,
      clockMhz: mhz === null ? null : Math.round(clamp(mhz, 0, 20000)),
    };
  }

  private async igpu(hw: Map<string, string[]>): Promise<Vitals['igpu']> {
    const dir = hw.get('amdgpu')?.[0];
    if (!dir) return null;
    const busy = number(await this.text(`${dir}/device/gpu_busy_percent`));
    return { usagePercent: busy === null ? null : clamp(busy, 0, 100), tempC: await this.temp(dir, /^edge$|^$/) };
  }

  private async memory(): Promise<Vitals['memory']> {
    const info = await this.text('/proc/meminfo');
    if (info === undefined) return null;
    const kb = (key: string) => number(new RegExp(`^${key}:\\s*(\\d+)`, 'm').exec(info)?.[1]);
    const total = kb('MemTotal'), available = kb('MemAvailable'), swapTotal = kb('SwapTotal') ?? 0, swapFree = kb('SwapFree') ?? 0;
    if (total === null || available === null) return null;
    return { usedBytes: Math.max(0, total - available) * 1024, totalBytes: total * 1024, swapUsedBytes: Math.max(0, swapTotal - swapFree) * 1024, swapTotalBytes: swapTotal * 1024 };
  }

  private async power(): Promise<Vitals['power']> {
    let supplies: string[] = [];
    try { supplies = await this.io.list('/sys/class/power_supply'); } catch { return null; }
    let online = false, battery: string | null = null;
    for (const entry of supplies.sort()) {
      const dir = `/sys/class/power_supply/${entry}`;
      const type = (await this.text(`${dir}/type`))?.trim();
      if (type === 'Mains' && (await this.text(`${dir}/online`))?.trim() === '1') online = true;
      if (type === 'Battery' && !battery) battery = dir;
    }
    if (!battery && !online) return null;
    let percent: number | null = null, charging: boolean | null = null, watts: number | null = null, minutesLeft: number | null = null;
    if (battery) {
      percent = number(await this.text(`${battery}/capacity`));
      const status = (await this.text(`${battery}/status`))?.trim() ?? '';
      charging = status === 'Charging' ? true : status ? false : null;
      const voltage = number(await this.text(`${battery}/voltage_now`));
      let micro = number(await this.text(`${battery}/power_now`));
      const current = number(await this.text(`${battery}/current_now`));
      if ((micro === null || micro === 0) && current !== null && voltage !== null) micro = (current * voltage) / 1e6;
      if (micro !== null && micro > 0) watts = round1(clamp(Math.abs(micro) / 1e6, 0, 2000));
      const energy = number(await this.text(`${battery}/energy_now`)) ?? (voltage !== null ? (number(await this.text(`${battery}/charge_now`)) ?? NaN) * voltage / 1e6 : null);
      const full = number(await this.text(`${battery}/energy_full`)) ?? (voltage !== null ? (number(await this.text(`${battery}/charge_full`)) ?? NaN) * voltage / 1e6 : null);
      if (watts && energy !== null && Number.isFinite(energy)) {
        const hours = status === 'Discharging' ? energy / 1e6 / watts : status === 'Charging' && full !== null && Number.isFinite(full) ? Math.max(0, full - energy) / 1e6 / watts : null;
        if (hours !== null) minutesLeft = Math.min(100000, Math.round(hours * 60));
      }
    }
    return { source: online ? 'ac' : battery ? 'battery' : 'unknown', batteryPercent: percent === null ? null : clamp(percent, 0, 100), charging, watts, minutesLeft };
  }

  private async storage(hw: Map<string, string[]>): Promise<number | null> {
    let hottest: number | null = null;
    for (const dir of hw.get('nvme') ?? []) {
      const celsius = await this.temp(dir, /^Composite$|^$/);
      if (celsius !== null) hottest = Math.max(hottest ?? -50, celsius);
    }
    return hottest;
  }

  async read(): Promise<HostVitals> {
    const hw = await this.hwmon();
    const [cpu, gpu, igpu, memory, power, storageTempC] = await Promise.all([
      this.cpu(hw).catch(() => null), this.nvidia().catch(() => null), this.igpu(hw).catch(() => null),
      this.memory().catch(() => null), this.power().catch(() => null), this.storage(hw).catch(() => null),
    ]);
    return { cpu, gpu, igpu, memory, power, storageTempC };
  }
}
