import type { EspState, HubSnapshot, LightPatch } from "@phone-monitor/protocol";
import { systemClock, type Clock } from "../device.js";
import type { IntentSnapshot } from "./lightIntent.js";

/**
 * Lamp signals: the room lamp briefly pulses when something on the laptop needs
 * attention, then returns to what it was doing. Runs on the phone, which is the
 * only device that talks to the lamp controller.
 */
export type SignalKind = "agent" | "whatsapp" | "quota";
export interface SignalPrefs { agent: boolean; whatsapp: boolean; quota: boolean; quietHours: boolean }
export const DEFAULT_SIGNAL_PREFS: SignalPrefs = { agent: true, whatsapp: true, quota: true, quietHours: true };
export const SIGNAL_COLOURS: Record<SignalKind, string> = { agent: "#00F0FF", whatsapp: "#25D366", quota: "#FFFFFF" };
/** Firmware mode 1 is Breathe: a soft pulse rather than a hard strobe. */
const PULSE: Omit<LightPatch, "hex"> = { power: true, mode: 1, speed: 85, bright: 100 };
export const PULSE_MS = 4000;
export const MIN_GAP_MS = 15000;
const PRIORITY: SignalKind[] = ["agent", "quota", "whatsapp"];

/** 11 PM to 8 AM local phone time. */
export const inQuietHours = (date: Date) => date.getHours() >= 23 || date.getHours() < 8;

export function classify(appId: string): SignalKind | null {
  if (/whatsapp/i.test(appId)) return "whatsapp";
  if (/claude|codex/i.test(appId)) return "agent";
  return null;
}

/** Compares successive hub snapshots. Items already present at start never signal. */
export class SignalDetector {
  private seen: Set<string> | null = null;
  private exhausted = new Set<string>();
  observe(hub: HubSnapshot | null | undefined): SignalKind[] {
    if (!hub) return [];
    const found = new Set<SignalKind>();
    const ids = hub.notifications.items.map((item) => item.id);
    if (this.seen) {
      for (const item of hub.notifications.items) {
        if (this.seen.has(item.id)) continue;
        const kind = classify(item.appId);
        if (kind) found.add(kind);
      }
    }
    this.seen = new Set(ids);
    // A window that was at or over its limit and has dropped back means the quota reset.
    for (const provider of ["claude", "codex"] as const) {
      for (const window of hub.usage[provider].windows) {
        const key = `${provider}/${window.bucketId}/${window.windowId}`;
        if (window.usedPercent === null) continue;
        if (window.usedPercent >= 100) this.exhausted.add(key);
        else if (this.exhausted.delete(key)) found.add("quota");
      }
    }
    return PRIORITY.filter((kind) => found.has(kind));
  }
}

export interface SignalTarget {
  snapshot(): IntentSnapshot;
  change(patch: LightPatch): Promise<unknown>;
  release(): void;
}
const same = (state: EspState | null, patch: LightPatch) =>
  state !== null && (Object.keys(patch) as Array<keyof LightPatch>).every((key) =>
    key === "hex" ? state.hex.toUpperCase() === patch.hex!.toUpperCase() : (state as unknown as Record<string, unknown>)[key] === patch[key]);

/** Pulses the lamp and restores it, unless someone changed the lamp in between. */
export class LampSignaller {
  private busy = false;
  private last = -Infinity;
  constructor(private readonly target: SignalTarget, private readonly clock: Clock = systemClock) {}
  async fire(kind: SignalKind, force = false): Promise<boolean> {
    const now = this.clock.now();
    const intent = this.target.snapshot();
    const before = intent.confirmed ?? intent.desired;
    if (this.busy || !intent.ready || !before || (!force && now - this.last < MIN_GAP_MS)) return false;
    this.busy = true;
    this.last = now;
    const pulse: LightPatch = { ...PULSE, hex: SIGNAL_COLOURS[kind] };
    try {
      const sent = this.target.change(pulse);
      this.target.release();
      await sent;
      await new Promise<void>((done) => this.clock.setTimeout(done, PULSE_MS));
      if (same(this.target.snapshot().desired, pulse)) {
        const restore = this.target.change({ power: before.power, hex: before.hex, mode: before.mode, bright: before.bright, speed: before.speed });
        this.target.release();
        await restore;
      }
      return true;
    } catch {
      return false;
    } finally {
      this.busy = false;
    }
  }
}

const STORAGE_KEY = "lumendock.lampSignals";
export function loadSignalPrefs(): SignalPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<SignalPrefs> | null;
    const prefs = { ...DEFAULT_SIGNAL_PREFS };
    for (const key of Object.keys(prefs) as Array<keyof SignalPrefs>) if (typeof raw?.[key] === "boolean") prefs[key] = raw[key];
    return prefs;
  } catch {
    return { ...DEFAULT_SIGNAL_PREFS };
  }
}
export function saveSignalPrefs(prefs: SignalPrefs): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable: keep in memory */ }
}
