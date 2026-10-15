import { useState } from "react";
import type { SelectedNotification } from "@phone-monitor/protocol";
import { elapsedLabel } from "../lib/time.js";
export function NotificationStrip({
  items,
  laptopNowEpochMs,
  state = "available",
  expanded = false,
  onDetails,
  dismissed: controlledDismissed,
  onDismiss,
}: {
  items: SelectedNotification[];
  laptopNowEpochMs: number | null;
  state?: "available" | "disabled" | "unavailable";
  expanded?: boolean;
  onDetails?: () => void;
  dismissed?: string[];
  onDismiss?: (id: string) => void;
}) {
  const [localDismissed, setDismissed] = useState<string[]>([]);
  const dismissed = controlledDismissed ?? localDismissed;
  const visible = items.filter(
    (item) =>
      !dismissed.includes(item.id) &&
      (laptopNowEpochMs === null || item.expiresAtEpochMs > laptopNowEpochMs),
  );
  const shown = expanded ? visible : visible.slice(-1);
  return (
    <>
      <div className={expanded ? "notification-list" : "notification-preview"}>
        {shown.length ? (
          shown.map((item) => (
            <article key={item.id}>
              <span className="notification-source">
                {item.appId} ·{" "}
                {elapsedLabel(item.receivedAtEpochMs, laptopNowEpochMs)}
              </span>
              <strong>{item.title}</strong>
              {item.body && <p>{item.body}</p>}
              {expanded && (
                <button
                  onClick={() =>
                    onDismiss
                      ? onDismiss(item.id)
                      : setDismissed((previous) => [
                          ...previous.slice(-99),
                          item.id,
                        ])
                  }
                >
                  Hide on this display
                </button>
              )}
            </article>
          ))
        ) : (
          <span>
            {state === "disabled"
              ? "Notifications are off. Choose allowed apps on the laptop."
              : state === "unavailable"
                ? "Laptop notifications unavailable. Check desktop capture permission."
                : "No selected notifications"}
          </span>
        )}
      </div>
      {onDetails && (
        <button onClick={onDetails}>
          Details{visible.length ? ` (${visible.length})` : ""}
        </button>
      )}
    </>
  );
}
