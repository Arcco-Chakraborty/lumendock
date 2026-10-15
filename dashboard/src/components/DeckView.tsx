import { useRef, useEffect, useSyncExternalStore } from "react";
import type { DashboardStore } from "../store.js";
import type { EspSnapshot, HostState, LightPatch } from "@phone-monitor/protocol";
import type { LightIntentController, IntentSnapshot } from "../lib/lightIntent.js";

interface DeckViewProps {
  store: DashboardStore;
  laptopConnected: boolean;
  host?: HostState | undefined;
  esp: EspSnapshot;
  controller: LightIntentController | null;
  onOpenLights?: () => void;
  onFeedback?: (msg: string | null) => void;
}
const apps = [
  ["open_claude", "Claude"], ["open_chatgpt", "ChatGPT"],
  ["open_chrome", "Chrome"], ["open_whatsapp", "WhatsApp"], ["open_terminal", "Terminal"],
] as const;
const ICON = {
  prev: "M6 5v14M18 5l-9 7 9 7V5Z",
  play: "m7 5 12 7-12 7V5Z",
  pause: "M8 5v14M16 5v14",
  playPause: "m4 5 9 7-9 7V5ZM17 5v14M21 5v14",
  next: "M18 5v14M6 5l9 7-9 7V5Z",
  volDown: "M6 8H2v8h4l6 4V4L6 8ZM17 12h6",
  mute: "M6 8H2v8h4l6 4V4L6 8ZM17 9l6 6m0-6-6 6",
  volUp: "M6 8H2v8h4l6 4V4L6 8ZM17 12h6m-3-3v6",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3",
  dnd: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM7 12h10",
  lock: "M6 11h12v10H6V11ZM8 11V8a4 4 0 0 1 8 0v3",
  capture: "M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0",
  power: "M12 3v9M7 5a8 8 0 1 0 10 0",
  controls: "M3 7h18M3 17h18M8 3v8M16 13v8",
} as const;
type ActionId =
  | (typeof apps)[number][0]
  | "media_prev" | "media_play_pause" | "media_next"
  | "volume_down" | "media_mute" | "volume_up"
  | "mic_mute" | "dnd_toggle" | "lock_screen" | "screenshot";
const presets = [["Warm", "#FFB454"], ["White", "#FFFFFF"], ["Cyan", "#00F0FF"]] as const;
const empty: IntentSnapshot = {desired:null, confirmed:null, stateOutcome:null, timerOutcome:null, queued:0, ready:false};
const noop = () => () => {};
const getEmpty = () => empty;

