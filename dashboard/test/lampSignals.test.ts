import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { EspState, HubSnapshot, LightPatch } from "@phone-monitor/protocol";
import { LampSignaller, MIN_GAP_MS, PULSE_MS, SignalDetector, classify, inQuietHours } from "../src/lib/lampSignals.js";
import type { IntentSnapshot } from "../src/lib/lightIntent.js";

const hub = (): HubSnapshot => JSON.parse(readFileSync(new URL("../../packages/protocol/fixtures/hub-ready.json", import.meta.url), "utf8"));
const note = (id: string, appId: string) => ({ ...hub().notifications.items[0]!, id, appId });

describe("signal detection", () => {
  it("classifies selected sources", () => {
    expect(classify("WhatsApp")).toBe("whatsapp");
    expect(classify("Claude Code")).toBe("agent");
    expect(classify("Codex")).toBe("agent");
    expect(classify("Synthetic app")).toBeNull();
  });
  it("ignores alerts already present at start and signals only new ones, agent first", () => {
    const detector = new SignalDetector();
    const first = hub();
    first.notifications.items = [note("old", "Claude")];
    expect(detector.observe(first)).toEqual([]);
    const next = hub();
    next.notifications.items = [note("old", "Claude"), note("new-wa", "WhatsApp"), note("new-claude", "Claude Code")];
    expect(detector.observe(next)).toEqual(["agent", "whatsapp"]);
    expect(detector.observe(next)).toEqual([]);
  });
  it("signals a quota reset only after the window was used up", () => {
    const detector = new SignalDetector();
    const at = (percent: number) => { const h = hub(); h.usage.codex.windows[0]!.usedPercent = percent; return h; };
    expect(detector.observe(at(60))).toEqual([]);
    expect(detector.observe(at(30))).toEqual([]);
    expect(detector.observe(at(100))).toEqual([]);
    expect(detector.observe(at(100))).toEqual([]);
    expect(detector.observe(at(0))).toEqual(["quota"]);
    expect(detector.observe(at(0))).toEqual([]);
  });
  it("keeps quiet from 11 PM to 8 AM", () => {
    expect(inQuietHours(new Date(2026, 9, 15, 23, 0))).toBe(true);
    expect(inQuietHours(new Date(2026, 9, 16, 7, 59))).toBe(true);
    expect(inQuietHours(new Date(2026, 9, 16, 8, 0))).toBe(false);
    expect(inQuietHours(new Date(2026, 9, 15, 22, 59))).toBe(false);
  });
});

function fakeLamp() {
  const timers: Array<{ at: number; fn: () => void }> = [];
  let now = 100_000;
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ at: now + ms, fn }); return 0 as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: () => {},
  };
  let state: EspState = { power: false, hex: "#FFB454", bright: 40, mode: 0, speed: 50, timerSeconds: 0, sensorOk: true, temperatureC: 24, humidityPercent: 50, uptimeSeconds: 1 };
  const sent: LightPatch[] = [];
  const lamp = {
    ready: true,
    snapshot: (): IntentSnapshot => ({ desired: state, confirmed: state, stateOutcome: null, timerOutcome: null, queued: 0, ready: lamp.ready }),
    change: async (patch: LightPatch) => { sent.push(patch); state = { ...state, ...(patch as Partial<EspState>), hex: (patch.hex ?? state.hex).toUpperCase() }; },
    release: () => {},
    userSets: (patch: Partial<EspState>) => { state = { ...state, ...patch }; },
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers.splice(0).filter((t) => t.at <= now)) timer.fn();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { lamp, clock, sent, advance, state: () => state };
}

describe("lamp signaller", () => {
  it("pulses in the signal colour and restores the previous state", async () => {
    const { lamp, clock, sent, advance, state } = fakeLamp();
    const done = new LampSignaller(lamp, clock).fire("agent");
    await advance(0);
    expect(sent[0]).toEqual({ power: true, mode: 1, speed: 85, bright: 100, hex: "#00F0FF" });
    await advance(PULSE_MS);
    await expect(done).resolves.toBe(true);
    expect(sent[1]).toEqual({ power: false, hex: "#FFB454", mode: 0, bright: 40, speed: 50 });
    expect(state().power).toBe(false);
  });
  it("leaves the lamp alone if it was changed during the pulse", async () => {
    const { lamp, clock, sent, advance } = fakeLamp();
    const done = new LampSignaller(lamp, clock).fire("whatsapp");
    await advance(0);
    lamp.userSets({ hex: "#FF0000", mode: 0 });
    await advance(PULSE_MS);
    await done;
    expect(sent).toHaveLength(1);
  });
  it("rate-limits signals but lets a manual test through", async () => {
    const { lamp, clock, advance } = fakeLamp();
    const signaller = new LampSignaller(lamp, clock);
    const pulse = async (signal: Promise<boolean>) => { await advance(0); await advance(PULSE_MS); return signal; };
    await expect(pulse(signaller.fire("agent"))).resolves.toBe(true);
    await expect(signaller.fire("agent")).resolves.toBe(false);
    await expect(pulse(signaller.fire("quota", true))).resolves.toBe(true);
    await advance(MIN_GAP_MS);
    await expect(pulse(signaller.fire("agent"))).resolves.toBe(true);
  });
  it("does nothing while the lamp controller is not connected", async () => {
    const { lamp, clock, sent } = fakeLamp();
    lamp.ready = false;
    await expect(new LampSignaller(lamp, clock).fire("agent")).resolves.toBe(false);
    expect(sent).toEqual([]);
  });
});
