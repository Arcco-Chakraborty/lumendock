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
    ok = data?.sensorOk === true,
    // Design: when the sensor fails but HTTP works, keep the firmware's last values, labelled as old.
    sensorFailed = data !== null && !ok;
  return (
    <section className="climate-card" aria-label="Room conditions">
      <div className="card-heading">
        <h2>Room</h2>
        <span className="muted">
          {sensorFailed
            ? "Sensor failed · last reading"
            : snapshot.stale && data
              ? "Last reading"
              : ok
                ? "Sensor ready"
                : "No reading"}
        </span>
      </div>
      {data ? (
        <>
          <div className={`temperature${sensorFailed ? " is-old" : ""}${data.temperatureC == null ? " is-unknown" : ""}`}>
            {data.temperatureC !== null ? (
              <>
                {data.temperatureC.toFixed(1)}
                <span>°C</span>
              </>
            ) : (
              "Unknown"
            )}
          </div>
          <div className="humidity">
            <strong className={data.humidityPercent == null ? "is-unknown" : undefined}>
              {data.humidityPercent !== null
                ? `${Math.round(data.humidityPercent)}%`
                : "Unknown"}
            </strong>
            <span className="muted">humidity</span>
          </div>
        </>
      ) : null}
      {history && (
        <>
          <svg
            className="history-chart"
            viewBox="0 0 100 32"
            preserveAspectRatio="none"
            role="img"
            aria-label={`Temperature history, ${history.intervalSeconds} seconds between samples; gaps mean missing readings`}
          >
            <path d={chartPath} fill="none" stroke="#d5b97b" strokeWidth="1" />
          </svg>
          <p className="history-offsets muted">
            <span>
              {spanMinutes} {spanMinutes === 1 ? "minute" : "minutes"} ago
            </span>
            <span>Latest sample</span>
          </p>
        </>
      )}
      {(!data || !ok || snapshot.stale) && <p className="muted room-note">
        {!data
          ? "Connect controller to see room conditions."
          : !ok
            ? "Sensor unavailable. Lighting still works."
            : snapshot.stale
              ? "Readings may be old."
              : "Temperature and humidity"}
      </p>}
      {onHistory && (
        <button className="text-button" aria-label="Room history" onClick={onHistory}>
          History
        </button>
      )}
    </section>
  );
}
