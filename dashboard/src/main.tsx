import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import {
  createNativeAdapter,
  systemClock,
  type NativeBridge,
  type DeviceAdapter,
} from "./device.js";
import { DashboardStore } from "./store.js";
import "./styles.css";

declare global {
  interface Window {
    phoneMonitor?: NativeBridge;
  }
}
async function bootstrap() {
  let adapter: DeviceAdapter;
  let demo = false;
  const nativeAvailable =
    typeof window.phoneMonitor?.postMessage === "function";
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("demo")) {
    const [
      { createMockAdapter },
      { HubLinkSnapshotSchema, EspSnapshotSchema, AppStatusSchema },
      hub,
      esp,
      app,
    ] = await Promise.all([
      import("./mocks/device.js"),
      import("@phone-monitor/protocol"),
      import("../../packages/protocol/fixtures/hub-ready.json"),
      import("../../packages/protocol/fixtures/esp-link-ready.json"),
      import("../../packages/protocol/fixtures/app-status.json"),
    ]);
    const mode = new URLSearchParams(location.search).get("demo");
    const hubLink = HubLinkSnapshotSchema.parse({
      state: mode === "usb-offline" ? "disconnected" : "connected",
      ageMs: mode === "usb-offline" ? 10000 : 0,
      stale: mode === "usb-offline",
      data: hub.default,
      errorCode: mode === "usb-offline" ? "USB_UNAVAILABLE" : null,
    });
    const espLink = EspSnapshotSchema.parse({
      ...esp.default,
      ...(mode === "esp-offline"
        ? {
            state: "disconnected",
            ageMs: 15000,
            stale: true,
            errorCode: "WIFI_UNAVAILABLE",
          }
        : {}),
    });
    adapter = createMockAdapter({
      "hub.snapshot": hubLink,
      "esp.state": espLink,
      "app.status": AppStatusSchema.parse(app.default),
    });
    demo = true;
  } else adapter = createNativeAdapter(window.phoneMonitor, systemClock);
  const store = new DashboardStore(systemClock);
  store.start(adapter, !document.hidden);
  const visibility = () => store.setVisible(!document.hidden);
  document.addEventListener("visibilitychange", visibility);
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <App
      store={store}
      adapter={adapter}
      nativeAvailable={nativeAvailable}
      demo={demo}
    />,
  );
  const dispose = () => {
    document.removeEventListener("visibilitychange", visibility);
    store.dispose();
    root.unmount();
  };
  window.addEventListener("pagehide", dispose, { once: true });
  if (import.meta.hot)
    import.meta.hot.dispose(() => {
      window.removeEventListener("pagehide", dispose);
      dispose();
    });
}
void bootstrap();
