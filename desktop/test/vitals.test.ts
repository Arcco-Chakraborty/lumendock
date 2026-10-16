import { describe, expect, it } from 'vitest';
import { HostVitalsSchema } from '@phone-monitor/protocol';
import { GPU_BACKOFF_MS, GPU_QUIET_SAMPLES, VitalsReader, cleanCpuName, cleanGpuName, parseStat } from '../src/collectors/vitals.js';
import { HostCollector } from '../src/collectors/host.js';
import { HubStore } from '../src/store.js';

// A synthetic /proc and /sys: nothing here reads the real machine or runs nvidia-smi.
function fakeMachine(files: Record<string, string>, smi: string | Error = 'NVIDIA GeForce Synthetic RTX 1, 37, 58, 21.43, 1210, 4096, 1455') {
  let now = 1_000_000;
  const smiCalls: number[] = [];
  const io = {
    read: async (path: string) => { if (path in files) return files[path]!; throw new Error('ENOENT'); },
    list: async (dir: string) => {
      const prefix = `${dir}/`;
      const names = new Set(Object.keys(files).filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length).split('/')[0]!));
      if (!names.size) throw new Error('ENOENT');
      return [...names];
    },
    run: async (command: string) => { smiCalls.push(now); if (command !== 'nvidia-smi' || smi instanceof Error) throw smi; return smi; },
    now: () => now,
  };
  return { io, files, smiCalls, advance: (ms: number) => { now += ms; } };
}
const stat = (busy: number, idle: number) => `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 ${busy / 2} 0 0 ${idle / 2} 0 0 0 0\ncpu1 ${busy / 2} 0 0 ${idle / 2} 0 0 0 0\nintr 1 2\n`;
const laptop = (): Record<string, string> => ({
  '/proc/stat': stat(1000, 9000),
  '/proc/cpuinfo': 'processor\t: 0\nmodel name\t: Synthetic Ryzen 5 5600H with Radeon Graphics\n',
  '/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq': '4000000\n',
  '/sys/devices/system/cpu/cpu1/cpufreq/scaling_cur_freq': '2000000\n',
  '/sys/class/hwmon/hwmon1/name': 'k10temp\n', '/sys/class/hwmon/hwmon1/temp1_input': '61250\n', '/sys/class/hwmon/hwmon1/temp1_label': 'Tctl\n',
  '/sys/class/hwmon/hwmon2/name': 'amdgpu\n', '/sys/class/hwmon/hwmon2/temp1_input': '43000\n', '/sys/class/hwmon/hwmon2/temp1_label': 'edge\n',
  '/sys/class/hwmon/hwmon2/power1_label': 'PPT\n', '/sys/class/hwmon/hwmon2/power1_input': '12345678\n', '/sys/class/hwmon/hwmon2/device/gpu_busy_percent': '7\n',
  '/sys/class/hwmon/hwmon3/name': 'nvme\n', '/sys/class/hwmon/hwmon3/temp1_input': '57850\n', '/sys/class/hwmon/hwmon3/temp1_label': 'Composite\n',
  '/sys/class/hwmon/hwmon4/name': 'nvme\n', '/sys/class/hwmon/hwmon4/temp1_input': '33850\n', '/sys/class/hwmon/hwmon4/temp1_label': 'Composite\n',
  '/sys/bus/pci/devices/0000:06:00.0/vendor': '0x1002\n', '/sys/bus/pci/devices/0000:06:00.0/class': '0x030000\n',
  '/sys/bus/pci/devices/0000:01:00.0/vendor': '0x10de\n', '/sys/bus/pci/devices/0000:01:00.0/class': '0x030200\n',
  '/sys/bus/pci/devices/0000:01:00.0/power/runtime_status': 'suspended\n',
  '/proc/driver/nvidia/gpus/0000:01:00.0/information': 'Model: \t\t NVIDIA GeForce RTX 3050 Ti Laptop GPU\nIRQ: 1\n',
  '/proc/meminfo': 'MemTotal:       15176276 kB\nMemFree: 1 kB\nMemAvailable:    4386848 kB\nSwapTotal:       4194300 kB\nSwapFree:        2095580 kB\n',
  '/sys/class/power_supply/ACAD/type': 'Mains\n', '/sys/class/power_supply/ACAD/online': '0\n',
  '/sys/class/power_supply/BAT1/type': 'Battery\n', '/sys/class/power_supply/BAT1/status': 'Discharging\n', '/sys/class/power_supply/BAT1/capacity': '76\n',
  '/sys/class/power_supply/BAT1/power_now': '18400000\n', '/sys/class/power_supply/BAT1/energy_now': '30000000\n', '/sys/class/power_supply/BAT1/energy_full': '41140000\n',
  '/sys/class/power_supply/BAT1/voltage_now': '11800000\n',
});

