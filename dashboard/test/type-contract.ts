import type { DeviceAdapter } from "../src/device.js";
// Compile-only public API checks; this function is never called.
export function checkAdapterTypes(adapter: DeviceAdapter) {
  const status = adapter.request("app.status");
  const paired: Promise<boolean> = status.then((value) => value.paired);
  void paired;
  adapter.request("app.setBrightness", { value: 0.5 });
  // @ts-expect-error Required operation args cannot be omitted.
  adapter.request("app.setBrightness");
  // @ts-expect-error Arguments are specific to their operation.
  adapter.request("app.setScreenOn", { value: 0.5 });
  // @ts-expect-error No unknown operations.
  adapter.request("network.fetch");
  // @ts-expect-error Empty-argument operations reject excess keys.
  adapter.request("app.status", { token: "synthetic-never-accepted" });
}

export function checkCalendarArgs(adapter: DeviceAdapter) {
  adapter.request('hub.calendarSources');
  adapter.request('hub.calendar', {startDate:'2026-10-21',days:7,timeZone:'UTC'});
  adapter.request('hub.calendarSelect', {sourceIds:[],expectedRevision:'synthetic_revision'});
  // @ts-expect-error Calendar reads require their range.
  adapter.request('hub.calendar');
  // @ts-expect-error Selection requires an expected revision.
  adapter.request('hub.calendarSelect');
  // @ts-expect-error Source enumeration is operation-specific.
  adapter.request('hub.calendarSources', {sourceIds:[]});
}
