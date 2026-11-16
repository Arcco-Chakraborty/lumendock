import { useEffect, useRef, useSyncExternalStore } from "react";
import type { TimeStore } from "../lib/timeStore.js";

/** One top-layer alert, including when the Clock itself is closed. */
export function ClockAlert({ timeStore }: { timeStore: TimeStore }) {
  const state = useSyncExternalStore(timeStore.subscribe, () => timeStore.getState(), () => timeStore.getState());
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const alarm = state.ringingAlarm;
  const active = Boolean(alarm) || state.timerStatus === "completed";
  const dismiss = () => { if (alarm) timeStore.dismissRingingAlarm(); else timeStore.dismissTimer(); };
  useEffect(() => {
    if (!active) return;
    opener.current = document.activeElement as HTMLElement;
    const current = dialog.current;
    current?.showModal();
    return () => {
      current?.close();
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, [active]);
  return active ? <dialog ref={dialog} className="clock-alert" role="alertdialog" aria-labelledby="clock-alert-title" aria-describedby="clock-alert-description" onCancel={e => { e.preventDefault(); dismiss(); }}>
    <h2 id="clock-alert-title">{alarm ? `Alarm: ${alarm.label}` : "Timer complete"}</h2>
    <p id="clock-alert-description">{alarm ? alarm.time : state.timerLabel || "Your focus time is finished."}</p>
    {alarm && state.timerStatus === "completed" && <p>Timer complete also waiting</p>}
    <div className="clock-alert-actions">{alarm && <button type="button" onClick={() => timeStore.snoozeRingingAlarm(5)}>Snooze (5m)</button>}<button type="button" autoFocus onClick={dismiss}>Dismiss</button></div>
  </dialog> : null;
}
