import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockAdapter } from "../src/mocks/device.js";
import { fakeClock } from "./helpers.js";
import { AppStatusSchema } from "@phone-monitor/protocol";
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
