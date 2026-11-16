import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimeStore } from "../src/lib/timeStore.js";
import { clockAudio } from "../src/lib/clockAudio.js";

vi.mock("../src/lib/clockAudio.js", () => ({
  clockAudio: { playTimerDone: vi.fn(), startAlarm: vi.fn(), stopAlarm: vi.fn(), unlock: vi.fn() },
}));

const ALARMS = "lumendock_alarms";
const PREFS = "lumendock_clock_prefs";
let stores: TimeStore[] = [];
let saved: Map<string, string>;
let page: EventTarget;
function makeStore() {
  const store = new TimeStore();
  stores.push(store);
  return store;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date(2026, 0, 5, 8, 59, 58)); // Synthetic Monday, local time.
  saved = new Map();
  page = new EventTarget();
  Object.assign(page, { visibilityState: "visible" });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } });
  vi.stubGlobal("localStorage", window.localStorage);
  vi.clearAllMocks();
});
afterEach(() => {
  stores.forEach((store) => store.dispose());
  stores = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("clock data and input regressions", () => {
  it.each([
    { raw: undefined, expected: false, scenario: "missing preferences" },
    { raw: '{"stacked":"invalid"}', expected: false, scenario: "invalid stacked preference" },
    { raw: '{"stacked":true}', expected: true, scenario: "explicit saved stacked layout" },
  ])("uses the intended layout for $scenario", ({ raw, expected }) => {
    if (raw !== undefined) saved.set(PREFS, raw);
    expect(makeStore().getState().wallpaperStacked).toBe(expected);
  });
  it("keeps a deliberately empty alarm list empty after reload", () => {
    saved.set(ALARMS, "[]");
    expect(makeStore().getState().alarms).toEqual([]);
  });
  it("starts without unsolicited demo alarms", () => {
    expect(makeStore().getState().alarms).toEqual([]);
  });
  it("retains valid saved alarms while rejecting malformed entries and preferences", () => {
    const valid = { id: "synthetic-alarm", time: "09:00", label: "Synthetic", enabled: true, days: "daily" };
    saved.set(ALARMS, JSON.stringify([valid, null, { ...valid, id: "bad", time: "29:90" }, { ...valid, id: "bad-days", days: "sometimes" }]));
    saved.set(PREFS, JSON.stringify({ theme: "unknown", seconds: "no", stacked: false }));
    const state = makeStore().getState();
    expect(state.alarms).toEqual([valid]);
    expect(state.wallpaperTheme).toBe("sonoma");
    expect(state.wallpaperSeconds).toBe(true);
    expect(state.wallpaperStacked).toBe(false);
  });
  it("continues to work when localStorage access itself is denied", () => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("denied"); } });
    expect(() => makeStore()).not.toThrow();
  });
  it("rejects nonfinite, negative and over-one-day timer inputs without damaging a running timer", () => {
    const store = makeStore();
    store.startTimer(60);
    for (const value of [NaN, Infinity, -1, 0, 86401]) store.startTimer(value);
    for (const value of [NaN, Infinity, -5, 2000]) store.addTimerMinutes(value);
    expect(store.getState().timerDurationSec).toBe(60);
    expect(store.getState().timerRemainingSec).toBe(60);
    vi.advanceTimersByTime(1000);
    expect(store.getState().timerRemainingSec).toBe(59);
  });
  it("rejects invalid alarm time and repeat values", () => {
    const store = makeStore();
    for (const time of ["", "9:00", "24:00", "12:60"]) store.addAlarm({ time, label: "Synthetic" });
    store.addAlarm({ time: "09:00", label: "Synthetic", days: "bad" as "daily" });
    expect(store.getState().alarms).toEqual([]);
  });
});

