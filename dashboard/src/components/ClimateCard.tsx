import { useMemo } from "react";
import type { EspHistory, EspSnapshot } from "@phone-monitor/protocol";
export function historyPath(
  values: Array<number | null>,
  intervalSeconds: number,
): string {
  const points = values.slice(-120),
    valid = points.filter((n): n is number => n !== null);
  if (!valid.length) return "";
  const low = Math.min(...valid),
    span = Math.max(1, Math.max(...valid) - low),
    duration = Math.max(intervalSeconds, (points.length - 1) * intervalSeconds);
  let pen = false;
  return points
    .map((v, i) => {
      if (v === null) {
        pen = false;
        return "";
      }
      const point = `${(((i * intervalSeconds) / duration) * 100).toFixed(2)},${(28 - ((v - low) / span) * 24).toFixed(2)}`;
      const d = `${pen ? "L" : "M"}${point}`;
      pen = true;
      return d;
    })
    .join(" ");
}
export function ClimateCard({
  snapshot,
  history,
  onHistory,
}: {
  snapshot: EspSnapshot;
  history?: EspHistory | null | undefined;
  onHistory?: () => void;
}) {
  const chartPath = useMemo(
    () =>
      history ? historyPath(history.temperatureC, history.intervalSeconds) : "",
    [history],
  );
  const spanMinutes = history
    ? (Math.max(0, Math.min(120, history.temperatureC.length) - 1) *
        history.intervalSeconds) /
      60
    : 0;
  const data = snapshot.data,
    ok = data?.sensorOk === true;
  return (
    <section className="climate-card" aria-label="Room conditions">
      <div className="card-heading">
        <h2>Room</h2>
        <span className="muted">
          {snapshot.stale && data
            ? "Last reading"
            : ok
              ? "Sensor ready"
              : "No reading"}
        </span>
      </div>
      <div className="temperature">
        {ok && data.temperatureC !== null ? data.temperatureC.toFixed(1) : "—"}
        <span>°C</span>
      </div>
      <div className="humidity">
        <strong>
          {ok && data.humidityPercent !== null
            ? `${Math.round(data.humidityPercent)}%`
            : "—"}
        </strong>
        <span className="muted">humidity</span>
      </div>
      {history && (
        <>
          <svg
            className="history-chart"
            viewBox="0 0 100 32"
            preserveAspectRatio="none"
            role="img"
            aria-label={`Temperature history, ${history.intervalSeconds} seconds between samples; gaps mean missing readings`}
          >
            <path d={chartPath} fill="none" stroke="#78d3d8" strokeWidth="1" />
          </svg>
          <p className="history-offsets muted">
            <span>{spanMinutes} minutes ago</span>
            <span>Latest sample</span>
          </p>
        </>
      )}
      <p className="muted room-note">
        {!data
          ? "Connect controller to see room conditions."
          : !ok
            ? "Sensor unavailable. Lighting still works."
            : snapshot.stale
              ? "Controller disconnected. Readings may be old."
              : "Temperature and humidity"}
      </p>
      {onHistory && (
        <button className="text-button" onClick={onHistory}>
          Room history
        </button>
      )}
    </section>
  );
}
