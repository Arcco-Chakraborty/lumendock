import { LightCard } from "../src/components/LightCard.js";
import { SettingsSheet } from "../src/components/SettingsSheet.js";
import { DashboardStore } from "../src/store.js";
import { AppStatusSchema } from "@phone-monitor/protocol";
import statusJson from "../../packages/protocol/fixtures/app-status.json";
import { expect, it } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { UsageCard } from "../src/components/UsageCard.js";
import { ClimateCard, historyPath } from "../src/components/ClimateCard.js";
import { NotificationStrip } from "../src/components/NotificationStrip.js";
import type { UsageSource } from "@phone-monitor/protocol";
import { EspSnapshotSchema } from "@phone-monitor/protocol";
import esp from "../../packages/protocol/fixtures/esp-link-ready.json";
const usage = (usedPercent: number | null): UsageSource => ({
  provider: "codex",
  source: "codex_app_server",
  state: "available",
  observedAtEpochMs: 2000,
  lastSuccessAtEpochMs: 2000,
  stale: false,
  errorCode: null,
  windows: [
    {
      bucketId: "synthetic-bucket",
      windowId: "primary",
      label: "Synthetic 45 minute bucket",
      usedPercent,
      windowDurationMins: 45,
      resetsAtEpochSec: 1,
      reportedAtEpochMs: 0,
    },
  ],
});
it("retains zero fractional above limit and unknown usage with due reset", () => {
  for (const value of [0, 2.5, 120]) {
    const html = render(
      <UsageCard source={usage(value)} laptopNowEpochMs={2000} />,
    );
    expect(html.replace(/<[^>]*>/g, "")).toContain(`${value}% used`);
    expect(html).toContain("Reset due");
    expect(html).toContain("45 minutes");
    expect(html).toContain("Synthetic 45 minute bucket");
  }
  expect(
    render(<UsageCard source={usage(null)} laptopNowEpochMs={null} />),
  ).toContain("Unknown usage");
});
it("keeps old per-row report age and explains capacity/missing/auth states", () => {
  const source = usage(87);
  source.provider = "claude";
  source.source = "claude_statusline";
  source.windows[0]!.reportedAtEpochMs = 1000;
  source.lastSuccessAtEpochMs = 900000;
  expect(
    render(<UsageCard source={source} laptopNowEpochMs={901000} />),
  ).toContain("15m ago");
  source.errorCode = "SOURCE_CAPACITY_EXCEEDED";
  source.state = "unsupported";
  expect(
    render(<UsageCard source={source} laptopNowEpochMs={901000} />),
  ).toContain("capacity");
  source.errorCode = null;
  source.state = "auth_required";
  source.windows = [];
  expect(
    render(<UsageCard source={source} laptopNowEpochMs={null} />),
  ).toContain("Sign in");
});
it("escapes notification markup and excludes locally expired items", () => {
  const item = {
    id: "synthetic",
    appId: "Synthetic app",
    title: "Synthetic event",
    body: "<img src=x onerror=alert(1)>",
    receivedAtEpochMs: 0,
    expiresAtEpochMs: 1800000,
  };
  const html = render(
    <NotificationStrip items={[item]} laptopNowEpochMs={1000} />,
  );
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
  expect(
    render(<NotificationStrip items={[item]} laptopNowEpochMs={1800000} />),
  ).not.toContain("Synthetic event");
});
it("sensor failure leaves lighting independent and history uses gaps/relative offsets", () => {
  const snapshot = EspSnapshotSchema.parse(esp);
  snapshot.data!.sensorOk = false;
  const html = render(<ClimateCard snapshot={snapshot} />);
  expect(html).toContain("Lighting still works");
  // Design: sensor failure with HTTP working keeps the last values, labelled as old.
  expect(html).toContain("Sensor failed · last reading");
  expect(html).toContain(snapshot.data!.temperatureC!.toFixed(1));
  const path = historyPath([20, null, 22, 23], 60);
  expect(path.match(/M/g)).toHaveLength(2);
  expect(path).not.toContain("NaN");
});
it("provides explicit power nine modes and complete light controls", () => {
  const html = render(
    <LightCard
      controller={null}
      snapshot={EspSnapshotSchema.parse(esp)}
      expanded
    />,
  );
  for (const label of [
    "Power",
    "Brightness",
    "Speed",
    "Sleep timer",
    "Solid",
    "Breathe",
    "Rainbow",
    "Jump",
    "Strobe",
    "Candle",
    "Aurora",
    "Party",
    "Thermo",
    "Custom RGB hex",
  ])
    expect(html).toContain(label);
});
it("setup state explains cancellation expiry and long native progress independently of acknowledgment", () => {
  const store = new DashboardStore();
  const status = AppStatusSchema.parse(statusJson);
  store.applyAppStatus({
    ...status,
    setup: {
      ...status.setup,
      hub: { setupId: "synthetic", state: "in_progress", errorCode: null },
    },
  });
  expect(render(<SettingsSheet store={store} nativeAvailable />)).toContain(
    "Finish setup in the phone dialog",
  );
  store.applyAppStatus({
    ...status,
    setup: {
      ...status.setup,
      hub: { setupId: "synthetic", state: "cancelled", errorCode: null },
    },
  });
  expect(render(<SettingsSheet store={store} nativeAvailable />)).toContain(
    "cancelled",
  );
  store.applyAppStatus({
    ...status,
    setup: {
      ...status.setup,
      hub: {
        setupId: "synthetic",
        state: "failed",
        errorCode: "PAIRING_EXPIRED",
      },
    },
  });
  expect(render(<SettingsSheet store={store} nativeAvailable />)).toContain(
    "expired",
  );
  store.dispose();
});
it("shares local dismissal between strip and detail without exposing notification actions", () => {
  const item = {
    id: "synthetic-hidden",
    appId: "Synthetic app",
    title: "Hidden event",
    body: "Synthetic body",
    receivedAtEpochMs: 0,
    expiresAtEpochMs: 1800000,
  };
  expect(
    render(
      <NotificationStrip
        items={[item]}
        laptopNowEpochMs={1000}
        dismissed={["synthetic-hidden"]}
      />,
    ),
  ).not.toContain("Hidden event");
});
it("shows relative history span and bounds plotted points to the latest 120", () => {
  const history = {
    intervalSeconds: 60,
    temperatureC: [20, null, 22],
    humidityPercent: [40, null, 50],
  };
  expect(
    render(
      <ClimateCard snapshot={EspSnapshotSchema.parse(esp)} history={history} />,
    ),
  ).toContain("2 minutes ago");
  expect(
    historyPath(
      Array.from({ length: 200 }, (_, i) => i),
      60,
    ).match(/[ML]/g),
  ).toHaveLength(120);
});
it("distinguishes missing Claude setup from an installed source waiting for data", () => {
  const source = usage(null);
  source.provider = "claude";
  source.source = "claude_statusline";
  source.state = "unsupported";
  source.errorCode = "SOURCE_UNAVAILABLE";
  source.windows = [];
  const missing = render(<UsageCard name="Claude" source={source} laptopNowEpochMs={null} />);
  expect(missing).toContain("Set up Claude capture on the laptop.");
  expect(missing).not.toContain("Update the desktop collector");
  source.state = "awaiting_data";
  source.errorCode = null;
  const quiet = render(<UsageCard name="Claude" source={source} laptopNowEpochMs={null} />);
  expect(quiet).toContain("Waiting for a report");
  expect(quiet).not.toContain("Set up Claude capture on the laptop.");
});
it("keeps a quiet Claude reading until its reset, then shows the window as reset", () => {
  const hour = 3_600_000;
  const source = usage(64);
  source.provider = "claude";
  source.source = "claude_usage_api";
  source.windows[0]!.reportedAtEpochMs = 10 * hour;
  source.windows[0]!.resetsAtEpochSec = (13 * hour) / 1000;
  source.lastSuccessAtEpochMs = 10 * hour;
  const quiet = render(<UsageCard name="Claude" source={source} laptopNowEpochMs={12 * hour} />);
  expect(quiet.replace(/<[^>]*>/g, "")).toContain("64% used");
  expect(quiet).not.toContain("Stale");
  const rolled = render(<UsageCard name="Claude" source={source} laptopNowEpochMs={13 * hour + 25 * 60_000} />).replace(/<[^>]*>/g, "");
  expect(rolled).toContain("Reset 25m ago, no use reported since");
  expect(rolled).not.toContain("64%");
  source.state = "auth_required";
  source.windows = [];
  expect(render(<UsageCard name="Claude" source={source} laptopNowEpochMs={null} />)).toContain("Open Claude Code on the laptop to renew it.");
});
it("names only the selected notification sources in setup guidance", () => {
  const html = render(<NotificationStrip items={[]} laptopNowEpochMs={null} state="disabled" />);
  expect(html).toContain("Claude, Codex and WhatsApp");
});
it("shows colour and confirmed timer status in the compact light summary", () => {
  const snapshot = EspSnapshotSchema.parse(esp);
  snapshot.data!.timerSeconds = 300;
  const html = render(<LightCard controller={null} snapshot={snapshot} />);
  expect(html).toContain(snapshot.data!.hex);
  expect(html).toContain("5m timer");
  expect(html).not.toContain('class="light-symbol"');
});
