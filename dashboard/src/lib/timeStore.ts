import { clockAudio } from "./clockAudio.js";

export interface AlarmItem {
  id: string;
  time: string; // "HH:MM" in 24h format
  label: string;
  enabled: boolean;
  days: "daily" | "weekdays" | "once";
}

export type TimerStatus = "idle" | "running" | "paused" | "completed";
export type StopwatchStatus = "idle" | "running" | "paused";
export type WallpaperTheme = "sonoma" | "oled" | "amber" | "minimal";

export interface TimeState {
  // Timer
  timerStatus: TimerStatus;
  timerDurationSec: number;
  timerRemainingSec: number;
  timerLabel?: string | undefined;

  // Alarms
  alarms: AlarmItem[];
  ringingAlarm: AlarmItem | null;

  // Stopwatch
  stopwatchStatus: StopwatchStatus;
  stopwatchElapsedMs: number;
  stopwatchLaps: number[];

  // Wallpaper preferences
  wallpaperTheme: WallpaperTheme;
  wallpaperSeconds: boolean;
  wallpaperStacked: boolean;
}

const STORAGE_ALARMS_KEY = "lumendock_alarms";
const STORAGE_PREFS_KEY = "lumendock_clock_prefs";
const MAX_TIMER_SEC = 24 * 60 * 60;
const validTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const validDays = (value: unknown): value is AlarmItem["days"] => value === "daily" || value === "weekdays" || value === "once";
const validTheme = (value: unknown): value is WallpaperTheme => value === "sonoma" || value === "oled" || value === "amber" || value === "minimal";
const validDuration = (value: number) => Number.isFinite(value) && value > 0 && value <= MAX_TIMER_SEC;
const monotonicNow = () => performance.now();

function readSaved(key: string): unknown {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function save(key: string, value: unknown) {
  try {
    if (typeof window !== "undefined") window.localStorage?.setItem(key, JSON.stringify(value));
  } catch { /* Storage may be unavailable; session controls must still work. */ }
}
function loadSavedAlarms(): AlarmItem[] {
  const raw = readSaved(STORAGE_ALARMS_KEY);
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  return raw.filter((item): item is AlarmItem => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || ids.has(item.id) ||
      !validTime(item.time) || typeof item.label !== "string" || typeof item.enabled !== "boolean" || !validDays(item.days)) return false;
    ids.add(item.id);
    return true;
  }).map(({ id, time, label, enabled, days }) => ({ id, time, label, enabled, days }));
}
function loadSavedPrefs() {
  const raw = readSaved(STORAGE_PREFS_KEY);
  const prefs = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    theme: validTheme(prefs.theme) ? prefs.theme : "sonoma" as WallpaperTheme,
    seconds: typeof prefs.seconds === "boolean" ? prefs.seconds : true,
    stacked: typeof prefs.stacked === "boolean" ? prefs.stacked : false,
  };
}

export class TimeStore {
  private state: TimeState;
  private listeners = new Set<() => void>();
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private timerTargetMs: number | null = null;
  private timerPausedMs = 0;
  private stopwatchInterval: ReturnType<typeof setInterval> | null = null;
  private stopwatchStartedMs: number | null = null;
  private stopwatchBaseMs = 0;
  private alarmCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastAlarmCheckMs = Date.now();
  private alarmOccurrences = new Set<string>();
  private alarmArmedAt = new Map<string, number>();
  private pendingAlarms: AlarmItem[] = [];
  private snoozes = new Map<string, { alarm: AlarmItem; dueMs: number }>();

