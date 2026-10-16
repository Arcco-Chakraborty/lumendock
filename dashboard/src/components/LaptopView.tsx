import type { HostVitals } from "@phone-monitor/protocol";

/** Recent samples for the sparklines, oldest first. */
export interface VitalsHistory { cpuLoad: number[]; gpuLoad: number[] }
export const HISTORY_SAMPLES = 90;

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
const percentOf = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : 0);
/** Amber from 75 °C, red from 85 °C: the usual laptop throttling range. */
const heat = (celsius: number | null) => (celsius === null ? "" : celsius >= 85 ? " is-hot" : celsius >= 75 ? " is-warm" : "");
const duration = (minutes: number) => {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours ? `${hours} h ${rest} min` : `${rest} min`;
};

function Readout({ label, value, unit, className = "" }: { label: string; value: string; unit?: string; className?: string }) {
  return (
    <div className={`vital-readout${className}`}>
      <span className="vital-label">{label}</span>
      <span className="vital-value">{value}{unit && <span className="vital-unit">{unit}</span>}</span>
    </div>
  );
}

/** Load history drawn across the full width, so it is readable from the first few reports. */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  const step = values.length > 1 ? 100 / (values.length - 1) : 0;
  const points = values.map((v, i) => `${(i * step).toFixed(2)},${(30 - (Math.min(100, Math.max(0, v)) / 100) * 28).toFixed(2)}`).join(" ");
  return (
    <div className="vital-chart">
      <span className="vital-chart-caption" aria-hidden="true">Load, last 3 min</span>
      {values.length > 1 ? (
        <svg className="vital-spark" viewBox="0 0 100 31" preserveAspectRatio="none" role="img" aria-label={label}>
          <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : <div className="vital-spark is-empty" aria-hidden="true" />}
    </div>
  );
}

function Meter({ percent, label }: { percent: number; label: string }) {
  return (
    <svg className="vital-meter" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label={label}>
      <rect className="quota-track" width="100" height="6" rx="1" />
      <rect className={`quota-fill${percent >= 90 ? " is-high" : ""}`} width={Math.max(0, Math.min(100, percent))} height="6" rx="1" />
    </svg>
  );
}

