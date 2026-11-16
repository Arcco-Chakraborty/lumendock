import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { TimeStore } from "../src/lib/timeStore.js";
import { ClockView } from "../src/components/ClockView.js";
import { App } from "../src/App.js";
import { DashboardStore } from "../src/store.js";
import { fakeClock } from "./helpers.js";

function clock(tab: "wallpaper" | "timer" | "alarm" | "stopwatch" = "wallpaper", start?: (s: TimeStore) => void) {
  const store = new TimeStore();
  start?.(store);
  const html = render(<ClockView timeStore={store} onClose={() => {}} initialTab={tab} />);
  store.dispose();
  return html;
}

describe("Clock desk display", () => {
  it("opens as a clean labelled modal with a discoverable controls button", () => {
    const html = clock();
    expect(html).toContain('<dialog');
    expect(html).toContain('aria-label="Clock"');
    expect(html).toContain('Show controls');
    expect(html).toContain('wallpaper-digits-box');
    expect(html).not.toContain('Fullscreen');
    expect(html).not.toContain('clock-ambient-aura');
    expect(html).not.toContain('style=');
  });
  it("renders two split-flap time cards with a single readable value per card", () => {
    const html = clock();
    expect(html.match(/class="flip-card digit-(hours|minutes)"/g)).toHaveLength(2);
    expect(html.match(/class="flip-card-value"/g)).toHaveLength(2);
    expect(html).not.toContain('digit-colon');
    expect(html).not.toContain('is-flipping');
  });
  it("shows a circular timer ring at half remaining duration", () => {
    const html = clock("timer", s => {
      s.startTimer(600, "Synthetic focus");
      (s as unknown as { state: { timerRemainingSec: number } }).state.timerRemainingSec = 300;
    });
    expect(html).toContain('viewBox="0 0 200 200"');
    expect(html).toMatch(/<circle[^>]*class="timer-progress"[^>]*r="94"[^>]*pathLength="100"[^>]*stroke-dashoffset="50"/);
    expect(html).toContain('05:00');
  });
  it("idle timer readout matches the custom five minute setup", () => {
    const html = clock("timer");
    expect(html).toContain('05:00');
    expect(html).toContain('aria-label="Minutes"');
    expect(html).toContain('value="5"');
    expect(html).toContain('Start focus');
  });
  it("running timer preserves duration and hides replacement presets", () => {
    const html = clock("timer", s => s.startTimer(3660, "Focus"));
    expect(html).toContain('1:01:00');
    expect(html).toContain('Pause');
    expect(html).toContain('Ends at');
    expect(html).not.toContain('25 min');
    expect(html).not.toContain('style=');
  });
  it("alarms disclose foreground limits and stopwatch retains lap actions", () => {
    expect(clock("alarm")).toContain('Keep LumenDock open for alarms');
    expect(clock("stopwatch")).toContain('00:00.00');
  });
});

describe("App clock integration", () => {
  function app(start: (s: TimeStore) => void) {
    const timeStore = new TimeStore(), store = new DashboardStore(fakeClock());
    start(timeStore);
    const html = render(<App store={store} nativeAvailable timeStore={timeStore} />);
    timeStore.dispose(); store.dispose(); return html;
  }
  it("keeps a paused timer reachable and includes its full hours", () => {
    const html = app(s => { s.startTimer(3660); s.pauseTimer(); });
    expect(html).toContain('class="dock-timer-pill"');
    expect(html).toContain('Timer paused: 1:01:00');
    expect(html).not.toMatch(/class="local-clock"[^>]*tabindex="-1"/);
  });
  it("shows timer completion from Monitor", () => {
    const html = app(s => {
      (s as unknown as { state: { timerStatus: string } }).state.timerStatus = 'completed';
    });
    expect(html).toContain('Timer complete');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('Dismiss');
  });
});