  constructor() {
    const prefs = loadSavedPrefs();
    this.state = {
      timerStatus: "idle", timerDurationSec: 300, timerRemainingSec: 300,
      alarms: loadSavedAlarms(), ringingAlarm: null,
      stopwatchStatus: "idle", stopwatchElapsedMs: 0, stopwatchLaps: [],
      wallpaperTheme: prefs.theme, wallpaperSeconds: prefs.seconds, wallpaperStacked: prefs.stacked,
    };
    if (typeof window !== "undefined") {
      this.alarmCheckInterval = setInterval(this.checkAlarms, 1000);
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  getState(): TimeState { return this.state; }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private notify() { this.listeners.forEach((listener) => listener()); }

  startTimer(durationSec: number, label?: string) {
    if (!validDuration(durationSec)) return;
    this.stopTimerInterval();
    this.timerPausedMs = durationSec * 1000;
    this.timerTargetMs = monotonicNow() + this.timerPausedMs;
    this.state = { ...this.state, timerStatus: "running", timerDurationSec: durationSec, timerRemainingSec: durationSec, timerLabel: label };
    this.notify();
    this.timerInterval = setInterval(this.tickTimer, 250);
  }
  private tickTimer = () => {
    if (this.timerTargetMs === null || this.state.timerStatus !== "running") return;
    const left = Math.max(0, this.timerTargetMs - monotonicNow());
    const seconds = Math.ceil(left / 1000);
    if (left === 0) {
      this.stopTimerInterval();
      this.timerTargetMs = null;
      this.timerPausedMs = 0;
      this.state = { ...this.state, timerStatus: "completed", timerRemainingSec: 0 };
      clockAudio.playTimerDone();
      this.notify();
    } else if (seconds !== this.state.timerRemainingSec) {
      this.state = { ...this.state, timerRemainingSec: seconds };
      this.notify();
    }
  };
  pauseTimer() {
    if (this.state.timerStatus !== "running" || this.timerTargetMs === null) return;
    this.tickTimer();
    if (this.state.timerStatus !== "running" || this.timerTargetMs === null) return;
    this.timerPausedMs = Math.max(0, this.timerTargetMs - monotonicNow());
    this.stopTimerInterval();
    this.timerTargetMs = null;
    this.state = { ...this.state, timerStatus: "paused", timerRemainingSec: Math.ceil(this.timerPausedMs / 1000) };
    this.notify();
  }
  resumeTimer() {
    if (this.state.timerStatus !== "paused" || this.timerPausedMs <= 0) return;
    this.timerTargetMs = monotonicNow() + this.timerPausedMs;
    this.state = { ...this.state, timerStatus: "running" };
    this.notify();
    this.timerInterval = setInterval(this.tickTimer, 250);
  }
  resetTimer() {
    this.stopTimerInterval();
    this.timerTargetMs = null;
    this.timerPausedMs = 0;
    this.state = { ...this.state, timerStatus: "idle", timerRemainingSec: this.state.timerDurationSec };
    this.notify();
  }
  addTimerMinutes(minutes: number) {
    const extraSec = minutes * 60;
    if (!validDuration(extraSec) || this.state.timerDurationSec + extraSec > MAX_TIMER_SEC) return;
    if (this.state.timerStatus === "completed") return;
    if (this.state.timerStatus === "running") {
      this.tickTimer();
      if (this.state.timerStatus !== "running" || this.timerTargetMs === null) return;
      this.timerTargetMs += extraSec * 1000;
    } else if (this.state.timerStatus === "paused") {
      this.timerPausedMs += extraSec * 1000;
    }
    this.state = { ...this.state, timerDurationSec: this.state.timerDurationSec + extraSec, timerRemainingSec: this.state.timerRemainingSec + extraSec };
    this.notify();
  }
  dismissTimer() { this.resetTimer(); }
  private stopTimerInterval() {
    if (this.timerInterval !== null) clearInterval(this.timerInterval);
    this.timerInterval = null;
  }

  addAlarm(alarm: { time: string; label: string; days?: AlarmItem["days"] }) {
    const days = alarm.days ?? "daily";
    if (!validTime(alarm.time) || !validDays(days) || typeof alarm.label !== "string") return;
    const next: AlarmItem = {
      id: "alarm-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      time: alarm.time, label: alarm.label.trim().slice(0, 120) || "Alarm", enabled: true, days,
    };
    this.alarmArmedAt.set(next.id, Date.now());
    this.state = { ...this.state, alarms: [...this.state.alarms, next].sort((a, b) => a.time.localeCompare(b.time)) };
    save(STORAGE_ALARMS_KEY, this.state.alarms);
    this.notify();
  }
  toggleAlarm(id: string) {
    const updated = this.state.alarms.map((alarm) => alarm.id === id ? { ...alarm, enabled: !alarm.enabled } : alarm);
    this.state = { ...this.state, alarms: updated };
    if (updated.find((alarm) => alarm.id === id)?.enabled) this.alarmArmedAt.set(id, Date.now());
    else this.cancelPendingAlarm(id);
    save(STORAGE_ALARMS_KEY, updated);
    this.notify();
  }
  deleteAlarm(id: string) {
    this.state = { ...this.state, alarms: this.state.alarms.filter((alarm) => alarm.id !== id) };
    this.cancelPendingAlarm(id);
    this.alarmArmedAt.delete(id);
    save(STORAGE_ALARMS_KEY, this.state.alarms);
    this.notify();
  }
  private cancelPendingAlarm(id: string) {
    this.snoozes.delete(id);
    this.pendingAlarms = this.pendingAlarms.filter((alarm) => alarm.id !== id);
    if (this.state.ringingAlarm?.id === id) this.dismissRingingAlarm();
  }
  dismissRingingAlarm() {
    clockAudio.stopAlarm();
    this.state = { ...this.state, ringingAlarm: null };
    this.showNextAlarm();
    this.notify();
  }
  snoozeRingingAlarm(minutes = 5) {
    const alarm = this.state.ringingAlarm;
    if (!alarm || !validDuration(minutes * 60)) return;
    this.snoozes.set(alarm.id, { alarm, dueMs: monotonicNow() + minutes * 60000 });
    this.dismissRingingAlarm();
  }
  private showNextAlarm() {
    if (this.state.ringingAlarm || this.pendingAlarms.length === 0) return;
    this.state = { ...this.state, ringingAlarm: this.pendingAlarms.shift()! };
    clockAudio.startAlarm();
  }
  private onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      this.tickTimer();
      this.tickStopwatch();
      this.checkAlarms();
    }
  };
  // Foreground/session scheduling only. Catch up the latest due occurrence after
  // a suspended tick; do not replay a backlog of days of recurring alarms.
  private checkAlarms = () => {
    const now = Date.now();
    const mono = monotonicNow();
    let changed = false;
    for (const [id, snooze] of this.snoozes) {
      if (snooze.dueMs <= mono) {
        this.pendingAlarms.push(snooze.alarm);
        this.snoozes.delete(id);
        changed = true;
      }
    }
    const newlyDue = new Set<string>();
    for (const alarm of this.state.alarms) {
      if (!alarm.enabled) continue;
      const [hours, minutes] = alarm.time.split(":").map(Number) as [number, number];
      // Looking back one week covers the latest daily/weekday occurrence,
      // including weekend suspension, without an unbounded clock-jump loop.
      for (let daysBack = 0; daysBack < 8; daysBack++) {
        const due = new Date(now);
        due.setDate(due.getDate() - daysBack);
        due.setHours(hours, minutes, 0, 0);
        if (due.getTime() > now) continue;
        if (alarm.days === "weekdays" && (due.getDay() === 0 || due.getDay() === 6)) continue;
        const currentMinute = Math.floor(now / 60000) === Math.floor(due.getTime() / 60000);
        if (due.getTime() <= Math.max(this.lastAlarmCheckMs, this.alarmArmedAt.get(alarm.id) ?? -Infinity) && !currentMinute) break;
        const occurrence = `${alarm.id}/${due.getFullYear()}-${due.getMonth()}-${due.getDate()}`;
        if (!this.alarmOccurrences.has(occurrence)) {
          this.alarmOccurrences.add(occurrence);
          if (!this.pendingAlarms.some((item) => item.id === alarm.id) && this.state.ringingAlarm?.id !== alarm.id) {
            this.pendingAlarms.push(alarm);
          }
          newlyDue.add(alarm.id);
          changed = true;
        }
        break;
      }
    }
    this.lastAlarmCheckMs = now;
    if (newlyDue.size) {
      this.state = { ...this.state, alarms: this.state.alarms.map((alarm) => newlyDue.has(alarm.id) && alarm.days === "once" ? { ...alarm, enabled: false } : alarm) };
      save(STORAGE_ALARMS_KEY, this.state.alarms);
    }
    if (changed) { this.showNextAlarm(); this.notify(); }
  };

