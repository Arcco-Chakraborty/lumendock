import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeAdapter } from "../src/device.js";
import { fakeBridge, fakeClock } from "./helpers.js";
import status from "../../packages/protocol/fixtures/app-status.json";
import esp from "../../packages/protocol/fixtures/esp-link-ready.json";

describe("native transport", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("matches out-of-order IDs and ignores unknown replies", async () => {
    const b = fakeBridge(),
      a = createNativeAdapter(b.bridge, fakeClock());
    const first = a.request("app.status"),
      second = a.request("esp.state");
    b.reply("unknown", status);
    b.reply(b.sent[1]!.id, esp);
    b.reply(b.sent[0]!.id, status);
    expect(await first).toMatchObject({ paired: true });
    expect(await second).toMatchObject({ data: { temperatureC: 24.5 } });
    a.dispose();
  });
  it("rejects missing and unsupported bridges", async () => {
    await expect(
      createNativeAdapter(undefined, fakeClock()).request("app.status"),
    ).rejects.toMatchObject({ code: "BRIDGE_UNAVAILABLE" });
    await expect(
      createNativeAdapter({} as never, fakeClock()).request("app.status"),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_WEBVIEW" });
  });
  it("validates operation-specific replies and versions without settling another request", async () => {
    const b = fakeBridge(),
      a = createNativeAdapter(b.bridge, fakeClock());
    const first = a.request("app.status"),
      second = a.request("esp.state");
    const rejected = expect(first).rejects.toMatchObject({
      code: "BAD_PAYLOAD",
    });
    b.raw({ v: 2, id: b.sent[0]!.id, ok: true, data: status });
    await rejected;
    b.reply(b.sent[1]!.id, status);
    await expect(second).rejects.toMatchObject({ code: "BAD_PAYLOAD" });
    a.dispose();
  });
  it("validates args before dispatch", async () => {
    const b = fakeBridge(),
      a = createNativeAdapter(b.bridge, fakeClock());
    await expect(
      a.request("app.setBrightness", { value: 2 }),
    ).rejects.toMatchObject({ code: "BAD_PAYLOAD" });
    expect(b.sent).toHaveLength(0);
    a.dispose();
  });
  it("expires at ten seconds and a stale callback cannot resolve a later request", async () => {
    const b = fakeBridge(),
      a = createNativeAdapter(b.bridge, fakeClock());
    const expired = expect(a.request("app.status")).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(10000);
    await expired;
    const next = a.request("app.status");
    b.reply(b.sent[0]!.id, status);
    b.reply(b.sent[1]!.id, { ...status, paired: false });
    expect((await next).paired).toBe(false);
    a.dispose();
  });
  it("bounds pending work to sixteen and frees slots after responses", async () => {
    const b = fakeBridge(),
      a = createNativeAdapter(b.bridge, fakeClock());
    const requests = Array.from({ length: 16 }, () => a.request("app.status"));
    await expect(a.request("app.status")).rejects.toMatchObject({
      code: "QUEUE_FULL",
    });
    expect(b.sent).toHaveLength(16);
    b.sent.forEach((r) => b.reply(r.id, status));
    await Promise.all(requests);
    a.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects all work and removes its callback and timers on teardown", async () => {
    const b = fakeBridge(),
      a = createNativeAdapter(b.bridge, fakeClock());
    const pending = expect(a.request("hub.snapshot")).rejects.toMatchObject({
      code: "SESSION_ENDED",
    });
    a.dispose();
    a.dispose();
    await pending;
    expect(b.bridge.onmessage).toBe(null);
    expect(vi.getTimerCount()).toBe(0);
    await expect(a.request("app.status")).rejects.toMatchObject({
      code: "SESSION_ENDED",
    });
  });
  it("passes native typed failures through and catches synchronous send failures", async () => {
    const b = fakeBridge(),
      a = createNativeAdapter(b.bridge, fakeClock());
    const pending = a.request("app.status");
    b.raw({
      v: 1,
      id: b.sent[0]!.id,
      ok: false,
      error: { code: "SETUP_BUSY", retryable: false },
    });
    await expect(pending).rejects.toMatchObject({
      code: "SETUP_BUSY",
      retryable: false,
    });
    a.dispose();
    const throwing = createNativeAdapter(
      {
        postMessage: () => {
          throw Error("private detail");
        },
        onmessage: null,
      },
      fakeClock(),
    );
    await expect(throwing.request("app.status")).rejects.toMatchObject({
      code: "BRIDGE_UNAVAILABLE",
    });
    expect(vi.getTimerCount()).toBe(0);
    throwing.dispose();
  });
});
