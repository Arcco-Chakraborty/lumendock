import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardStore } from "../src/store.js";
import { createNativeAdapter } from "../src/device.js";
import { fakeBridge, fakeClock, flush } from "./helpers.js";
import {
  AppStatusSchema,
  EspSnapshotSchema,
  HubLinkSnapshotSchema,
} from "@phone-monitor/protocol";
import statusJson from "../../packages/protocol/fixtures/app-status.json";
import espJson from "../../packages/protocol/fixtures/esp-link-ready.json";
import hubJson from "../../packages/protocol/fixtures/hub-ready.json";
const status = AppStatusSchema.parse(statusJson),
  esp = EspSnapshotSchema.parse(espJson);
const hub = HubLinkSnapshotSchema.parse({
  state: "connected",
  ageMs: 0,
  stale: false,
  data: hubJson,
  errorCode: null,
});
describe("independent dashboard lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("retains controller data when the laptop fails and laptop data when ESP fails", () => {
    const s = new DashboardStore(fakeClock());
    s.applyEsp(esp);
    s.applyHub(hub);
    s.applyHub({
      state: "disconnected",
      ageMs: null,
      stale: true,
      data: null,
      errorCode: "USB_UNAVAILABLE",
    });
    expect(s.snapshot().esp.data?.temperatureC).toBe(24.5);
    expect(s.snapshot().hub.state).toBe("disconnected");
    expect(s.snapshot().hub.data).not.toBe(null);
    s.applyEsp({
      ...esp,
      state: "disconnected",
      data: null,
      ageMs: null,
      stale: true,
      errorCode: "WIFI_UNAVAILABLE",
    });
    expect(s.snapshot().esp.data?.temperatureC).toBe(24.5);
    expect(s.snapshot().hub.data?.serverNowEpochMs).toBe(
      hubJson.serverNowEpochMs,
    );
    s.dispose();
  });
  it("anchors cached time to payload age and advances without rewinding on repeated failed polls", () => {
    const s = new DashboardStore(fakeClock());
    s.applyHub({ ...hub, ageMs: 5000 });
    expect(s.estimatedLaptopNow()).toBe(hubJson.serverNowEpochMs + 5000);
    vi.advanceTimersByTime(4000);
    expect(s.estimatedLaptopNow()).toBe(hubJson.serverNowEpochMs + 9000);
    s.applyHub({ ...hub, state: "disconnected", ageMs: 6000, stale: true });
    expect(s.estimatedLaptopNow()).toBe(hubJson.serverNowEpochMs + 9000);
    expect(s.snapshot().hub.stale).toBe(true);
    s.dispose();
  });
  it("keeps the render snapshot stable within a displayed second", () => {
    const s = new DashboardStore(fakeClock());
    s.applyHub(hub);
    const first = s.snapshot();
    vi.advanceTimersByTime(10);
    expect(s.snapshot()).toBe(first);
    vi.advanceTimersByTime(990);
    expect(s.snapshot()).not.toBe(first);
    s.dispose();
  });
  it("does not invent laptop time before the first sample and ages both links independently", () => {
    const s = new DashboardStore(fakeClock());
    expect(s.estimatedLaptopNow()).toBe(null);
    s.applyHub(hub);
    s.applyEsp(esp);
    vi.advanceTimersByTime(6000);
    expect(s.snapshot().hub.stale).toBe(true);
    expect(s.snapshot().esp.stale).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(s.snapshot().esp.stale).toBe(true);
    s.dispose();
  });
  it("never overlaps source reads, pauses when hidden, and reads fresh on resume", async () => {
    const b = fakeBridge(),
      s = new DashboardStore(fakeClock());
    s.start(createNativeAdapter(b.bridge, fakeClock()));
    expect(b.sent.map((r) => r.op)).toEqual([
      "app.status",
      "hub.snapshot",
      "esp.state",
    ]);
    await vi.advanceTimersByTimeAsync(7000);
    expect(b.sent).toHaveLength(3);
    b.sent.forEach((r) =>
      b.reply(
        r.id,
        r.op === "app.status" ? status : r.op === "hub.snapshot" ? hub : esp,
      ),
    );
    await flush();
    s.setVisible(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(b.sent).toHaveLength(3);
    s.setVisible(true);
    expect(b.sent.slice(3).map((r) => r.op)).toEqual([
      "hub.snapshot",
      "esp.state",
    ]);
    s.dispose();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("polls hub each two seconds and ESP each three with independent failures", async () => {
    const b = fakeBridge(),
      s = new DashboardStore(fakeClock());
    s.start(createNativeAdapter(b.bridge, fakeClock()));
    b.sent.forEach((r) =>
      b.reply(
        r.id,
        r.op === "app.status" ? status : r.op === "hub.snapshot" ? hub : esp,
      ),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(b.sent.slice(3).map((r) => r.op)).toEqual(["hub.snapshot"]);
    const request = b.sent.at(-1)!;
    b.raw({
      v: 1,
      id: request.id,
      ok: false,
      error: { code: "USB_UNAVAILABLE", retryable: true },
    });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.sent.at(-1)?.op).toBe("esp.state");
    expect(s.snapshot().hub.state).toBe("disconnected");
    expect(s.snapshot().esp.data?.temperatureC).toBe(24.5);
    s.dispose();
    await flush();
  });
  it("recomputes provider staleness and expires notices while laptop is disconnected", () => {
    const s = new DashboardStore(fakeClock());
    s.applyHub(hub);
    s.applyHub({
      state: "disconnected",
      ageMs: null,
      stale: true,
      data: null,
      errorCode: "USB_UNAVAILABLE",
    });
    vi.advanceTimersByTime(120000);
    expect(s.snapshot().hub.data?.usage.codex.stale).toBe(true);
    expect(s.snapshot().hub.data?.usage.claude.stale).toBe(false);
    vi.advanceTimersByTime(180000);
    expect(s.snapshot().hub.data?.usage.claude.stale).toBe(true);
    vi.advanceTimersByTime(1500000);
    expect(s.snapshot().hub.data?.notifications.items).toHaveLength(0);
    s.dispose();
  });
  it("rechecks status after setup acknowledgment even if an older status read is outstanding", async () => {
    const b = fakeBridge(),
      s = new DashboardStore(fakeClock());
    s.start(createNativeAdapter(b.bridge, fakeClock()));
    const setup = s.setup("app.setupHub");
    b.reply(b.sent.at(-1)!.id, { setupId: "synthetic-race", started: true });
    await setup;
    b.reply(b.sent[0]!.id, status);
    await flush();
    expect(b.sent.filter((r) => r.op === "app.status")).toHaveLength(2);
    s.dispose();
    await flush();
  });
  it("polls status only during setup and never interprets setup acknowledgment as success", async () => {
    const b = fakeBridge(),
      s = new DashboardStore(fakeClock());
    s.start(createNativeAdapter(b.bridge, fakeClock()));
    const progress = {
      ...status,
      paired: false,
      setup: {
        ...status.setup,
        hub: {
          setupId: "synthetic-flow",
          state: "in_progress",
          errorCode: null,
        },
      },
    };
    b.reply(b.sent[0]!.id, progress);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(b.sent.filter((r) => r.op === "app.status")).toHaveLength(2);
    b.reply(b.sent.at(-1)!.id, { ...status, paired: false });
    await flush();
    await vi.advanceTimersByTimeAsync(6000);
    expect(b.sent.filter((r) => r.op === "app.status")).toHaveLength(2);
    const setup = s.setup("app.setupHub");
    const req = b.sent.at(-1)!;
    b.reply(req.id, { setupId: "synthetic-next", started: true });
    await setup;
    expect(s.snapshot().app?.paired).toBe(false);
    expect(b.sent.at(-1)?.op).toBe("app.status");
    s.dispose();
    await flush();
  });
});