  private elapsedStopwatch() {
    return this.stopwatchBaseMs + (this.stopwatchStartedMs === null ? 0 : Math.max(0, monotonicNow() - this.stopwatchStartedMs));
  }
  private tickStopwatch = () => {
    if (this.state.stopwatchStatus !== "running") return;
    this.state = { ...this.state, stopwatchElapsedMs: this.elapsedStopwatch() };
    this.notify();
  };
  startStopwatch() {
    if (this.state.stopwatchStatus === "running") return;
    this.stopwatchStartedMs = monotonicNow();
    this.state = { ...this.state, stopwatchStatus: "running" };
    this.notify();
    this.stopwatchInterval = setInterval(this.tickStopwatch, 40);
  }
  pauseStopwatch() {
    if (this.state.stopwatchStatus !== "running") return;
    this.stopwatchBaseMs = this.elapsedStopwatch();
    this.stopwatchStartedMs = null;
    if (this.stopwatchInterval !== null) clearInterval(this.stopwatchInterval);
    this.stopwatchInterval = null;
    this.state = { ...this.state, stopwatchStatus: "paused", stopwatchElapsedMs: this.stopwatchBaseMs };
    this.notify();
  }
  resetStopwatch() {
    if (this.stopwatchInterval !== null) clearInterval(this.stopwatchInterval);
    this.stopwatchInterval = null;
    this.stopwatchBaseMs = 0;
    this.stopwatchStartedMs = null;
    this.state = { ...this.state, stopwatchStatus: "idle", stopwatchElapsedMs: 0, stopwatchLaps: [] };
    this.notify();
  }
  lapStopwatch() {
    if (this.state.stopwatchStatus !== "running") return;
    const current = this.elapsedStopwatch();
    this.state = { ...this.state, stopwatchElapsedMs: current, stopwatchLaps: [current, ...this.state.stopwatchLaps] };
    this.notify();
  }

