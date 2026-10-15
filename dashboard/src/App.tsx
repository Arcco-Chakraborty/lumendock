import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { DeviceAdapter } from "./device.js";
import type { DashboardStore, DashboardSnapshot } from "./store.js";
import { UsageCard } from "./components/UsageCard.js";
import { ClimateCard } from "./components/ClimateCard.js";
import { LightCard } from "./components/LightCard.js";
import { NotificationStrip } from "./components/NotificationStrip.js";
import { SettingsSheet } from "./components/SettingsSheet.js";
import { LightIntentController } from "./lib/lightIntent.js";

export interface AppProps {
  store: DashboardStore;
  nativeAvailable: boolean;
  adapter?: DeviceAdapter;
  demo?: boolean;
  usageSlot?: ReactNode;
  climateSlot?: ReactNode;
  lightingSlot?: ReactNode;
  notificationSlot?: ReactNode;
  settingsSlot?: ReactNode;
}
function LinkStatus({
  name,
  link,
}: {
  name: string;
  link: DashboardSnapshot["hub"] | DashboardSnapshot["esp"];
}) {
  const connected = link.state === "connected" && !link.stale;
  const label =
    link.state === "connecting"
      ? "connecting"
      : connected
        ? "connected"
        : link.state === "connected"
          ? "stale"
          : "disconnected";
  return (
    <span
      className={`link-status ${connected ? "is-connected" : "is-offline"}`}
    >
      <span aria-hidden="true">{connected ? "●" : "○"}</span> {name} {label}
    </span>
  );
}
export function App({
  store,
  nativeAvailable,
  adapter,
  demo = false,
  usageSlot,
  climateSlot,
  lightingSlot,
  notificationSlot,
  settingsSlot,
}: AppProps) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  const [dismissed, setDismissed] = useState<string[]>([]);
  const dismiss = (id: string) =>
    setDismissed((previous) => [...previous.slice(-99), id]);
  const [sheet, setSheet] = useState<
    | "settings"
    | "notifications"
    | "lights"
    | "claude"
    | "codex"
    | "history"
    | null
  >(null);
  const controller = useMemo(
    () =>
      adapter
        ? new LightIntentController((patch, generation) =>
            adapter.request("esp.set", { patch, generation }),
          )
        : null,
    [adapter],
  );
  useEffect(() => () => controller?.dispose(), [controller]);
  useEffect(() => {
    if (snapshot.app?.webViewSupported !== false && snapshot.app)
      controller?.initialize(snapshot.app.nextCommandGeneration);
    controller?.applySnapshot(snapshot.esp);
  }, [controller, snapshot.app, snapshot.esp]);
  useEffect(() => {
    store.setHistoryOpen(sheet === "history");
    return () => store.setHistoryOpen(false);
  }, [store, sheet]);
  const dialog = useRef<HTMLDialogElement>(null),
    opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (sheet) {
      opener.current = document.activeElement as HTMLElement;
      dialog.current?.showModal();
    } else if (dialog.current?.open) {
      dialog.current.close();
      opener.current?.focus();
    }
  }, [sheet]);
  const clock =
    snapshot.laptopNowEpochMs === null
      ? "—:—"
      : new Date(snapshot.laptopNowEpochMs).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
  const notifications = snapshot.hub.data?.notifications;
  return (
    <main className="dashboard">
      <header className="topbar">
        <div className="identity">
          <span className="brand-mark" aria-hidden="true">
            ◈
          </span>
          <span>Desk monitor</span>
          {import.meta.env.DEV && demo && (
            <span className="demo-label">Synthetic demo</span>
          )}
        </div>
        <div className="connections">
          <LinkStatus name="Laptop" link={snapshot.hub} />
          <LinkStatus name="Controller" link={snapshot.esp} />
        </div>
        <time className="clock" aria-label="Laptop time">
          {clock}
        </time>
        <button
          className="settings-button"
          aria-label="Open settings"
          onClick={() => setSheet("settings")}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M4 7h16M4 17h16M9 3v8M15 13v8"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>
      {snapshot.app?.webViewSupported === false && (
        <p className="setup-banner">
          Update Android System WebView to connect this display.
        </p>
      )}
      {!nativeAvailable && !demo && (
        <p className="setup-banner">
          Open the Phone Monitor app to connect your laptop and room controller.
        </p>
      )}
      <div className="main-grid">
        <div className="usage-stack">
          {usageSlot ?? (
            <>
              <UsageCard
                name="Claude"
                source={snapshot.hub.data?.usage.claude}
                laptopNowEpochMs={snapshot.laptopNowEpochMs}
                onDetails={() => setSheet("claude")}
              />
              <UsageCard
                name="Codex"
                source={snapshot.hub.data?.usage.codex}
                laptopNowEpochMs={snapshot.laptopNowEpochMs}
                onDetails={() => setSheet("codex")}
              />
            </>
          )}
        </div>
        {climateSlot ?? (
          <ClimateCard
            snapshot={snapshot.esp}
            onHistory={() => setSheet("history")}
          />
        )}
        {lightingSlot ?? (
          <LightCard
            snapshot={snapshot.esp}
            controller={controller}
            onDetails={() => setSheet("lights")}
          />
        )}
      </div>
      <footer className="notification-strip">
        {notificationSlot ?? (
          <NotificationStrip
            dismissed={dismissed}
            onDismiss={dismiss}
            items={notifications?.items ?? []}
            laptopNowEpochMs={snapshot.laptopNowEpochMs}
            state={notifications?.state ?? "disabled"}
            onDetails={() => setSheet("notifications")}
          />
        )}
      </footer>
      <dialog
        ref={dialog}
        aria-labelledby="sheet-title"
        className="sheet"
        onCancel={() => setSheet(null)}
        onClose={() => {
          setSheet(null);
          opener.current?.focus();
        }}
      >
        <div className="sheet-header">
          <span id="sheet-title">
            {sheet === "settings"
              ? "Settings"
              : sheet === "lights"
                ? "Lighting"
                : sheet === "history"
                  ? "Room history"
                  : sheet === "claude" || sheet === "codex"
                    ? "Usage windows"
                    : "Notifications"}
          </span>
          <button aria-label="Close sheet" onClick={() => setSheet(null)}>
            Close
          </button>
        </div>
        {sheet === "settings" ? (
          <>
            <SettingsSheet
              store={store}
              adapter={adapter}
              nativeAvailable={
                (nativeAvailable || demo) &&
                snapshot.app?.webViewSupported !== false
              }
            />
            {settingsSlot}
          </>
        ) : sheet === "lights" ? (
          <LightCard snapshot={snapshot.esp} controller={controller} expanded />
        ) : sheet === "claude" || sheet === "codex" ? (
          <UsageCard
            name={sheet === "claude" ? "Claude" : "Codex"}
            source={snapshot.hub.data?.usage[sheet]}
            laptopNowEpochMs={snapshot.laptopNowEpochMs}
            expanded
          />
        ) : sheet === "history" ? (
          <>
            <ClimateCard
              snapshot={snapshot.esp}
              history={snapshot.history?.data}
            />
            <p className="muted">
              {snapshot.history?.stale
                ? "Last history; readings may be old."
                : "Recent temperature trend. Missing readings leave gaps."}
            </p>
            {snapshot.history?.errorCode && (
              <p role="status">
                Room history unavailable. Lighting remains independent.
              </p>
            )}
          </>
        ) : (
          <>
            <h2>Selected notifications</h2>
            <p>
              Choose allowed laptop apps during desktop setup. Notifications
              expire after 30 minutes. Hiding an item affects only this display.
            </p>
            <NotificationStrip
              dismissed={dismissed}
              onDismiss={dismiss}
              items={notifications?.items ?? []}
              laptopNowEpochMs={snapshot.laptopNowEpochMs}
              state={notifications?.state ?? "disabled"}
              expanded
            />
          </>
        )}
      </dialog>
    </main>
  );
}