export function LaptopView({ connected, vitals, history }: { connected: boolean; vitals: HostVitals | null | undefined; history: VitalsHistory }) {
  if (!connected || !vitals) {
    return (
      <div className="laptop-container is-empty" id="laptop-panel" role="tabpanel" aria-labelledby="laptop-tab">
        <p className="laptop-empty">
          {connected ? "Reading the laptop's sensors…" : "Connect the laptop to see its CPU, GPU, memory and power."}
        </p>
      </div>
    );
  }
  const { cpu, gpu, igpu, memory, power, storageTempC } = vitals;
  const busiest = cpu?.threadUsage.length ? Math.round(Math.max(...cpu.threadUsage)) : null;
  return (
    <div className="laptop-container" id="laptop-panel" role="tabpanel" aria-labelledby="laptop-tab">
      <section className="vital-panel vital-cpu" aria-label="Processor">
        <header className="vital-heading"><h2>CPU</h2><span className="vital-name">{cpu?.name ?? "Not reported"}</span></header>
        <div className="vital-pair">
          <Readout label="Load" value={cpu?.usagePercent == null ? "…" : String(Math.round(cpu.usagePercent))} unit="%" />
          <Readout label="Temperature" value={cpu?.tempC == null ? "n/a" : String(Math.round(cpu.tempC))} unit={cpu?.tempC == null ? "" : "°C"} className={heat(cpu?.tempC ?? null)} />
        </div>
        {cpu && cpu.threadUsage.length > 0 && (
          <div className="thread-bars" role="img" aria-label={`Load on each of ${cpu.threadUsage.length} threads, busiest ${busiest}%`}>
            {cpu.threadUsage.map((load, i) => (
              <svg key={i} className="thread-bar" viewBox="0 0 4 30" preserveAspectRatio="none" aria-hidden="true">
                <rect className="thread-track" width="4" height="30" />
                <rect className="thread-fill" y={30 - (load / 100) * 30} width="4" height={(load / 100) * 30} />
              </svg>
            ))}
          </div>
        )}
        <Sparkline values={history.cpuLoad} label="CPU load over the last three minutes" />
        <p className="vital-meta">
          {cpu?.clockMhz != null && <span>{(cpu.clockMhz / 1000).toFixed(1)} GHz</span>}
          {cpu?.powerW != null && <span>{cpu.powerW.toFixed(1)} W package</span>}
        </p>
      </section>

      <section className="vital-panel vital-gpu" aria-label="Graphics">
        <header className="vital-heading"><h2>GPU</h2><span className="vital-name">{gpu?.name ?? "Integrated graphics"}</span></header>
        {gpu && gpu.state === "asleep" ? (
          <div className="vital-asleep">
            <span className="vital-value">Asleep</span>
            <span className="muted">Saving power. Wakes when an app uses it.</span>
          </div>
        ) : gpu ? (
          <>
            <div className="vital-pair">
              <Readout label="Load" value={gpu.usagePercent == null ? "Idle" : String(Math.round(gpu.usagePercent))} unit={gpu.usagePercent == null ? "" : "%"} />
              <Readout label="Temperature" value={gpu.tempC == null ? "n/a" : String(Math.round(gpu.tempC))} unit={gpu.tempC == null ? "" : "°C"} className={heat(gpu.tempC)} />
            </div>
            <Sparkline values={history.gpuLoad} label="GPU load over the last three minutes" />
            <dl className="vital-rows">
              <div><dt>Hotspot</dt><dd className={gpu.hotspotC == null ? "muted" : heat(gpu.hotspotC).trim()}>{gpu.hotspotC == null ? "not reported by driver" : `${Math.round(gpu.hotspotC)}°C`}</dd></div>
              {gpu.powerW != null && <div><dt>Power</dt><dd>{gpu.powerW.toFixed(1)} W</dd></div>}
              {gpu.memoryUsedMb != null && gpu.memoryTotalMb != null && <div><dt>Memory</dt><dd>{(gpu.memoryUsedMb / 1024).toFixed(1)} of {(gpu.memoryTotalMb / 1024).toFixed(1)} GB</dd></div>}
              {gpu.clockMhz != null && <div><dt>Clock</dt><dd>{gpu.clockMhz} MHz</dd></div>}
            </dl>
          </>
        ) : null}
        {igpu && (
          <p className="vital-meta vital-igpu">
            <span>Integrated</span>
            {igpu.usagePercent != null && <span>{Math.round(igpu.usagePercent)}% load</span>}
            {igpu.tempC != null && <span className={heat(igpu.tempC).trim()}>{Math.round(igpu.tempC)}°C</span>}
          </p>
        )}
      </section>

      <div className="vital-stack">
        <section className="vital-panel vital-memory" aria-label="Memory">
          <header className="vital-heading"><h2>Memory</h2>{memory && <span className="vital-name">{gb(memory.totalBytes)} GB</span>}</header>
          {memory ? (
            <>
              <Readout label="Used" value={String(percentOf(memory.usedBytes, memory.totalBytes))} unit="%" />
              <Meter percent={percentOf(memory.usedBytes, memory.totalBytes)} label={`${gb(memory.usedBytes)} of ${gb(memory.totalBytes)} GB in use`} />
              <p className="vital-meta">
                <span>{gb(memory.usedBytes)} of {gb(memory.totalBytes)} GB</span>
                {memory.swapTotalBytes > 0 && <span>Swap {gb(memory.swapUsedBytes)} GB</span>}
              </p>
            </>
          ) : <p className="muted">Not reported</p>}
        </section>
        <section className="vital-panel vital-power" aria-label="Power">
          <header className="vital-heading">
            <h2>Power</h2>
            <span className="vital-name">{power?.source === "ac" ? "Plugged in" : power?.source === "battery" ? "On battery" : "Unknown"}</span>
          </header>
          <div className="vital-pair">
            <Readout label="Battery" value={power?.batteryPercent == null ? "n/a" : String(Math.round(power.batteryPercent))} unit={power?.batteryPercent == null ? "" : "%"} />
            {power?.watts != null && <Readout label={power.charging ? "Charging" : "Draw"} value={power.watts.toFixed(1)} unit="W" />}
          </div>
          <p className="vital-meta">
            {power?.minutesLeft != null && <span>{power.charging ? `Full in ${duration(power.minutesLeft)}` : `${duration(power.minutesLeft)} left`}</span>}
            {power?.source === "ac" && power.watts == null && <span>{power.batteryPercent === 100 ? "Battery full" : "Not charging"}</span>}
            {storageTempC != null && <span className={heat(storageTempC).trim()}>SSD {Math.round(storageTempC)}°C</span>}
          </p>
        </section>
      </div>
    </div>
  );
}
