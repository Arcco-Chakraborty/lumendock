import { useState, useRef, useEffect } from "react";
import type { DashboardStore } from "../store.js";
import type { EspSnapshot } from "@phone-monitor/protocol";
import type { LightIntentController } from "../lib/lightIntent.js";

interface DeckViewProps {
  store: DashboardStore;
  laptopConnected: boolean;
  esp: EspSnapshot;
  controller: LightIntentController | null;
  onOpenLights?: () => void;
  onFeedback?: (msg: string | null) => void;
}

export function DeckView({
  store,
  laptopConnected,
  esp,
  controller,
  onOpenLights,
  onFeedback,
}: DeckViewProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  const postFeedback = (msg: string) => {
    onFeedback?.(msg);
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => {
      onFeedback?.(null);
    }, 4000);
  };

  const trigger = async (id: string, label: string) => {
    setActiveKey(id);
    setTimeout(() => setActiveKey(null), 300);
    if (!laptopConnected && (id.startsWith("open_") || id.startsWith("media_") || id.startsWith("volume_"))) {
      postFeedback("Connect laptop to execute actions");
      return;
    }
    postFeedback(`Executing: ${label}...`);
    const res = await store.dispatchAction(id);
    postFeedback(res.message || (res.success ? `${label} triggered` : "Action failed"));
  };

  const setPreset = (hex: string, label: string) => {
    setActiveKey(`light_${hex}`);
    setTimeout(() => setActiveKey(null), 300);
    controller?.change({ hex, power: true });
    postFeedback(`Lamp: ${label}`);
  };

  const togglePower = () => {
    setActiveKey("light_power");
    setTimeout(() => setActiveKey(null), 300);
    if (esp.data) {
      controller?.change({ power: !esp.data.power });
      postFeedback(`Lamp: ${!esp.data.power ? "On" : "Off"}`);
    }
  };

  return (
    <div className="deck-container" role="region" aria-label="Stream Deck actions">

      {/* APPS & LAUNCHERS SECTION */}
      <div className="deck-section">
        <h2 className="deck-section-title">Launchers</h2>
        <div className="deck-grid deck-grid-apps">
          <button
            type="button"
            className={`deck-key deck-key-claude${activeKey === "open_claude" ? " is-active" : ""}`}
            onClick={() => trigger("open_claude", "Claude")}
            aria-label="Open Claude"
          >
            <div className="deck-key-glow" aria-hidden="true" />
            <svg className="deck-key-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2M7.5 13A2.5 2.5 0 0 0 5 15.5a2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 0 2.5-2.5A2.5 2.5 0 0 0 7.5 13m9 0a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 0 2.5-2.5 2.5 2.5 0 0 0-2.5-2.5" />
            </svg>
            <span className="deck-key-title">Claude</span>
            <span className="deck-key-sub">AI Workspace</span>
          </button>

          <button
            type="button"
            className={`deck-key deck-key-chatgpt${activeKey === "open_chatgpt" ? " is-active" : ""}`}
            onClick={() => trigger("open_chatgpt", "ChatGPT")}
            aria-label="Open ChatGPT"
          >
            <div className="deck-key-glow" aria-hidden="true" />
            <svg className="deck-key-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2m1 14.5h-2v-2h2zm0-4h-2V7h2z" />
            </svg>
            <span className="deck-key-title">ChatGPT</span>
            <span className="deck-key-sub">AI Assistant</span>
          </button>

          <button
            type="button"
            className={`deck-key deck-key-chrome${activeKey === "open_chrome" ? " is-active" : ""}`}
            onClick={() => trigger("open_chrome", "Chrome")}
            aria-label="Open Chrome"
          >
            <div className="deck-key-glow" aria-hidden="true" />
            <svg className="deck-key-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2m0 3.6a6.4 6.4 0 0 1 5.5 3.2h-5.5a3.2 3.2 0 0 0-2.8 1.6L7.4 7.2A6.4 6.4 0 0 1 12 5.6m-6.4 6.4a6.4 6.4 0 0 1 1-3.4l2.8 4.8a3.2 3.2 0 0 0 2.6 1.6v3.2A6.4 6.4 0 0 1 5.6 12m10 4.8-2.8-4.8a3.2 3.2 0 0 0 .2-3.2h5.6a6.4 6.4 0 0 1-3 8" />
            </svg>
            <span className="deck-key-title">Chrome</span>
            <span className="deck-key-sub">Browser</span>
          </button>

          <button
            type="button"
            className={`deck-key deck-key-whatsapp${activeKey === "open_whatsapp" ? " is-active" : ""}`}
            onClick={() => trigger("open_whatsapp", "WhatsApp")}
            aria-label="Open WhatsApp"
          >
            <div className="deck-key-glow" aria-hidden="true" />
            <svg className="deck-key-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2m.01 1.67c4.54 0 8.24 3.7 8.24 8.24 0 2.2-.86 4.28-2.42 5.83a8.18 8.18 0 0 1-5.82 2.41h-.01c-1.46 0-2.9-.39-4.16-1.14l-.3-.18-3.1 1.18.83-3.02-.2-.31a8.19 8.19 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.24-8.24" />
            </svg>
            <span className="deck-key-title">WhatsApp</span>
            <span className="deck-key-sub">Chat & Calls</span>
          </button>

          <button
            type="button"
            className={`deck-key deck-key-spotify${activeKey === "open_spotify" ? " is-active" : ""}`}
            onClick={() => trigger("open_spotify", "Spotify")}
            aria-label="Open Spotify"
          >
            <div className="deck-key-glow" aria-hidden="true" />
            <svg className="deck-key-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2m4.58 14.43a.63.63 0 0 1-.86.21c-2.36-1.44-5.33-1.77-8.83-.97a.63.63 0 0 1-.28-1.23c3.83-.87 7.12-.5 9.76 1.13a.63.63 0 0 1 .21.86m1.22-2.72a.78.78 0 0 1-1.07.26c-2.7-1.66-6.82-2.14-10.02-1.17a.78.78 0 0 1-.46-1.5c3.66-1.11 8.2-.58 11.29 1.34a.78.78 0 0 1 .26 1.07m.13-2.83C14.7 8.94 9.38 8.76 6.3 9.7a.94.94 0 0 1-.55-1.8c3.54-1.07 9.4-.87 13.12 1.34a.94.94 0 0 1-.94 1.64" />
            </svg>
            <span className="deck-key-title">Spotify</span>
            <span className="deck-key-sub">Player</span>
          </button>
        </div>
      </div>

      {/* MUSIC & AUDIO CONTROLS */}
      <div className="deck-section">
        <h2 className="deck-section-title">Music & Audio</h2>
        <div className="deck-grid deck-grid-media">
          <button
            type="button"
            className={`deck-key deck-key-media${activeKey === "media_prev" ? " is-active" : ""}`}
            onClick={() => trigger("media_prev", "Previous Track")}
            aria-label="Previous track"
          >
            <svg className="deck-media-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
            </svg>
            <span className="deck-key-title">Prev</span>
          </button>

          <button
            type="button"
            className={`deck-key deck-key-play${activeKey === "media_play_pause" ? " is-active" : ""}`}
            onClick={() => trigger("media_play_pause", "Play / Pause")}
            aria-label="Play or pause"
          >
            <svg className="deck-media-icon deck-icon-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z M6 5h2v14H6zm10 0h2v14h-2z" />
            </svg>
            <span className="deck-key-title">Play / Pause</span>
          </button>

          <button
            type="button"
            className={`deck-key deck-key-media${activeKey === "media_next" ? " is-active" : ""}`}
            onClick={() => trigger("media_next", "Next Track")}
            aria-label="Next track"
          >
            <svg className="deck-media-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="m6 18 8.5-6L6 6v12zM16 6v12h2V6z" />
            </svg>
            <span className="deck-key-title">Next</span>
          </button>

          <button
            type="button"
            className={`deck-key deck-key-audio${activeKey === "volume_down" ? " is-active" : ""}`}
            onClick={() => trigger("volume_down", "Volume Down")}
            aria-label="Volume down"
          >
            <svg className="deck-media-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M18.5 12A4.5 4.5 0 0 0 16 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02M5 9v6h4l5 5V4L9 9z" />
            </svg>
            <span className="deck-key-title">Vol -5%</span>
          </button>

          <button
            type="button"
            className={`deck-key deck-key-audio${activeKey === "media_mute" ? " is-active" : ""}`}
            onClick={() => trigger("media_mute", "Toggle Mute")}
            aria-label="Toggle mute"
          >
            <svg className="deck-media-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63m2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71M4.27 3 3 4.27l4.73 4.73H4v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18z" />
            </svg>
            <span className="deck-key-title">Mute</span>
          </button>

          <button
            type="button"
            className={`deck-key deck-key-audio${activeKey === "volume_up" ? " is-active" : ""}`}
            onClick={() => trigger("volume_up", "Volume Up")}
            aria-label="Volume up"
          >
            <svg className="deck-media-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77" />
            </svg>
            <span className="deck-key-title">Vol +5%</span>
          </button>
        </div>
      </div>

      {/* LIGHT & ATMOSPHERE QUICK KEYS */}
      <div className="deck-section">
        <h2 className="deck-section-title">Light & Ambience</h2>
        <div className="deck-grid deck-grid-light">
          <button
            type="button"
            className={`deck-key deck-key-warm${activeKey === "light_#FFB454" ? " is-active" : ""}`}
            onClick={() => setPreset("#FFB454", "Warm Sunset")}
            aria-label="Warm sunset lamp"
          >
            <span className="deck-lamp-dot" style={{ backgroundColor: "#FFB454" }} aria-hidden="true" />
            <span className="deck-key-title">Warm Sunset</span>
            <span className="deck-key-sub">2700K</span>
          </button>

          <button
            type="button"
            className={`deck-key deck-key-white${activeKey === "light_#FFFFFF" ? " is-active" : ""}`}
            onClick={() => setPreset("#FFFFFF", "Daylight")}
            aria-label="Daylight white lamp"
          >
            <span className="deck-lamp-dot" style={{ backgroundColor: "#FFFFFF" }} aria-hidden="true" />
            <span className="deck-key-title">Daylight</span>
            <span className="deck-key-sub">5500K</span>
          </button>

          <button
            type="button"
            className={`deck-key deck-key-neon${activeKey === "light_#00F0FF" ? " is-active" : ""}`}
            onClick={() => setPreset("#00F0FF", "Cyber Neon")}
            aria-label="Cyber neon lamp"
          >
            <span className="deck-lamp-dot" style={{ backgroundColor: "#00F0FF" }} aria-hidden="true" />
            <span className="deck-key-title">Cyber Neon</span>
            <span className="deck-key-sub">Vibrant</span>
          </button>

          <button
            type="button"
            className={`deck-key deck-key-lamp-toggle${esp.data?.power ? " is-on" : ""}${activeKey === "light_power" ? " is-active" : ""}`}
            onClick={togglePower}
            disabled={!esp.data}
            aria-label={esp.data?.power ? "Power off" : "Power on"}
          >
            <svg className="deck-media-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M13 3h-2v10h2zm4.83 2.17l-1.42 1.42A6.92 6.92 0 0 1 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.38 1.19-4.47 3-5.74L6.58 4.84A8.93 8.93 0 0 0 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83" />
            </svg>
            <span className="deck-key-title">{esp.data?.power ? "Lamp Off" : "Lamp On"}</span>
            <span className="deck-key-sub">{esp.data?.power ? "Turn Off" : "Turn On"}</span>
          </button>

          <button
            type="button"
            className="deck-key deck-key-palette"
            onClick={onOpenLights}
            aria-label="Light controls"
          >
            <svg className="deck-media-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9s1.5.67 1.5 1.5S7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
            </svg>
            <span className="deck-key-title">Palette</span>
            <span className="deck-key-sub">Controls</span>
          </button>
        </div>
      </div>
    </div>
  );
}
