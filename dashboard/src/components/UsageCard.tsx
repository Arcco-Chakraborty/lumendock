import {
  LIMITS,
  type UsageSource,
  type UsageWindow,
} from "@phone-monitor/protocol";
import { countdown, elapsedLabel, secondsUntilReset } from "../lib/time.js";
function Row({
  row,
  now,
  threshold,
}: {
  row: UsageWindow;
  now: number | null;
  threshold: number;
}) {
  const stale =
    row.reportedAtEpochMs === null ||
    now === null ||
    now - row.reportedAtEpochMs >= threshold;
  return (
    <div className="quota-row">
      <div className="quota-label">
        <span className="quota-identity" title={row.label || row.windowId}>
          {row.label || row.windowId}
        </span>{" "}
        <span className="quota-duration muted">
          {row.windowDurationMins === null
            ? "Duration unknown"
            : `${row.windowDurationMins} minutes`}
        </span>
      </div>
      <div className="usage-value">
        {row.usedPercent === null
          ? "Unknown usage"
          : `${row.usedPercent}% used`}
      </div>
      <svg
        className="quota-meter"
        viewBox="0 0 100 3"
        preserveAspectRatio="none"
        role="img"
        aria-label={
          row.usedPercent === null
            ? "Usage unknown"
            : `${row.usedPercent}% used`
        }
      >
        <rect width="100" height="3" fill="#344148" />
        {row.usedPercent !== null && (
          <rect
            width={Math.max(0, Math.min(100, row.usedPercent))}
            height="3"
            fill="#e8b66e"
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
          {stale ? "Stale · " : ""}
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
  return (
    <section
      className={`usage-card${expanded ? " usage-expanded" : ""}`}
      aria-label={`${title} usage`}
    >
      <div className="card-heading">
        <h2>{title}</h2>
        {source && (source.state !== "available" || source.stale) && (
          <span className="source-state warning">
            {source.errorCode === "SOURCE_CAPACITY_EXCEEDED"
              ? "Capacity error"
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
            Windows {source?.windows.length ?? 0}
          </button>
        )}
      </div>
      {rows?.map((row) => (
        <Row
          key={`${row.bucketId}/${row.windowId}`}
          row={row}
          now={laptopNowEpochMs}
          threshold={threshold}
        />
      ))}
      {!rows?.length && <p className="empty-quota">Unknown usage</p>}
      <p className="source-note muted">
        {guidance}
        {source
          ? ` · ${elapsedLabel(source.lastSuccessAtEpochMs, laptopNowEpochMs)}`
          : ""}
      </p>
    </section>
  );
}
