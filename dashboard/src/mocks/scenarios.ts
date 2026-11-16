// Synthetic development fixtures; no account or device data.
import {
  CalendarLinkSnapshotSchema,
  CalendarSourcesLinkSnapshotSchema,
  EspSnapshotSchema,
  HubLinkSnapshotSchema,
  type CalendarPage,
  type CalendarSourcesPage,
  type ErrorCode,
  type EspSnapshot,
  type LinkSnapshot,
} from "@phone-monitor/protocol";
import type { HubLink } from "../store.js";
import hubJson from "../../../packages/protocol/fixtures/hub-host.json";
import espJson from "../../../packages/protocol/fixtures/esp-link-ready.json";
import calendarPageJson from "../../../packages/protocol/fixtures/calendar-page.json";
import calendarSourcesJson from "../../../packages/protocol/fixtures/calendar-sources.json";

export type CalendarLink = LinkSnapshot<CalendarPage>;
export type CalendarSourcesLink = LinkSnapshot<CalendarSourcesPage>;

export function scenario(mode: string | null): {
  hub: HubLink;
  esp: EspSnapshot;
  calendar: CalendarLink;
  calendarSources: CalendarSourcesLink;
  calendarError: ErrorCode | null;
} {
  const hub = HubLinkSnapshotSchema.parse({
      state: "connected",
      ageMs: 0,
      stale: false,
      data: hubJson,
      errorCode: null,
    }),
    esp = EspSnapshotSchema.parse(espJson),
    calendar = CalendarLinkSnapshotSchema.parse({
      state: "connected",
      ageMs: 0,
      stale: false,
      data: calendarPageJson,
      errorCode: null,
    }),
    calendarSources = CalendarSourcesLinkSnapshotSchema.parse({
      state: "connected",
      ageMs: 0,
      stale: false,
      data: calendarSourcesJson,
      errorCode: null,
    });
  const data = hub.data!;
  const calData = calendar.data!;
  const srcData = calendarSources.data!;
  let calendarError: ErrorCode | null = null;

  if (mode === "usb-offline" || mode === "stale") {
    hub.state = "disconnected";
    hub.stale = true;
    hub.ageMs = mode === "stale" ? 1_800_000 : 10000;
    hub.errorCode = "USB_UNAVAILABLE";
    calendar.state = "disconnected";
    calendar.stale = true;
    calendar.ageMs = mode === "stale" ? 1_800_000 : 10000;
    calendar.errorCode = "USB_UNAVAILABLE";
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
    calData.state = "loading";
    calData.items = [];
    calData.nextEvent = null;
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
    calData.state = "capacity";
    calData.errorCode = "CALENDAR_CAPACITY";
    srcData.state = "capacity";
    srcData.errorCode = "CALENDAR_CAPACITY";
  }
  if (mode === "missing") {
    data.usage.codex.windows = [];
    data.usage.claude.windows[0]!.usedPercent = null;
    data.usage.claude.windows[0]!.reportedAtEpochMs = null;
    calData.state = "disabled";
    calData.items = [];
    calData.nextEvent = null;
  }
  if (mode === "auth" || mode === "auth_required") {
    data.usage.codex.state = "auth_required";
    data.usage.codex.errorCode = "AUTH_REQUIRED";
    data.notifications.state = "disabled";
    data.notifications.items = [];
    calData.state = "auth_required";
    calData.errorCode = "CALENDAR_AUTH_REQUIRED";
    calData.items = [];
    calData.nextEvent = null;
  }
  if (mode === "setup_required" || mode === "setup-required") {
    calData.state = "setup_required";
    calData.items = [];
    calData.nextEvent = null;
    srcData.state = "setup_required";
    srcData.nextCursor = null;
  }
  if (mode === "partial") {
    calData.state = "partial";
    calData.errorCode = "CALENDAR_UNAVAILABLE";
    calData.sourceCount = 2;
    calData.failedSourceCount = 1;
  }
  if (mode === "calendar-unsupported" || mode === "CALENDAR_UNSUPPORTED") {
    calendarError = "CALENDAR_UNSUPPORTED";
  }
  if (mode === "source-error") {
    data.usage.codex.state = "error";
    data.usage.codex.errorCode = "SOURCE_UNAVAILABLE";
    data.notifications.state = "unavailable";
    data.notifications.items = [];
    calData.state = "error";
    calData.errorCode = "CALENDAR_UNAVAILABLE";
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
  return { hub, esp, calendar, calendarSources, calendarError };
}
