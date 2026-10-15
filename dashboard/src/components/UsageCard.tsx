import {
  LIMITS,
  type UsageSource,
  type UsageWindow,
} from "@phone-monitor/protocol";
import { countdown, durationWords, elapsedLabel, secondsUntilReset } from "../lib/time.js";
function Row({
  row,
  now,
  threshold,
  expanded,
}: {
  row: UsageWindow;
  now: number | null;
  threshold: number;
  expanded: boolean;
}) {
  const stale =
    row.reportedAtEpochMs === null ||
    now === null ||
    now - row.reportedAtEpochMs >= threshold;
  return (
    <div className="quota-row">
      {/* The percentage and window name share a line on Monitor and wrap when narrow. */}
      <div className="quota-headline">
        <div className="usage-value" aria-label={row.usedPercent === null ? "Unknown usage" : undefined}>
          {row.usedPercent === null
            ? "Unknown"
            : <><span className="usage-number">{row.usedPercent}%</span>{" "}<span className="usage-unit">used</span></>}
        </div>
        <div className="quota-label">
          <span className="quota-identity" title={row.label || row.windowId}>
            {row.label || row.windowId}
          </span>{" "}
          <span className="quota-duration muted" aria-label={row.windowDurationMins === null ? "Duration unknown" : durationWords(row.windowDurationMins)}>
            {row.windowDurationMins === null
              ? "Duration unknown"
              : expanded ? durationWords(row.windowDurationMins)
              : row.windowDurationMins % 1440 === 0 ? `${row.windowDurationMins / 1440}d`
              : row.windowDurationMins % 60 === 0 ? `${row.windowDurationMins / 60}h`
              : `${row.windowDurationMins}m`}
          </span>
        </div>
      </div>
      <svg
        className="quota-meter"
        viewBox="0 0 100 6"
        preserveAspectRatio="none"
        role="img"
        aria-label={
          row.usedPercent === null
            ? "Usage unknown"
            : `${row.usedPercent}% used`
        }
      >
        <rect className="quota-track" width="100" height="6" rx="1" />
        {row.usedPercent !== null && (
          <rect
            width={Math.max(0, Math.min(100, row.usedPercent))}
            height="6"
            rx="1"
            className={`quota-fill${row.usedPercent >= 90 ? " is-high" : ""}`}
          />
        )}
      </svg>
      <div className="quota-meta">
        <p className={stale ? "warning" : "muted"}>
          {countdown(
            now === null ? null : secondsUntilReset(row.resetsAtEpochSec, now),
          )}
        </p>
        <p className="muted">
          {stale ? "Stale, " : ""}
          {elapsedLabel(row.reportedAtEpochMs, now)}
        </p>
      </div>
    </div>
  );
}
export function UsageCard({
  source,
  laptopNowEpochMs,
  name,
  onDetails,
  expanded = false,
}: {
  source?: UsageSource | undefined;
  laptopNowEpochMs: number | null;
  name?: string;
  onDetails?: () => void;
  expanded?: boolean;
}) {
  const title = name ?? (source?.provider === "claude" ? "Claude" : "Codex");
  const threshold =
    source?.provider === "claude" ? LIMITS.claudeStaleMs : LIMITS.codexStaleMs;
  let guidance = "Connect laptop for usage";
  if (source) {
    guidance =
      source.errorCode === "SOURCE_CAPACITY_EXCEEDED"
        ? "Source capacity exceeded. Reduce reported buckets; last complete report retained."
        : source.provider === "claude" && source.state === "unsupported" && source.errorCode === "SOURCE_UNAVAILABLE"
          ? "Set up Claude capture on the laptop."
        : source.state === "auth_required"
          ? "Sign in to the provider on your laptop."
          : source.state === "unsupported"
            ? "Source format unsupported. Update the desktop collector."
            : source.state === "error"
              ? "Source unavailable. Check the desktop collector."
              : source.state === "awaiting_data"
                ? "Waiting for a report. Use your provider normally on the laptop."
                : source.stale
                  ? "Source report is stale"
                  : "Latest source read";
  }
  const rows = expanded ? source?.windows : source?.windows.slice(0, 1);
  const setupRequired = source?.provider === "claude" && source.state === "unsupported" && source.errorCode === "SOURCE_UNAVAILABLE";
  return (
    <section
      className={`usage-card usage-${title.toLowerCase()}${expanded ? " usage-expanded" : ""}${!rows?.length ? " has-no-windows" : ""}`}
      aria-label={`${title} usage`}
    >
      <div className="card-heading">
        <h2>
          {title}
        </h2>
        {source && (source.state !== "available" || source.stale) && (
          <span className="source-state warning">
            {source.errorCode === "SOURCE_CAPACITY_EXCEEDED"
              ? "Capacity error"
              : setupRequired
                ? "Setup needed"
              : source.state === "auth_required"
                ? "Sign in"
                : source.state === "unsupported"
                  ? "Unsupported"
                  : source.state === "error"
                    ? "Unavailable"
                    : source.state === "awaiting_data"
                      ? "Waiting"
                      : "Stale"}
          </span>
        )}
        {onDetails && (
          <button
            className="text-button"
            onClick={onDetails}
            aria-label={`All ${title} windows`}
          >
            {(source?.windows.length ?? 0) > 1 ? `View ${source!.windows.length}` : "Details"}
          </button>
        )}
      </div>
      {rows?.map((row) => (
        <Row
          key={`${row.bucketId}/${row.windowId}`}
          row={row}
          now={laptopNowEpochMs}
          threshold={threshold}
          expanded={expanded}
        />
      ))}
      {!rows?.length && <div className="quota-empty"><p className="empty-quota" aria-label="Unknown usage">{expanded ? "Unknown usage" : "Unknown"}</p><p className="muted">{guidance}</p></div>}
      <p className="source-note muted">
        {guidance}
        {source
          ? ` · ${elapsedLabel(source.lastSuccessAtEpochMs, laptopNowEpochMs)}`
          : ""}
      </p>
    </section>
  );
}