describe("TimeStore Logic", () => {
  let store: TimeStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TimeStore();
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it("initializes with default wallpaper, timer, alarm, and stopwatch states", () => {
    const state = store.getState();
    expect(state.timerStatus).toBe("idle");
    expect(state.timerDurationSec).toBe(300);
    expect(state.timerRemainingSec).toBe(300);
    expect(state.stopwatchStatus).toBe("idle");
    expect(state.stopwatchElapsedMs).toBe(0);
    expect(state.stopwatchLaps).toEqual([]);
    expect(state.alarms.length).toBe(0);
    expect(state.wallpaperTheme).toBe("sonoma");
    expect(state.wallpaperStacked).toBe(false);
    expect(state.wallpaperSeconds).toBe(true);
  });

  it("handles timer countdown, pause, resume, and completion", () => {
    store.startTimer(10, "Focus");
    expect(store.getState().timerStatus).toBe("running");
    expect(store.getState().timerRemainingSec).toBe(10);
    expect(store.getState().timerLabel).toBe("Focus");

    // Advance 4 seconds
    vi.advanceTimersByTime(4000);
    expect(store.getState().timerRemainingSec).toBe(6);

    // Pause timer
    store.pauseTimer();
    expect(store.getState().timerStatus).toBe("paused");
    expect(store.getState().timerRemainingSec).toBe(6);

    // Advance 5 seconds while paused -> remaining should not change
    vi.advanceTimersByTime(5000);
    expect(store.getState().timerRemainingSec).toBe(6);

    // Resume timer
    store.resumeTimer();
    expect(store.getState().timerStatus).toBe("running");

    // Advance past completion
    vi.advanceTimersByTime(6500);
    expect(store.getState().timerStatus).toBe("completed");
    expect(store.getState().timerRemainingSec).toBe(0);

    // Dismiss
    store.dismissTimer();
    expect(store.getState().timerStatus).toBe("idle");
  });

  it("adds minutes to timer in running and idle states", () => {
    store.startTimer(60);
    expect(store.getState().timerRemainingSec).toBe(60);

    store.addTimerMinutes(2); // +120s
    expect(store.getState().timerRemainingSec).toBe(180);

    store.resetTimer();
    expect(store.getState().timerStatus).toBe("idle");
    store.addTimerMinutes(5);
    expect(store.getState().timerDurationSec).toBe(store.getState().timerRemainingSec);
  });

  it("manages alarms: add, toggle, delete, and ringing state", () => {
    const initialCount = store.getState().alarms.length;
    store.addAlarm({ time: "07:15", label: "Workout", days: "weekdays" });
    expect(store.getState().alarms.length).toBe(initialCount + 1);

    const added = store.getState().alarms.find((a) => a.label === "Workout")!;
    expect(added.time).toBe("07:15");
    expect(added.enabled).toBe(true);
    expect(added.days).toBe("weekdays");

    // Toggle off
    store.toggleAlarm(added.id);
    expect(store.getState().alarms.find((a) => a.id === added.id)!.enabled).toBe(false);

    // Toggle back on
    store.toggleAlarm(added.id);
    expect(store.getState().alarms.find((a) => a.id === added.id)!.enabled).toBe(true);

    // Delete
    store.deleteAlarm(added.id);
    expect(store.getState().alarms.find((a) => a.id === added.id)).toBeUndefined();
  });

  it("snoozes an alarm independently of an active timer", () => {
    store.startTimer(600, "Focus");
    store.addAlarm({ time: "12:00", label: "Meeting" });
    const alarm = store.getState().alarms.find(a => a.label === "Meeting")!;
    (store as unknown as { state: { ringingAlarm: unknown } }).state.ringingAlarm = alarm;
    store.snoozeRingingAlarm(5);
    expect(store.getState().ringingAlarm).toBeNull();
    expect(store.getState().timerLabel).toBe("Focus");
    expect(store.getState().timerRemainingSec).toBe(600);
  });

  it("runs stopwatch and records laps", () => {
    store.startStopwatch();
    expect(store.getState().stopwatchStatus).toBe("running");

    vi.advanceTimersByTime(2500);
    expect(store.getState().stopwatchElapsedMs).toBeGreaterThanOrEqual(2400);

    store.lapStopwatch();
    expect(store.getState().stopwatchLaps.length).toBe(1);

    vi.advanceTimersByTime(1500);
    store.lapStopwatch();
    expect(store.getState().stopwatchLaps.length).toBe(2);

    store.pauseStopwatch();
    expect(store.getState().stopwatchStatus).toBe("paused");

    store.resetStopwatch();
    expect(store.getState().stopwatchStatus).toBe("idle");
    expect(store.getState().stopwatchElapsedMs).toBe(0);
    expect(store.getState().stopwatchLaps).toEqual([]);
  });

  it("updates wallpaper clock preferences", () => {
    store.setWallpaperTheme("amber");
    expect(store.getState().wallpaperTheme).toBe("amber");

    store.setWallpaperStacked(false);
    expect(store.getState().wallpaperStacked).toBe(false);

    store.setWallpaperSeconds(false);
    expect(store.getState().wallpaperSeconds).toBe(false);
  });
});