describe("elapsed-time regressions", () => {
  it("measures countdown and stopwatch with monotonic time across wall-clock jumps", () => {
    const store = makeStore();
    store.startTimer(60);
    store.startStopwatch();
    vi.advanceTimersByTime(2000);
    vi.setSystemTime(new Date(2030, 0, 1));
    vi.advanceTimersByTime(1000);
    expect(store.getState().timerRemainingSec).toBe(57);
    expect(store.getState().stopwatchElapsedMs).toBe(3000);
    vi.setSystemTime(new Date(2020, 0, 1));
    vi.advanceTimersByTime(1000);
    store.pauseStopwatch();
    expect(store.getState().stopwatchElapsedMs).toBe(4000);
    expect(store.getState().timerRemainingSec).toBe(56);
  });
  it("preserves fractional countdown time when paused between ticks", () => {
    const store = makeStore();
    store.startTimer(1);
    vi.advanceTimersByTime(900);
    store.pauseTimer();
    vi.advanceTimersByTime(1000);
    store.resumeTimer();
    vi.advanceTimersByTime(250);
    expect(store.getState().timerStatus).toBe("completed");
    expect(clockAudio.playTimerDone).toHaveBeenCalledTimes(1);
  });
  it("records the lap at the instant of the user action", () => {
    const store = makeStore();
    store.startStopwatch();
    vi.advanceTimersByTime(79);
    store.lapStopwatch();
    expect(store.getState().stopwatchLaps).toEqual([79]);
  });
});

describe("alarm scheduling regressions", () => {
  it("does not backfill an alarm that was created after its scheduled minute", () => {
    const store = makeStore();
    vi.setSystemTime(new Date(2026, 0, 5, 9, 2));
    store.addAlarm({ time: "09:00", label: "Synthetic tomorrow" });
    vi.advanceTimersByTime(1000);
    expect(store.getState().ringingAlarm).toBeNull();
  });
  it("rings a daily alarm again on a later date at the same HH:MM", () => {
    const store = makeStore();
    store.addAlarm({ time: "09:00", label: "Synthetic daily" });
    vi.advanceTimersByTime(2000);
    expect(store.getState().ringingAlarm?.label).toBe("Synthetic daily");
    store.dismissRingingAlarm();
    vi.setSystemTime(new Date(2026, 0, 6, 8, 59, 59));
    vi.advanceTimersByTime(1000);
    expect(store.getState().ringingAlarm?.label).toBe("Synthetic daily");
  });
  it("catches up a due alarm after ticks were suspended past its minute", () => {
    const store = makeStore();
    store.addAlarm({ time: "09:00", label: "Synthetic catchup" });
    vi.setSystemTime(new Date(2026, 0, 5, 9, 2));
    page.dispatchEvent(new Event("visibilitychange"));
    expect(store.getState().ringingAlarm?.label).toBe("Synthetic catchup");
  });
  it("disables once alarms as soon as they fire and persists that decision", () => {
    const store = makeStore();
    store.addAlarm({ time: "09:00", label: "Synthetic once", days: "once" });
    vi.advanceTimersByTime(2000);
    expect(store.getState().ringingAlarm?.label).toBe("Synthetic once");
    expect(store.getState().alarms.find((alarm) => alarm.label === "Synthetic once")?.enabled).toBe(false);
    expect(JSON.parse(saved.get(ALARMS)!).find((alarm: { label: string }) => alarm.label === "Synthetic once").enabled).toBe(false);
  });
  it("queues simultaneous alarms rather than silently dropping the second", () => {
    const store = makeStore();
    store.addAlarm({ time: "09:00", label: "Synthetic first", days: "once" });
    store.addAlarm({ time: "09:00", label: "Synthetic second", days: "once" });
    vi.advanceTimersByTime(2000);
    expect(store.getState().ringingAlarm?.label).toBe("Synthetic first");
    store.dismissRingingAlarm();
    expect(store.getState().ringingAlarm?.label).toBe("Synthetic second");
  });
  it("snoozes independently of an active timer and rings again as an alarm", () => {
    const store = makeStore();
    store.startTimer(600, "Synthetic tea");
    store.addAlarm({ time: "09:00", label: "Synthetic wake", days: "once" });
    vi.advanceTimersByTime(2000);
    store.snoozeRingingAlarm(1);
    expect(store.getState().ringingAlarm).toBeNull();
    expect(store.getState().timerLabel).toBe("Synthetic tea");
    expect(store.getState().timerRemainingSec).toBe(598);
    vi.advanceTimersByTime(60000);
    expect(store.getState().ringingAlarm?.label).toBe("Synthetic wake");
    expect(store.getState().timerRemainingSec).toBe(538);
    expect(clockAudio.playTimerDone).not.toHaveBeenCalled();
  });
  it("does not accept an invalid snooze duration or lose the ringing alarm", () => {
    const store = makeStore();
    store.addAlarm({ time: "09:00", label: "Synthetic wake" });
    vi.advanceTimersByTime(2000);
    store.snoozeRingingAlarm(NaN);
    expect(store.getState().ringingAlarm?.label).toBe("Synthetic wake");
  });
});