describe('laptop vitals', () => {
  it('cleans display names and parses /proc/stat', () => {
    expect(cleanCpuName('AMD Ryzen 5 5600H with Radeon Graphics')).toBe('AMD Ryzen 5 5600H');
    expect(cleanCpuName('Intel(R) Core(TM) i7-1165G7 CPU @ 2.80GHz')).toBe('Intel Core i7-1165G7');
    expect(cleanGpuName('NVIDIA GeForce RTX 3050 Ti Laptop GPU')).toBe('RTX 3050 Ti Laptop GPU');
    expect(parseStat(stat(100, 900))).toEqual([[100, 1000], [50, 500], [50, 500]]);
  });
  it('reads CPU load from two samples, Tctl, average clock and APU package power', async () => {
    const m = fakeMachine(laptop());
    const reader = new VitalsReader(m.io);
    expect((await reader.read()).cpu).toMatchObject({ usagePercent: null, threadUsage: [] });
    m.files['/proc/stat'] = stat(1500, 9500);
    const v = await reader.read();
    expect(HostVitalsSchema.safeParse(v).success).toBe(true);
    expect(v.cpu).toEqual({ name: 'Synthetic Ryzen 5 5600H', usagePercent: 50, threadUsage: [50, 50], tempC: 61.3, clockMhz: 3000, powerW: 12.3 });
    expect(v.igpu).toEqual({ usagePercent: 7, tempC: 43 });
    expect(v.storageTempC).toBe(57.9);
    expect(v.memory).toEqual({ usedBytes: (15176276 - 4386848) * 1024, totalBytes: 15176276 * 1024, swapUsedBytes: (4194300 - 2095580) * 1024, swapTotalBytes: 4194300 * 1024 });
    expect(v.power).toEqual({ source: 'battery', batteryPercent: 76, charging: false, watts: 18.4, minutesLeft: 98 });
  });
  it('never asks a sleeping NVIDIA GPU for stats, but still names it', async () => {
    const m = fakeMachine(laptop());
    const v = await new VitalsReader(m.io).read();
    expect(v.gpu).toMatchObject({ name: 'RTX 3050 Ti Laptop GPU', state: 'asleep', usagePercent: null, tempC: null });
    expect(m.smiCalls).toEqual([]);
  });
  it('reads an awake GPU, reports no hotspot, and backs off after idle samples so it can sleep', async () => {
    const files = laptop();
    files['/sys/bus/pci/devices/0000:01:00.0/power/runtime_status'] = 'active\n';
    const busy = fakeMachine(files);
    expect((await new VitalsReader(busy.io).read()).gpu).toEqual({ name: 'Synthetic RTX 1', state: 'active', usagePercent: 37, tempC: 58, hotspotC: null, powerW: 21.4, memoryUsedMb: 1210, memoryTotalMb: 4096, clockMhz: 1455 });
    const idle = fakeMachine(files, 'NVIDIA GeForce Synthetic RTX 1, 0, 45, [N/A], 5, 4096, 210');
    const reader = new VitalsReader(idle.io);
    for (let i = 0; i < GPU_QUIET_SAMPLES; i += 1) { await reader.read(); idle.advance(2000); }
    expect(idle.smiCalls).toHaveLength(GPU_QUIET_SAMPLES);
    const quiet = await reader.read();
    expect(idle.smiCalls).toHaveLength(GPU_QUIET_SAMPLES);
    expect(quiet.gpu).toMatchObject({ state: 'active', usagePercent: null, memoryTotalMb: 4096 });
    idle.advance(GPU_BACKOFF_MS);
    expect((await reader.read()).gpu).toMatchObject({ powerW: null, usagePercent: 0 });
    expect(idle.smiCalls).toHaveLength(GPU_QUIET_SAMPLES + 1);
  });
  it('reports charging time and plain AC power', async () => {
    const files = laptop();
    files['/sys/class/power_supply/ACAD/online'] = '1\n';
    files['/sys/class/power_supply/BAT1/status'] = 'Charging\n';
    expect((await new VitalsReader(fakeMachine(files).io).read()).power).toEqual({ source: 'ac', batteryPercent: 76, charging: true, watts: 18.4, minutesLeft: 36 });
    files['/sys/class/power_supply/BAT1/status'] = 'Full\n';
    files['/sys/class/power_supply/BAT1/power_now'] = '0\n';
    delete files['/sys/class/power_supply/BAT1/voltage_now'];
    expect((await new VitalsReader(fakeMachine(files).io).read()).power).toEqual({ source: 'ac', batteryPercent: 76, charging: false, watts: null, minutesLeft: null });
  });
  it('degrades to nulls on a machine that exposes nothing', async () => {
    const v = await new VitalsReader(fakeMachine({}).io).read();
    expect(v).toEqual({ cpu: null, gpu: null, igpu: null, memory: null, power: null, storageTempC: null });
    expect(HostVitalsSchema.safeParse(v).success).toBe(true);
  });
  it('samples vitals only while the phone is watching', async () => {
    const store = new HubStore();
    const run = async () => { throw new Error('no tools'); };
    let watching = false;
    const collector = new HostCollector({ store, run, vitals: { reader: new VitalsReader(fakeMachine(laptop()).io), active: () => watching } });
    await collector.poll();
    expect(store.snapshot(1).host?.vitals).toBeUndefined();
    watching = true;
    await collector.poll();
    expect(store.snapshot(1).host?.vitals?.memory?.totalBytes).toBe(15176276 * 1024);
  });
});
