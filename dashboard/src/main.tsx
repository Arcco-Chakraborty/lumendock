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
    const [{ createMockAdapter }, { scenario }, { AppStatusSchema }, app] =
      await Promise.all([
        import("./mocks/device.js"),
        import("./mocks/scenarios.js"),
        import("@phone-monitor/protocol"),
        import("../../packages/protocol/fixtures/app-status.json"),
      ]);
    const { hub, esp } = scenario(
      new URLSearchParams(location.search).get("demo"),
    );
    adapter = createMockAdapter({
      "hub.snapshot": hub,
      "esp.state": esp,
      "esp.history": {
        state: "connected",
        ageMs: 0,
        stale: false,
        errorCode: null,
        data: {
          intervalSeconds: 60,
          temperatureC: [23, 23.2, null, 23.4, 24, 24.5],
          humidityPercent: [53, 54, null, 54, 55, 55],
        },
      },
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
