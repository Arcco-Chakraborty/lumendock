import { useState, useSyncExternalStore } from "react";
import type { SetupState } from "@phone-monitor/protocol";
import type { DeviceAdapter } from "../device.js";
import { DeviceError } from "../device.js";
import type { DashboardStore } from "../store.js";
function setupMessage(name: string, value: SetupState) {
  if (value.state === "in_progress")
    return `${name}: Finish setup in the phone dialog. This display will update when it completes.`;
  if (value.state === "succeeded") return `${name} setup complete.`;
  if (value.state === "cancelled")
    return `${name} setup cancelled. You can start again.`;
  if (value.state === "failed")
    return value.errorCode === "PAIRING_EXPIRED"
      ? `${name} pairing expired. Open a new pairing window on the laptop and try again.`
      : `${name} setup failed. Check the connection and try again.`;
  return null;
}
export function SettingsSheet({
  store,
  adapter,
  nativeAvailable,
}: {
  store: DashboardStore;
  adapter?: DeviceAdapter | undefined;
  nativeAvailable: boolean;
}) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const app = snapshot.app;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof DeviceError && e.code === "SETUP_BUSY"
          ? "Another setup dialog is already open. Finish it on the phone."
          : "Could not complete this request. Check the connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const setupBusy =
    app?.setup.hub.state === "in_progress" ||
    app?.setup.esp.state === "in_progress";
  return (
    <>
      <h2>Connections &amp; display</h2>
      <p className="muted">
        Connect the laptop by USB and the controller over Wi-Fi. Enter pairing
        details only in the phone dialog.
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
          disabled={!nativeAvailable || busy || !adapter}
          onClick={() =>
            void run(() => adapter!.request("app.openWifiSettings"))
          }
        >
          Open Wi-Fi settings
        </button>
      </div>
      {app && (
        <>
          <div role="status">
            {(["hub", "esp"] as const).map((kind) => (
              <p key={kind}>
                {setupMessage(
                  kind === "hub" ? "Laptop" : "Controller",
                  app.setup[kind],
                )}
              </p>
            ))}
          </div>
          <label className="setting-toggle">
            <span>Keep screen on while open</span>
            <input
              type="checkbox"
              checked={app.screenOn}
              disabled={!nativeAvailable || busy}
              onChange={(event) =>
                void run(() =>
                  store.setDisplay("app.setScreenOn", {
                    enabled: event.target.checked,
                  }),
                )
              }
            />
          </label>
          <label className="control-row">
            Display brightness{" "}
            <output>{Math.round(app.brightness * 100)}%</output>
            <input
              aria-label="Display brightness"
              type="range"
              min="10"
              max="100"
              step="1"
              value={Math.round(app.brightness * 100)}
              disabled={!nativeAvailable || busy}
              onChange={(event) =>
                void run(() =>
                  store.setDisplay("app.setBrightness", {
                    value: Number(event.target.value) / 100,
                  }),
                )
              }
            />
          </label>
        </>
      )}
      {!app && <p role="status">Reading phone settings…</p>}
      {(error || snapshot.appError) && (
        <p role="alert">
          {error ?? "Phone settings unavailable. Reopen the app to retry."}
        </p>
      )}
    </>
  );
}
