import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { globalTimeStore, type AlarmItem, type WallpaperTheme, type TimeStore } from "../lib/timeStore.js";
import { clockAudio } from "../lib/clockAudio.js";
import { FlipCard } from "./FlipCard.js";
import "./clock.css";

export interface ClockViewProps {
  timeStore?: TimeStore;
  onClose: () => void;
  initialTab?: "wallpaper" | "timer" | "alarm" | "stopwatch";
}
const two = (n: number) => n.toString().padStart(2, "0");
function duration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  return `${h ? `${h}:` : ""}${two(Math.floor(seconds % 3600 / 60))}:${two(seconds % 60)}`;
}
function stopwatch(ms: number) {
  return `${two(Math.floor(ms / 60000))}:${two(Math.floor(ms / 1000) % 60)}.${two(Math.floor(ms % 1000 / 10))}`;
}
function nextAlarm(alarms: AlarmItem[], now: Date) {
  return alarms.filter(a => a.enabled).map(alarm => {
    const [h, m] = alarm.time.split(":").map(Number);
    const date = new Date(now); date.setHours(h!, m!, 0, 0);
    if (date <= now) date.setDate(date.getDate() + 1);
    while (alarm.days === "weekdays" && [0, 6].includes(date.getDay())) date.setDate(date.getDate() + 1);
    return { alarm, date };
  }).sort((a, b) => a.date.getTime() - b.date.getTime())[0];
}
const modes = [["wallpaper", "Clock"], ["timer", "Timer"], ["alarm", "Alarms"], ["stopwatch", "Stopwatch"]] as const;