describe("Web Audio lifecycle regressions", () => {
  beforeEach(() => { vi.resetModules(); });
  it("does not queue tones during denied audio and cleans active tones if audio suspends", async () => {
    const { clockAudio: actual } = await vi.importActual<typeof import("../src/lib/clockAudio.js")>("../src/lib/clockAudio.js");
    const oscillators: { stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
    const param = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
    const context = {
      currentTime: 0, state: "suspended", destination: {},
      resume: vi.fn().mockRejectedValue(new Error("synthetic denied resume")),
      createOscillator() {
        const osc = { type: "sine", frequency: param, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), onended: null };
        oscillators.push(osc);
        return osc;
      },
      createGain() { return { gain: param, connect: vi.fn(), disconnect: vi.fn() }; },
    };
    Object.assign(window, { AudioContext: class { constructor() { return context; } } });
    actual.unlock();
    actual.startAlarm();
    vi.advanceTimersByTime(140000);
    expect(oscillators).toHaveLength(0);
    // A later permitted gesture can resume the still-pending alarm.
    context.resume.mockImplementation(async () => { context.state = "running"; });
    actual.unlock();
    vi.advanceTimersByTime(1400);
    expect(oscillators).toHaveLength(2);
    // A new interruption must not retain scheduled tones for a future resume.
    context.state = "suspended";
    vi.advanceTimersByTime(140000);
    expect(oscillators).toHaveLength(2);
    oscillators.forEach((osc) => { expect(osc.disconnect).toHaveBeenCalledTimes(1); expect(osc.stop).toHaveBeenCalledTimes(2); });
    actual.stopAlarm();
  });
  it("exposes gesture-time unlock and tolerates unavailable or rejected audio", async () => {
    const { clockAudio: actual } = await vi.importActual<typeof import("../src/lib/clockAudio.js")>("../src/lib/clockAudio.js");
    expect(typeof (actual as unknown as { unlock?: unknown }).unlock).toBe("function");
    Object.assign(window, { AudioContext: class { constructor() { throw new Error("unsupported"); } } });
    expect(() => (actual as unknown as { unlock(): void }).unlock()).not.toThrow();
    expect(() => actual.playTimerDone()).not.toThrow();
    expect(() => actual.startAlarm()).not.toThrow();
    actual.stopAlarm();
  });
  it("disconnects ended oscillators and does not stop them again on dismissal", async () => {
    const { clockAudio: actual } = await vi.importActual<typeof import("../src/lib/clockAudio.js")>("../src/lib/clockAudio.js");
    const oscillators: { stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended: (() => void) | null }[] = [];
    const param = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
    const resume = vi.fn().mockResolvedValue(undefined);
    Object.assign(window, { AudioContext: class {
      currentTime = 0; state = "running"; destination = {};
      resume = resume;
      createOscillator() { const osc = { type: "sine", frequency: param, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), onended: null }; oscillators.push(osc); return osc; }
      createGain() { return { gain: param, connect: vi.fn(), disconnect: vi.fn() }; }
    } });
    actual.startAlarm();
    oscillators.forEach((osc) => osc.onended?.());
    actual.stopAlarm();
    expect(oscillators).toHaveLength(2);
    oscillators.forEach((osc) => { expect(osc.disconnect).toHaveBeenCalledTimes(1); expect(osc.stop).toHaveBeenCalledTimes(1); });
  });
});
