// Synthetic development fixtures; no account or device data.
import {
  EspSnapshotSchema,
  HubLinkSnapshotSchema,
  type EspSnapshot,
} from "@phone-monitor/protocol";
import type { HubLink } from "../store.js";
import hubJson from "../../../packages/protocol/fixtures/hub-host.json";
import espJson from "../../../packages/protocol/fixtures/esp-link-ready.json";
export function scenario(mode: string | null): {
  hub: HubLink;
  esp: EspSnapshot;
} {
  const hub = HubLinkSnapshotSchema.parse({
      state: "connected",
      ageMs: 0,
      stale: false,
      data: hubJson,
      errorCode: null,
    }),
    esp = EspSnapshotSchema.parse(espJson);
  const data = hub.data!;
  if (mode === "usb-offline" || mode === "stale") {
    hub.state = "disconnected";
    hub.stale = true;
    hub.ageMs = mode === "stale" ? 1_800_000 : 10000;
    hub.errorCode = "USB_UNAVAILABLE";
  }
  if (mode === "esp-offline") {
    esp.state = "disconnected";
    esp.stale = true;
    esp.ageMs = 15000;
    esp.errorCode = "WIFI_UNAVAILABLE";
  }
  if (mode === "loading") {
    hub.state = "connecting";
    hub.data = null;
    hub.ageMs = null;
    esp.state = "connecting";
    esp.data = null;
    esp.ageMs = null;
  }
  if (mode === "over-limit") {
    data.usage.codex.windows[0]!.usedPercent = 120;
    data.usage.codex.windows[0]!.label = "Synthetic custom bucket";
    data.usage.codex.windows[0]!.windowDurationMins = 45;
    data.usage.codex.windows[0]!.resetsAtEpochSec = 0;
    data.usage.claude.windows[0]!.usedPercent = 0;
  }
  if (mode === "capacity") {
    data.usage.codex.state = "unsupported";
    data.usage.codex.stale = true;
    data.usage.codex.errorCode = "SOURCE_CAPACITY_EXCEEDED";
  }
  if (mode === "missing") {
    data.usage.codex.windows = [];
    data.usage.claude.windows[0]!.usedPercent = null;
    data.usage.claude.windows[0]!.reportedAtEpochMs = null;
  }
  if (mode === "auth") {
    data.usage.codex.state = "auth_required";
    data.usage.codex.errorCode = "AUTH_REQUIRED";
    data.notifications.state = "disabled";
    data.notifications.items = [];
  }
  if (mode === "source-error") {
    data.usage.codex.state = "error";
    data.usage.codex.errorCode = "SOURCE_UNAVAILABLE";
    data.notifications.state = "unavailable";
    data.notifications.items = [];
  }
  if (mode === "sensor-failure") {
    esp.data!.sensorOk = false;
    esp.data!.temperatureC = null;
    esp.data!.humidityPercent = null;
  }
  if (mode === "hostile") {
    data.notifications.items[0]!.body = "<img src=x onerror=alert(1)>";
    data.notifications.items[0]!.title = "Synthetic markup";
  }
  return { hub, esp };
}