export function ClockView({ timeStore = globalTimeStore, onClose, initialTab = "wallpaper" }: ClockViewProps) {
  const state = useSyncExternalStore(timeStore.subscribe, () => timeStore.getState(), () => timeStore.getState());
  const [activeTab, setActiveTab] = useState(initialTab);
  const [controls, setControls] = useState(initialTab !== "wallpaper");
  const [appearance, setAppearance] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const dialog = useRef<HTMLDialogElement>(null);
  const settings = useRef<HTMLDialogElement>(null);
  const reveal = useRef<HTMLButtonElement>(null);
  const [customMinutes, setCustomMinutes] = useState(5);
  const [customSeconds, setCustomSeconds] = useState(0);
  const [timerLabel, setTimerLabel] = useState("Focus");
  const [showAddAlarm, setShowAddAlarm] = useState(false);
  const [alarmTime, setAlarmTime] = useState("08:00");
  const [alarmLabel, setAlarmLabel] = useState("");
  const [alarmDays, setAlarmDays] = useState<AlarmItem["days"]>("daily");
  const [activity, setActivity] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
    return () => { dialog.current?.close(); };
  }, []);
  useEffect(() => {
    if (appearance) settings.current?.showModal();
    else settings.current?.close();
  }, [appearance]);
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    const tick = () => { setNow(new Date()); id = setTimeout(tick, 1000 - Date.now() % 1000); };
    id = setTimeout(tick, 1000 - Date.now() % 1000);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    if (!controls || appearance || showAddAlarm || activeTab !== "wallpaper" && !(activeTab === "timer" && (state.timerStatus === "running" || state.timerStatus === "paused"))) return;
    const id = setTimeout(() => {
      // Pointer quiet must never remove the control a keyboard user is using.
      if (!dialog.current?.querySelector(".clock-header:focus-within, .timer-actions-row:focus-within, form:focus-within")) setControls(false);
    }, 6000);
    return () => clearTimeout(id);
  }, [controls, appearance, showAddAlarm, activeTab, activity, state.timerStatus]);
  const upcoming = useMemo(() => nextAlarm(state.alarms, now), [state.alarms, now]);
  const timerActive = state.timerStatus === "running" || state.timerStatus === "paused";
  const setupSeconds = customMinutes * 60 + customSeconds;
  const timerSeconds = state.timerStatus === "idle" ? setupSeconds : state.timerRemainingSec;
  const percent = state.timerDurationSec > 0 ? Math.max(0, Math.min(1, state.timerRemainingSec / state.timerDurationSec)) : 0;
  const start = () => { clockAudio.unlock(); timeStore.startTimer(setupSeconds, timerLabel.trim() || "Focus"); setControls(false); reveal.current?.focus(); };
  const chooseMode = (tab: typeof activeTab) => { setActiveTab(tab); setControls(true); };
  return (
    <dialog ref={dialog} aria-label="Clock" className={`clock-view clock-theme-${state.wallpaperTheme} ${controls ? "controls-visible" : "controls-hidden"} ${activeTab === "timer" && !controls ? "is-timer-focus" : ""}`}
      onCancel={e => { e.preventDefault(); onClose(); }}
      onPointerDown={() => setActivity(a => a + 1)}
      onFocus={() => setActivity(a => a + 1)}
      onClick={e => {
        if ((e.target as HTMLElement).closest("button,input,select,label,form,dialog.clock-appearance")) return;
        if (activeTab === "wallpaper" || timerActive && activeTab === "timer") setControls(c => !c);
      }}>
      <header id="clock-menu" className={`clock-header ${controls ? "" : "is-hidden"}`} aria-label="Clock navigation">
        <div className="clock-tabs" role="tablist" aria-label="Clock modes" onKeyDown={e => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
          e.preventDefault();
          const index = modes.findIndex(([mode]) => mode === activeTab);
          const next = e.key === "Home" ? 0 : e.key === "End" ? 3 : (index + (e.key === "ArrowRight" ? 1 : 3)) % 4;
          chooseMode(modes[next]![0]);
          dialog.current?.querySelector<HTMLButtonElement>(`#clock-${modes[next]![0]}-tab`)?.focus();
        }}>
          {modes.map(([mode, label]) => <button key={mode} id={`clock-${mode}-tab`} type="button" role="tab" aria-selected={activeTab === mode} aria-controls="clock-mode-panel" tabIndex={activeTab === mode ? 0 : -1} className={`clock-tab ${activeTab === mode ? "is-active" : ""}`} onClick={() => chooseMode(mode)}>{label}</button>)}
        </div>
        <div className="clock-menu-actions">
          <button type="button" className="clock-close-button" aria-label="Close clock" title="Back to Monitor" onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h12"/></svg></button>
          <button type="button" aria-label="Appearance" title="Appearance" onClick={() => setAppearance(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></svg></button>
        </div>
      </header>
      <div className={`clock-body mode-${activeTab}`} id="clock-mode-panel" role="tabpanel" aria-labelledby={`clock-${activeTab}-tab`}>
        {activeTab === "wallpaper" && <div className={`wallpaper-clock-container ${state.wallpaperStacked ? "is-stacked" : "is-horizontal"}${timerActive || upcoming ? " has-clock-status" : ""}`}>
          <div className={`wallpaper-digits-box ${state.wallpaperStacked ? "wallpaper-stacked-digits" : "wallpaper-horizontal-digits"}`} aria-label={`Local time ${now.toLocaleTimeString()}`}>
            <div className="clock-face">
            <FlipCard className="digit-hours" value={two(now.getHours() % 12 || 12)} corner={now.getHours() >= 12 ? "PM" : "AM"} />
            <FlipCard className="digit-minutes" value={two(now.getMinutes())} corner={state.wallpaperSeconds ? `${two(now.getSeconds())} sec` : undefined} cornerSide="end" />
          <div className="wallpaper-date-row">{now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</div>
          <div className={`wallpaper-status-row${timerActive || upcoming ? "" : " is-empty"}`}>
            {timerActive ? <button type="button" className="wallpaper-timer-pill" onClick={() => chooseMode("timer")}>{state.timerLabel || "Timer"} · {duration(state.timerRemainingSec)}{state.timerStatus === "paused" ? " · Paused" : ""}</button>
              : upcoming ? <span>Next alarm · {upcoming.date.toLocaleDateString([], { weekday: "short" })} {upcoming.alarm.time}</span> : <span className="clock-status-empty" aria-hidden="true">&nbsp;</span>}
          </div>
          </div></div>
        </div>}
        {activeTab === "timer" && <div className={`timer-tab-content ${timerActive ? "timer-active" : ""}`}>
          <div className="timer-display-card">
            <div className="timer-dial-slot"><div className="timer-dial">
              {<svg className="timer-svg" viewBox="0 0 200 200" role="img" aria-label="Timer progress"><circle className="timer-track" cx="100" cy="100" r="94"/><circle className="timer-progress" cx="100" cy="100" r="94" pathLength="100" strokeDasharray="100" strokeDashoffset={100 * (1 - percent)}/></svg>}
              <div className="timer-readout">
                <span className="timer-label-tag">{state.timerStatus === "idle" ? timerLabel || "Focus" : state.timerLabel || "Timer"}</span>
                <div className={`timer-big-digits${timerSeconds >= 3600 ? " timer-long-duration" : ""}`} aria-label="Timer remaining">{duration(timerSeconds)}</div>
                <span className="timer-status-badge">{state.timerStatus === "running" ? "Running" : state.timerStatus === "paused" ? "Paused" : state.timerStatus === "completed" ? "Complete" : "Ready"}</span>
              </div>
            </div></div>
            <div className="timer-side">
              <div className="timer-ends">{state.timerStatus === "running" ? `Ends at ${new Date(now.getTime() + state.timerRemainingSec * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : state.timerStatus === "paused" ? "Resume when you're ready" : "A little room to focus"}</div>
              <div className="timer-actions-row">
                {state.timerStatus === "idle" && <button type="submit" form="timer-config-form" className="clock-primary" disabled={setupSeconds <= 0 || setupSeconds > 86400}>Start focus</button>}
                {state.timerStatus === "running" && <button type="button" className="clock-primary" onClick={() => timeStore.pauseTimer()}>Pause</button>}
                {state.timerStatus === "paused" && <button type="button" className="clock-primary" onClick={() => { clockAudio.unlock(); timeStore.resumeTimer(); }}>Resume</button>}
                {timerActive && controls && <><button type="button" onClick={() => timeStore.addTimerMinutes(1)}>+1 Min</button><button type="button" onClick={() => timeStore.resetTimer()}>Reset</button></>}
              </div>
            </div>
          </div>
          {state.timerStatus === "idle" && <form id="timer-config-form" className="timer-config-panel" onSubmit={e => { e.preventDefault(); start(); }}>
            <span className="clock-eyebrow">Duration</span>
            <div className="timer-preset-chips">{[1, 5, 10, 15, 25, 45, 60].map(m => <button key={m} type="button" className={customMinutes === m && customSeconds === 0 ? "is-selected" : ""} onClick={() => { setCustomMinutes(m); setCustomSeconds(0); }}>{m} min</button>)}</div>
            <div className="custom-timer-inputs"><label>Minutes<input aria-label="Minutes" type="number" min="0" max="1440" value={customMinutes} onChange={e => setCustomMinutes(Math.min(1440, Math.max(0, Number(e.target.value) || 0)))}/></label><label>Seconds<input aria-label="Seconds" type="number" min="0" max="59" value={customSeconds} onChange={e => setCustomSeconds(Math.min(59, Math.max(0, Number(e.target.value) || 0)))}/></label></div>
            <label className="timer-label-input">Label<input maxLength={80} value={timerLabel} onChange={e => setTimerLabel(e.target.value)}/></label>
          </form>}
        </div>}
        {activeTab === "alarm" && <div className="alarm-tab-content">
          <div className="alarm-top-row"><p className="clock-muted">Keep LumenDock open for alarms. They do not run when the app is closed.</p><button type="button" onClick={() => setShowAddAlarm(v => !v)}>{showAddAlarm ? "Cancel" : "Add alarm"}</button></div>
          {showAddAlarm && <form className="add-alarm-card" onSubmit={e => { e.preventDefault(); clockAudio.unlock(); timeStore.addAlarm({ time: alarmTime, label: alarmLabel, days: alarmDays }); setShowAddAlarm(false); setAlarmLabel(""); }}>
            <label>Time<input id="alarm-time-input" type="time" required value={alarmTime} onChange={e => setAlarmTime(e.target.value)}/></label>
            <label>Label<input id="alarm-label-input" maxLength={120} value={alarmLabel} onChange={e => setAlarmLabel(e.target.value)}/></label>
            <label>Repeat<select value={alarmDays} onChange={e => setAlarmDays(e.target.value as AlarmItem["days"])}><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="once">Once</option></select></label>
            <button type="submit" className="clock-primary">Save alarm</button>
          </form>}
          <div className="alarm-list">{state.alarms.length === 0 ? <p className="clock-empty">No alarms yet</p> : state.alarms.map(a => <div key={a.id} className={`alarm-row ${a.enabled ? "is-enabled" : "is-disabled"}`}><div className="alarm-info"><span className="alarm-time-text">{a.time}</span><span>{a.label}</span><small className="clock-muted">{a.days === "daily" ? "Every day" : a.days === "weekdays" ? "Weekdays" : "Once"}</small></div><label className="alarm-switch"><input type="checkbox" checked={a.enabled} aria-label={`Toggle alarm ${a.label}`} onChange={() => { if (!a.enabled) clockAudio.unlock(); timeStore.toggleAlarm(a.id); }}/><span>{a.enabled ? "On" : "Off"}</span></label><button type="button" className="delete-alarm-btn" aria-label={`Delete alarm ${a.label}`} onClick={() => timeStore.deleteAlarm(a.id)}>Delete</button></div>)}</div>
        </div>}
        {activeTab === "stopwatch" && <div className="stopwatch-tab-content"><div className="stopwatch-display-card"><div className="stopwatch-readout" aria-label="Stopwatch elapsed">{stopwatch(state.stopwatchElapsedMs)}</div><div className="stopwatch-actions">{state.stopwatchStatus !== "running" ? <button type="button" className="clock-primary" onClick={() => timeStore.startStopwatch()}>{state.stopwatchStatus === "idle" ? "Start" : "Resume"}</button> : <><button type="button" onClick={() => timeStore.lapStopwatch()}>Lap</button><button type="button" className="clock-primary" onClick={() => timeStore.pauseStopwatch()}>Stop</button></>}{state.stopwatchStatus === "paused" && <button type="button" onClick={() => timeStore.resetStopwatch()}>Reset</button>}</div></div>{state.stopwatchLaps.length > 0 && <div className="stopwatch-laps-table"><div className="laps-header"><span>Lap</span><span>Split</span><span>Total</span></div>{state.stopwatchLaps.map((total, i) => <div className="lap-row" key={state.stopwatchLaps.length - i}><span>Lap {state.stopwatchLaps.length - i}</span><span>{stopwatch(total - (state.stopwatchLaps[i + 1] || 0))}</span><span>{stopwatch(total)}</span></div>)}</div>}</div>}
      </div>
      <footer className="clock-bottom"><button ref={reveal} type="button" className="clock-reveal" aria-label={controls ? "Hide clock controls" : "Show controls"} title={controls ? "Hide controls" : "Show controls"} aria-expanded={controls} aria-controls="clock-menu" onClick={() => setControls(c => !c)}><svg viewBox="0 0 24 24" aria-hidden="true">{controls ? <path d="m6 6 12 12M6 18 18 6"/> : <path d="M5 6h14M5 12h14M5 18h14"/>}</svg></button></footer>
      <dialog ref={settings} className="clock-appearance" aria-labelledby="clock-appearance-title" onCancel={e => { e.preventDefault(); e.stopPropagation(); setAppearance(false); }}>
        <div className="clock-appearance-heading"><h2 id="clock-appearance-title">Appearance</h2><button type="button" onClick={() => setAppearance(false)}>Done</button></div>
        <label>Theme<select aria-label="Clock theme" value={state.wallpaperTheme} onChange={e => timeStore.setWallpaperTheme(e.target.value as WallpaperTheme)}><option value="sonoma">Graphite</option><option value="oled">Cyan</option><option value="amber">Amber</option><option value="minimal">Mono</option></select></label>
        <label>Layout<select aria-label="Clock layout" value={state.wallpaperStacked ? "stacked" : "horizontal"} onChange={e => timeStore.setWallpaperStacked(e.target.value === "stacked")}><option value="horizontal">Fit screen</option><option value="stacked">Stacked</option></select></label>
        <label className="clock-checkbox"><input type="checkbox" checked={state.wallpaperSeconds} onChange={e => timeStore.setWallpaperSeconds(e.target.checked)}/>Show seconds</label>
      </dialog>
    </dialog>
  );
}
