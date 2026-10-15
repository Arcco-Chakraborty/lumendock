import { scenario } from "../src/mocks/scenarios.js";
import { HubLinkSnapshotSchema } from "@phone-monitor/protocol";
import { EspSnapshotSchema, AppStatusSchema } from "@phone-monitor/protocol";
import espJson from "../../packages/protocol/fixtures/esp-link-ready.json";
import statusJson from "../../packages/protocol/fixtures/app-status.json";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockAdapter } from "../src/mocks/device.js";
import { fakeClock } from "./helpers.js";
import status from "../../packages/protocol/fixtures/app-status.json";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it("uses validated asynchronous native-shaped replies and tears down scheduled fixture work", async () => {
  const a = createMockAdapter(
    { "app.status": AppStatusSchema.parse(status) },
    fakeClock(),
  );
  const pending = a.request("app.status");
  await vi.advanceTimersByTimeAsync(0);
  expect((await pending).paired).toBe(true);
  const missing = expect(a.request("esp.state")).rejects.toMatchObject({
    code: "SOURCE_UNAVAILABLE",
  });
  await vi.advanceTimersByTimeAsync(0);
  await missing;
  const closed = expect(a.request("app.status")).rejects.toMatchObject({
    code: "SESSION_ENDED",
  });
  a.dispose();
  await closed;
  expect(vi.getTimerCount()).toBe(0);
});
it("synthetic controls acknowledge typed generations without hardware", async () => {
  vi.useFakeTimers();
  const fixtures = {
    "esp.state": EspSnapshotSchema.parse(espJson),
    "app.status": AppStatusSchema.parse(statusJson),
  };
  const adapter = createMockAdapter(fixtures, fakeClock());
  const pending = adapter.request("esp.set", {
    patch: { bright: 23 },
    generation: 50,
  });
  void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  const reply = await pending;
  expect(reply.generation).toBe(50);
  expect(reply.state?.bright).toBe(23);
  expect(fixtures["esp.state"].commands.state?.generation).toBe(50);
  adapter.dispose();
  vi.useRealTimers();
});
it("offers isolated loading stale over-limit capacity missing auth sensor and hostile synthetic cases", () => {
  for (const mode of [
    "loading",
    "stale",
    "over-limit",
    "capacity",
    "missing",
    "auth",
    "sensor-failure",
    "hostile",
    "source-error",
  ]) {
    const { hub, esp } = scenario(mode);
    expect(() => HubLinkSnapshotSchema.parse(hub)).not.toThrow();
    expect(() => EspSnapshotSchema.parse(esp)).not.toThrow();
    if (mode === "over-limit")
      expect(hub.data?.usage.codex.windows[0]?.usedPercent).toBe(120);
    if (mode === "capacity")
      expect(hub.data?.usage.codex.errorCode).toBe("SOURCE_CAPACITY_EXCEEDED");
    if (mode === "sensor-failure") expect(esp.data?.sensorOk).toBe(false);
  }
});
