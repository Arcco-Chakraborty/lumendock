import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/App.js";
import { DashboardStore } from "../src/store.js";
import { fakeClock } from "./helpers.js";
import {
  EspSnapshotSchema,
  HubLinkSnapshotSchema,
} from "@phone-monitor/protocol";
import esp from "../../packages/protocol/fixtures/esp-link-ready.json";
import hub from "../../packages/protocol/fixtures/hub-ready.json";
it("explains absent connections and supplies independent room and usage slots", () => {
  const store = new DashboardStore(fakeClock());
  const empty = renderToStaticMarkup(
    <App store={store} nativeAvailable={false} />,
  );
  expect(empty).toContain("Open the LumenDock app");
  expect(empty).toContain("Laptop disconnected");
  expect(empty).toContain("Controller disconnected");
  store.applyEsp(EspSnapshotSchema.parse(esp));
  const room = renderToStaticMarkup(<App store={store} nativeAvailable />);
  expect(room).toContain("24.5");
  expect(room).toContain("Controller connected");
  expect(room).toContain("Laptop disconnected");
  store.applyHub(
    HubLinkSnapshotSchema.parse({
      state: "connected",
      ageMs: 0,
      stale: false,
      data: hub,
      errorCode: null,
    }),
  );
  const linked = renderToStaticMarkup(
    <App
      store={store}
      nativeAvailable
      usageSlot={<p>Custom usage</p>}
      lightingSlot={<p>Custom lights</p>}
      notificationSlot={<p>Custom notifications</p>}
    />,
  );
  expect(linked).toContain("Custom usage");
  expect(linked).toContain("Custom lights");
  expect(linked).toContain("Custom notifications");
  expect(linked).not.toContain("style=");
  store.dispose();
});
it("explains an unsupported phone software version before presenting setup", () => {
  const store = new DashboardStore(fakeClock());
  store.applyAppStatus({
    paired: false,
    webViewSupported: false,
    wifiMode: "none",
    setup: {
      hub: { setupId: null, state: "idle", errorCode: null },
      esp: { setupId: null, state: "idle", errorCode: null },
    },
    screenOn: false,
    brightness: 0.5,
    nextCommandGeneration: 1,
  });
  expect(renderToStaticMarkup(<App store={store} nativeAvailable />)).toContain(
    "Update Android System WebView",
  );
  store.dispose();
});
it("shows a useful local clock and date without a laptop time sample", () => {
  const store = new DashboardStore(fakeClock());
  const html = renderToStaticMarkup(<App store={store} nativeAvailable />);
  expect(html).toContain('aria-label="Local time"');
  expect(html).toContain('class="local-date"');
  expect(html).not.toContain("—:—");
  expect(html.indexOf('class="clock-room"')).toBeLessThan(html.indexOf('class="usage-alerts"'));
  expect(html).not.toContain('class="lighting-dock"');
  store.dispose();
});
