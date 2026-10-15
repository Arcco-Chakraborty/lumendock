import { useState, useSyncExternalStore } from "react";
import type { EspSnapshot, LightPatch } from "@phone-monitor/protocol";
import type {
  LightIntentController,
  IntentSnapshot,
} from "../lib/lightIntent.js";
const modes = [
  "Solid",
  "Breathe",
  "Rainbow",
  "Jump",
  "Strobe",
  "Candle",
  "Aurora",
  "Party",
  "Thermo",
];
const presets = [
  ["Warm", "#FFAA55"],
  ["White", "#FFFFFF"],
  ["Red", "#FF4040"],
  ["Green", "#44CC77"],
  ["Blue", "#4477FF"],
  ["Violet", "#BB55FF"],
] as const;
const empty: IntentSnapshot = {
  desired: null,
  confirmed: null,
  stateOutcome: null,
  timerOutcome: null,
  queued: 0,
  ready: false,
};
const noop = () => () => {};
const getEmpty = () => empty;
export function LightCard({
  controller,
  snapshot,
  expanded = false,
  onDetails,
}: {
  controller: LightIntentController | null;
  snapshot: EspSnapshot;
  expanded?: boolean;
  onDetails?: () => void;
}) {
  const intent = useSyncExternalStore(
    controller?.subscribe ?? noop,
    controller?.snapshot ?? getEmpty,
    controller?.snapshot ?? getEmpty,
  );
  const data = intent.desired ?? snapshot.data;
  const confirmed = intent.confirmed ?? snapshot.data;
  const [hex, setHex] = useState(""),
    [timer, setTimer] = useState("30"),
    [error, setError] = useState<string | null>(null);
  const send = (patch: LightPatch, release = true) => {
    setError(null);
    void controller
      ?.change(patch)
      .catch(() =>
        setError(
          "Action was not queued. Check the connection or wait for pending controls, then try again.",
        ),
      );
    if (release) controller?.release();
  };
  const ready = intent.ready;
  const marker =
    intent.stateOutcome === "pending"
      ? "Pending"
      : intent.stateOutcome === "unconfirmed"
        ? "Unconfirmed"
        : intent.stateOutcome === "cancelled" ||
            intent.stateOutcome === "superseded"
          ? "Not sent"
          : snapshot.stale && data
            ? "Last state"
            : data
              ? "Confirmed"
              : "Not connected";
  return (
    <section
      className={expanded ? "light-controls" : "lighting-card"}
      aria-label="Lighting"
    >
      <div className="card-heading">
        <h2>Lighting</h2>
        <span
          className={marker === "Unconfirmed" ? "warning" : "muted"}
          role="status"
        >
          {marker}
        </span>
      </div>
      <button
        className={`power-button${!data ? " is-unknown" : ""}${data?.power ? " is-on" : ""}`}
        disabled={!ready || !data}
        aria-label={data?.power ? "Power off" : "Power on"}
        aria-pressed={data?.power ?? false}
        style={data?.power ? { borderColor: `${data.hex}cc`, boxShadow: `0 0 18px ${data.hex}55`, textShadow: `0 0 12px ${data.hex}` } : undefined}
        onClick={() => data && send({ power: !data.power })}
      >
        {data ? (data.power ? "On" : "Off") : "Unknown"}
      </button>
      {data && (
        <span
          className={`light-color-chip${data.power ? " is-illuminated" : ""}`}
          style={{
            backgroundColor: data.hex,
            boxShadow: data.power
              ? `0 0 18px ${data.hex}, 0 0 32px ${data.hex}66, inset 0 0 4px rgba(255,255,255,0.7)`
              : "none",
          }}
          title={`Color: ${data.hex}`}
          aria-hidden="true"
        />
      )}
      {!expanded && data && (
        <div className="dock-presets" role="group" aria-label="Quick colors">
          {presets.slice(0, 4).map(([name, value]) => {
            const active = data.hex.toUpperCase() === value.toUpperCase();
            return (
              <button
                key={name}
                type="button"
                tabIndex={-1}
                className={`dock-preset-button${active ? " is-active" : ""}`}
                disabled={!ready}
                aria-label={`Quick color ${name}`}
                onClick={() => send({ hex: value })}
              >
                <span
                  className="dock-preset-dot"
                  style={{
                    backgroundColor: value,
                    boxShadow: active ? `0 0 12px ${value}, 0 0 2px #fff` : `0 0 4px ${value}44`,
                  }}
                />
              </button>
            );
          })}
        </div>
      )}
      <p className="muted light-summary">
        {data
          ? `${data.bright}% · ${modes[data.mode]}`
          : "Connect controller"}
      </p>
      {!expanded && (confirmed && confirmed.timerSeconds > 0 || intent.timerOutcome === "unconfirmed" || intent.timerOutcome === "pending") && (
        <p
          className={
            intent.timerOutcome === "unconfirmed"
              ? "light-timer warning"
              : "light-timer muted"
          }
        >
          {intent.timerOutcome === "unconfirmed"
            ? "Timer uncertain"
            : intent.timerOutcome === "pending"
              ? "Timer pending"
              : `${Math.ceil(confirmed!.timerSeconds / 60)}m timer`}
        </p>
      )}
      {expanded && (intent.stateOutcome === "unconfirmed" ||
        intent.stateOutcome === "cancelled" ||
        intent.stateOutcome === "superseded") && (
        <>
          <p className="warning">
            The last change was not confirmed by the controller. Showing the
            last confirmed light state.
          </p>
          <button
            disabled={!ready}
            onClick={() => {
              void controller
                ?.retry()
                .catch(() => setError("Retry could not be queued."));
              controller?.release();
            }}
          >
            Retry light change
          </button>
        </>
      )}
      {onDetails && (
        <button className="text-button" onClick={onDetails}>
          Light controls
        </button>
      )}
      {expanded && (
        <>
          <label className="control-row">
            Brightness <output>{data?.bright ?? "Unknown"}%</output>
            <input
              aria-label="Light brightness"
              type="range"
              min="1"
              max="100"
              value={data?.bright ?? 50}
              disabled={!ready}
              onChange={(e) => send({ bright: Number(e.target.value) }, false)}
              onPointerUp={() => controller?.release()}
              onKeyUp={() => controller?.release()}
            />
          </label>
          <div className="presets" aria-label="RGB presets">
            {presets.map(([name, value]) => (
              <button
                key={name}
                disabled={!ready}
                style={{ borderColor: `${value}66`, boxShadow: `0 0 10px ${value}22` }}
                onClick={() => send({ hex: value })}
              >
                <svg width="14" height="14" aria-hidden="true">
                  <circle cx="7" cy="7" r="6" fill={value} />
                </svg>
                {name}
              </button>
            ))}
          </div>
          <form
            className="hex-control"
            onSubmit={(e) => {
              e.preventDefault();
              if (/^#[0-9a-fA-F]{6}$/.test(hex))
                send({ hex: hex.toUpperCase() });
              else setError("Enter # followed by six RGB hex digits.");
            }}
          >
            <label>
              Custom RGB hex
              <input
                type="text"
                maxLength={7}
                placeholder={data?.hex ?? "#RRGGBB"}
                value={hex}
                onChange={(e) => setHex(e.target.value)}
                disabled={!ready}
              />
            </label>
            <button disabled={!ready}>Apply colour</button>
          </form>
          <label className="control-row">
            Mode
            <select
              aria-label="Light mode"
              value={data?.mode ?? 0}
              disabled={!ready}
              onChange={(e) => send({ mode: Number(e.target.value) })}
            >
              {modes.map((name, index) => (
                <option key={name} value={index}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {data?.mode === 8 && !data.sensorOk && (
            <p className="warning">
              Thermo selected; temperature sensor is unavailable.
            </p>
          )}
          <label className="control-row">
            Speed <output>{data?.speed ?? "Unknown"}%</output>
            <input
              type="range"
              aria-label="Light speed"
              min="1"
              max="100"
              value={data?.speed ?? 50}
              disabled={!ready}
              onChange={(e) => send({ speed: Number(e.target.value) }, false)}
              onPointerUp={() => controller?.release()}
              onKeyUp={() => controller?.release()}
            />
          </label>
          <form
            className="timer-control"
            onSubmit={(e) => {
              e.preventDefault();
              const minutes = Number(timer);
              if (Number.isInteger(minutes) && minutes >= 0 && minutes <= 720)
                send({ timerMinutes: minutes });
              else setError("Choose 0–720 whole minutes.");
            }}
          >
            <label>
              Sleep timer (minutes)
              <input
                type="number"
                min="0"
                max="720"
                step="1"
                value={timer}
                disabled={!ready}
                onChange={(e) => setTimer(e.target.value)}
              />
            </label>
            <button disabled={!ready}>Set timer</button>
            <button
              type="button"
              disabled={!ready}
              onClick={() => send({ timerMinutes: 0 })}
            >
              Cancel timer
            </button>
          </form>
          <p className="muted">
            Confirmed remaining:{" "}
            {confirmed
              ? `${Math.ceil(confirmed.timerSeconds / 60)} minutes`
              : "Unknown"}
            . Timer: {intent.timerOutcome ?? "no command"}. Uncertain timers are
            never retried automatically.
          </p>
          <p className="muted">
            Desired: {data?.hex ?? "Unknown"} · Confirmed: {confirmed?.hex ?? "Unknown"}
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