function Icon({path}: {path: string}) {
  return <svg className="deck-media-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={path} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
export function DeckView({ store, laptopConnected, host, esp, controller, onOpenLights, onFeedback }: DeckViewProps) {
  const intent = useSyncExternalStore(controller?.subscribe ?? noop, controller?.snapshot ?? getEmpty, controller?.snapshot ?? getEmpty);
  const data = intent.desired ?? esp.data;
  const mounted = useRef(true);
  const latest = useRef(0);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
      onFeedback?.(null);
    };
  }, [onFeedback]);
  const feedback = (message: string, settled = true) => {
    if (!mounted.current) return;
    onFeedback?.(message);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    if (settled) feedbackTimer.current = setTimeout(() => onFeedback?.(null), 5000);
  };
  const trigger = async (id: ActionId, label: string) => {
    const request = ++latest.current;
    if (!laptopConnected) { feedback("Connect laptop to use these keys."); return; }
    feedback(`${label}: sending…`, false);
    try {
      const result = await store.dispatchAction(id);
      if (request === latest.current) feedback(result.success ? `${label}: request sent` : `${label}: action failed. Try again.`);
    } catch {
      if (request === latest.current) feedback(`${label}: action failed. Try again.`);
    }
  };
  const sendLight = async (patch: LightPatch, label: string) => {
    const request = ++latest.current;
    if (!controller || !intent.ready) { feedback("Connect controller to change lighting."); return; }
    feedback(`${label}: pending`, false);
    try {
      const pending = controller.change(patch);
      controller.release();
      const result = await pending;
      if (request !== latest.current) return;
      const status = result.outcome === "confirmed" ? "confirmed" : result.outcome === "pending" ? "pending" : result.outcome === "unconfirmed" ? "unconfirmed; open light controls to retry" : "not sent";
      feedback(`${label}: ${status}`, result.outcome !== "pending");
    } catch {
      if (request === latest.current) feedback(`${label}: not queued. Check controller connection.`);
    }
  };
  // Laptop state is only trusted while the laptop link is live.
  const live = laptopConnected ? host : undefined;
  const media = live?.media ?? null;
  const playing = media?.status === "playing";
  const key = (id: ActionId, label: string, accessible: string, path: string, extra: {className?: string; pressed?: boolean | null | undefined} = {}) => (
    <button key={id} type="button"
      className={`deck-key${extra.className ? ` ${extra.className}` : ""}`}
      onClick={() => void trigger(id, accessible)} aria-label={accessible}
      aria-pressed={extra.pressed === undefined || extra.pressed === null ? undefined : extra.pressed}>
      <Icon path={path} /><span className="deck-key-title">{label}</span>
    </button>
  );
  return (
    <div className="deck-container" id="deck-panel" role="tabpanel" aria-labelledby="deck-tab">
      <section className="deck-section" aria-label="Application launchers">
        <h2 className="deck-section-title">Apps</h2>
        <div className="deck-grid deck-grid-apps">
          {apps.map(([id, label]) => <button key={id} type="button" className="deck-key deck-app" onClick={() => void trigger(id, label)} aria-label={`Open ${label}`}>
            <span className="deck-key-title">{label}</span>
            <svg className="launch-mark" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={id === "open_terminal" ? "m5 7 5 5-5 5M12 18h7" : "M9 5H5v14h14v-4M13 5h6v6M19 5 10 14"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>)}
        </div>
      </section>
      <section className="deck-section" aria-label="Media">
        <h2 className="deck-section-title">Media</h2>
        <div className="deck-grid deck-grid-media">
          <div className={`now-playing${media ? "" : " is-idle"}`}>
            {media ? <>
              <strong className="now-playing-title">{media.title || "Untitled"}</strong>
              <span className="now-playing-meta">{[media.artist, media.player].filter(Boolean).join(", ")}</span>
            </> : <span className="now-playing-meta">{laptopConnected ? "Nothing playing on the laptop" : "Connect laptop to see what is playing"}</span>}
            {live?.volumePercent != null && <span className="now-playing-volume">Volume {live.volumePercent}%{live.muted ? ", muted" : ""}</span>}
          </div>
          {key("media_prev", "Previous", "Previous track", ICON.prev)}
          {key("media_play_pause", media ? (playing ? "Pause" : "Play") : "Play / pause", "Play or pause", media ? (playing ? ICON.pause : ICON.play) : ICON.playPause, {className: "deck-key-play"})}
          {key("media_next", "Next", "Next track", ICON.next)}
        </div>
      </section>
      <section className="deck-section" aria-label="Sound and laptop">
        <h2 className="deck-section-title">System</h2>
        <div className="deck-grid deck-grid-system">
          {key("volume_down", "−5%", "Volume down", ICON.volDown)}
          {key("media_mute", live?.muted ? "Muted" : "Mute", "Toggle mute", ICON.mute, {className: `deck-key-led${live?.muted ? " is-alert" : ""}`, pressed: live?.muted})}
          {key("volume_up", "+5%", "Volume up", ICON.volUp)}
          {key("mic_mute", live?.micMuted ? "Mic off" : "Mic", "Toggle microphone", ICON.mic, {className: `deck-key-led${live?.micMuted ? " is-alert" : ""}`, pressed: live?.micMuted})}
          {key("dnd_toggle", "DND", "Toggle Do Not Disturb", ICON.dnd, {className: `deck-key-led${live?.doNotDisturb ? " is-on" : ""}`, pressed: live?.doNotDisturb})}
          {key("lock_screen", "Lock", "Lock laptop", ICON.lock)}
          {key("screenshot", "Capture", "Open screenshot tool", ICON.capture)}
        </div>
      </section>
      <section className="deck-section" aria-label="Lighting shortcuts">
        <h2 className="deck-section-title">Lamp</h2>
        <div className="deck-grid deck-grid-light">
          {presets.map(([label, hex]) => <button key={hex} type="button" className="deck-key" disabled={!intent.ready} onClick={() => void sendLight({hex, power:true}, `${label} light`)} aria-label={`${label} lamp`}>
            <svg width="24" height="24" className="deck-lamp-dot" aria-hidden="true"><circle cx="12" cy="12" r="8" fill={hex} /></svg><span className="deck-key-title">{label}</span>
          </button>)}
          <button type="button" className={`deck-key deck-key-led deck-key-lamp-toggle${data?.power ? " is-on" : ""}`} disabled={!intent.ready || !data} onClick={() => data && void sendLight({power:!data.power}, data.power ? "Lamp off" : "Lamp on")} aria-label={data?.power ? "Power off" : "Power on"} aria-pressed={data?.power ?? false}>
            <Icon path={ICON.power} /><span className="deck-key-title">{data?.power ? "Turn off" : "Turn on"}</span>
          </button>
          <button type="button" className="deck-key deck-key-palette" onClick={onOpenLights} aria-label="Light controls">
            <Icon path={ICON.controls} /><span className="deck-key-title">Controls</span>
          </button>
        </div>
      </section>
    </div>
  );
}
