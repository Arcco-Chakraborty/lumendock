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
