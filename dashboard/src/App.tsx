import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { DeviceAdapter } from "./device.js";
import type { DashboardStore, DashboardSnapshot } from "./store.js";
import type { UsageSource } from "@phone-monitor/protocol";

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
function UsagePlaceholder({
  name,
  source,
}: {
  name: string;
  source: UsageSource | undefined;
}) {
  const window = source?.windows[0];
  return (
    <section className="usage-card" aria-label={`${name} usage`}>
      <div className="card-heading">
        <h2>{name}</h2>
        <span className="muted">Subscription</span>
      </div>
      <div className="usage-value">
        {window?.usedPercent === null || window?.usedPercent === undefined
          ? "—"
          : `${Math.round(window.usedPercent)}%`}
        <span> used</span>
      </div>
      <p className="muted">
        {source
          ? source.stale
            ? "Last report is stale"
            : source.state === "available"
              ? "Latest report"
              : "Waiting for a report"
          : "Connect laptop for usage"}
      </p>
    </section>
  );
}
function Climate({ snapshot }: { snapshot: DashboardSnapshot }) {
  const data = snapshot.esp.data,
    ok = data?.sensorOk === true;
  return (
    <section className="climate-card" aria-labelledby="room-title">
      <div className="card-heading">
        <h2 id="room-title">Room</h2>
        <span className="muted">
          {snapshot.esp.stale && data
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
        <svg
          width="20"
          height="24"
          viewBox="0 0 20 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M10 2C8 6 3 11 3 15a7 7 0 0 0 14 0c0-4-5-9-7-13Z"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
        <strong>
          {ok && data.humidityPercent !== null
            ? `${Math.round(data.humidityPercent)}%`
            : "—"}
        </strong>
        <span className="muted">humidity</span>
      </div>
      <p className="muted room-note">
        {!data
          ? "Connect controller to see room conditions."
          : !ok
            ? "Sensor unavailable. Lighting still works."
            : snapshot.esp.stale
              ? "Controller disconnected. Readings may be old."
              : "Temperature and humidity"}
      </p>
    </section>
  );
}
function Lighting({ snapshot }: { snapshot: DashboardSnapshot }) {
  const data = snapshot.esp.data;
  return (
    <section className="lighting-card" aria-labelledby="light-title">
      <div className="card-heading">
        <h2 id="light-title">Lighting</h2>
        <span className="muted">
          {data
            ? snapshot.esp.stale
              ? "Last state"
              : "Confirmed"
            : "Not connected"}
        </span>
      </div>
      <svg
        className="light-symbol"
        width="52"
        height="52"
        viewBox="0 0 52 52"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M19 35c0-5-6-7-6-16a13 13 0 0 1 26 0c0 9-6 11-6 16M19 35h14M21 41h10M23 46h6"
          stroke={data?.hex ?? "currentColor"}
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      <div className="light-reading">
        {data ? (data.power ? "On" : "Off") : "—"}
      </div>
      <p className="muted">
        {data ? `${data.bright}% brightness` : "Connect controller for lights"}
      </p>
    </section>
  );
}
function Settings({
  store,
  adapter,
  nativeAvailable,
  children,
}: {
  store: DashboardStore;
  adapter: DeviceAdapter | undefined;
  nativeAvailable: boolean;
  children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch {
      setError("Could not complete setup. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const setupBusy =
    snapshot.app?.setup.hub.state === "in_progress" ||
    snapshot.app?.setup.esp.state === "in_progress";
  return (
    <>
      <h2>Connections &amp; display</h2>
      <p className="muted">
        Connect the laptop by USB and the controller over Wi-Fi.
      </p>
      <div className="settings-actions">
        <button
          disabled={!nativeAvailable || busy || setupBusy}
          onClick={() => void run(() => store.setup("app.setupHub"))}
        >
          Pair laptop
        </button>
        <button
          disabled={!nativeAvailable || busy || setupBusy}
          onClick={() => void run(() => store.setup("app.connectEsp"))}
        >
          Connect controller
        </button>
        <button
          disabled={!nativeAvailable || busy}
          onClick={() =>
            void run(() => adapter!.request("app.openWifiSettings"))
          }
        >
          Open Wi-Fi settings
        </button>
      </div>
      {setupBusy && <p role="status">Finish setup in the phone dialog.</p>}
      {snapshot.app && (
        <label className="setting-toggle">
          <span>Keep screen on while open</span>
          <input
            type="checkbox"
            checked={snapshot.app.screenOn}
            disabled={!nativeAvailable || busy}
            onChange={(event) => {
              const enabled = event.target.checked;
              void run(async () => {
                await adapter!.request("app.setScreenOn", { enabled });
                store.applyAppStatus({ ...snapshot.app!, screenOn: enabled });
              });
            }}
          />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      {children}
    </>
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
  const [sheet, setSheet] = useState<"settings" | "notifications" | null>(null);
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
              <UsagePlaceholder
                name="Claude"
                source={snapshot.hub.data?.usage.claude}
              />
              <UsagePlaceholder
                name="Codex"
                source={snapshot.hub.data?.usage.codex}
              />
            </>
          )}
        </div>
        {climateSlot ?? <Climate snapshot={snapshot} />}
        {lightingSlot ?? <Lighting snapshot={snapshot} />}
      </div>
      <footer className="notification-strip">
        {notificationSlot ?? (
          <>
            <span className="notification-icon" aria-hidden="true">
              ♧
            </span>
            <span>
              {notifications?.state === "available"
                ? "Selected laptop notifications"
                : notifications?.state === "unavailable"
                  ? "Laptop notifications unavailable"
                  : "Notifications are off"}
            </span>
            <button onClick={() => setSheet("notifications")}>Details</button>
          </>
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
          <span id="sheet-title">{sheet === "settings" ? "Settings" : "Notifications"}</span>
          <button aria-label="Close sheet" onClick={() => setSheet(null)}>
            Close
          </button>
        </div>
        {sheet === "settings" ? (
          <Settings
            store={store}
            adapter={adapter}
            nativeAvailable={
              nativeAvailable && snapshot.app?.webViewSupported !== false
            }
          >
            {settingsSlot}
          </Settings>
        ) : (
          <>
            <h2>Selected notifications</h2>
            <p>
              Choose allowed laptop apps during desktop setup. Notifications
              stay on this display only until they expire.
            </p>
          </>
        )}
      </dialog>
    </main>
  );
}