  private savePrefs() {
    save(STORAGE_PREFS_KEY, { theme: this.state.wallpaperTheme, seconds: this.state.wallpaperSeconds, stacked: this.state.wallpaperStacked });
  }
  setWallpaperTheme(theme: WallpaperTheme) {
    if (!validTheme(theme)) return;
    this.state = { ...this.state, wallpaperTheme: theme };
    this.savePrefs(); this.notify();
  }
  setWallpaperSeconds(seconds: boolean) {
    if (typeof seconds !== "boolean") return;
    this.state = { ...this.state, wallpaperSeconds: seconds };
    this.savePrefs(); this.notify();
  }
  setWallpaperStacked(stacked: boolean) {
    if (typeof stacked !== "boolean") return;
    this.state = { ...this.state, wallpaperStacked: stacked };
    this.savePrefs(); this.notify();
  }
  dispose() {
    this.stopTimerInterval();
    if (this.stopwatchInterval !== null) clearInterval(this.stopwatchInterval);
    if (this.alarmCheckInterval !== null) clearInterval(this.alarmCheckInterval);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.stopwatchInterval = null;
    this.alarmCheckInterval = null;
    this.pendingAlarms = [];
    this.snoozes.clear();
    clockAudio.stopAlarm();
    this.listeners.clear();
  }
}

export const globalTimeStore = new TimeStore();
