import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type {
  CommandResult,
  EspSnapshot,
  LightPatch,
} from "@phone-monitor/protocol";
import { EspSnapshotSchema } from "@phone-monitor/protocol";
import esp from "../../packages/protocol/fixtures/esp-link-ready.json";
import { LightIntentController } from "../src/lib/lightIntent.js";
import { fakeClock } from "./helpers.js";
const sample = () => EspSnapshotSchema.parse(esp);
let writes: Array<{
  patch: LightPatch;
  generation: number;
  resolve: (value: CommandResult) => void;
}>;
function make(floor = 10) {
  const c = new LightIntentController(
    (patch, generation) =>
      new Promise((resolve) => writes.push({ patch, generation, resolve })),
    fakeClock(),
  );
  c.initialize(floor);
  c.applySnapshot(sample());
  return c;
}
const outcome = (
  generation: number,
  outcome: CommandResult["outcome"] = "confirmed",
  kind: CommandResult["kind"] = "state",
): CommandResult => ({
  generation,
  kind,
  outcome,
  state: sample().data,
  errorCode: outcome === "unconfirmed" ? "COMMAND_UNCONFIRMED" : null,
});
beforeEach(() => {
  vi.useFakeTimers();
  writes = [];
});
afterEach(() => vi.useRealTimers());
it("merges touched fields while one bridge write waits and releases final value", async () => {
  const c = make();
  void c.change({ bright: 20 });
  c.release();
  void c.change({ hex: "#FFFFFF" });
  void c.change({ speed: 42 });
  void c.change({ bright: 77 });
  c.release();
  expect(writes).toHaveLength(1);
  expect(c.snapshot().queued).toBe(1);
  writes[0]!.resolve(outcome(10));
  await vi.advanceTimersByTimeAsync(0);
  expect(writes[1]!.patch).toEqual({ hex: "#FFFFFF", speed: 42, bright: 77 });
  expect(c.snapshot().desired?.bright).toBe(77);
  c.dispose();
});
it("preserves timer barriers in either order and power off cancels unsent timers", async () => {
  const c = make();
  void c.change({ bright: 10 });
  c.release();
  const timer = c.change({ timerMinutes: 5 });
  void c.change({ speed: 22 });
  void c.change({ timerMinutes: 8 });
  void c.change({ power: false });
  expect(c.snapshot().queued).toBe(1);
  expect((await timer).outcome).toBe("cancelled");
  c.release();
  writes[0]!.resolve(outcome(10));
  await vi.advanceTimersByTimeAsync(0);
  expect(writes[1]!.patch).toEqual({ speed: 22, power: false });
  c.dispose();
});
it("orders timer before slider and slider before timer without merging", async () => {
  const c = make();
  void c.change({ timerMinutes: 5 });
  c.release();
  void c.change({ bright: 40 });
  void c.change({ timerMinutes: 2 });
  c.release();
  writes[0]!.resolve(outcome(10, "confirmed", "timer"));
  await vi.advanceTimersByTimeAsync(0);
  expect(writes[1]!.patch).toEqual({ bright: 40 });
  writes[1]!.resolve(outcome(writes[1]!.generation));
  await vi.advanceTimersByTimeAsync(0);
  expect(writes[2]!.patch).toEqual({ timerMinutes: 2 });
  c.dispose();
});
it("only current generation native outcomes reconcile; old poll never clears intent", async () => {
  const c = make(50);
  void c.change({ bright: 88 });
  c.release();
  const old = sample();
  old.commands.state = outcome(49);
  c.applySnapshot(old);
  expect(c.snapshot().stateOutcome).toBe("pending");
  expect(c.snapshot().desired?.bright).toBe(88);
  writes[0]!.resolve(outcome(50, "unconfirmed"));
  await vi.advanceTimersByTimeAsync(0);
  expect(c.snapshot().stateOutcome).toBe("unconfirmed");
  const reconcile = sample();
  reconcile.commands.state = {
    ...outcome(50),
    state: { ...sample().data!, bright: 88 },
  };
  c.applySnapshot(reconcile);
  expect(c.snapshot().stateOutcome).toBe("confirmed");
  c.dispose();
});
it("does not retry uncertainty automatically and explicit retry allocates a generation", async () => {
  const c = make();
  void c.change({ bright: 75 });
  c.release();
  writes[0]!.resolve(outcome(10, "unconfirmed"));
  await vi.advanceTimersByTimeAsync(10000);
  expect(writes).toHaveLength(1);
  void c.retry();
  c.release();
  expect(writes[1]!.generation).toBe(11);
  c.dispose();
});
it("bounds four unsent units with explicit rejection without losing accepted actions", async () => {
  const c = make();
  void c.change({ bright: 10 });
  c.release();
  for (let n = 0; n < 4; n++) void c.change({ timerMinutes: n });
  await expect(c.change({ timerMinutes: 5 })).rejects.toThrow("QUEUE_FULL");
  expect(c.snapshot().queued).toBe(4);
  c.dispose();
});
it("loss and teardown cancel queued work with no reconnect replay", async () => {
  const c = make();
  void c.change({ bright: 10 });
  c.release();
  const queued = c.change({ timerMinutes: 10 });
  c.applySnapshot({ ...sample(), state: "disconnected", stale: true });
  expect((await queued).outcome).toBe("cancelled");
  c.applySnapshot(sample());
  writes[0]!.resolve(outcome(10));
  await vi.advanceTimersByTimeAsync(1000);
  expect(writes).toHaveLength(1);
  c.dispose();
});
it("rejects writes before generation initialization", async () => {
  const c = new LightIntentController(async () => outcome(1), fakeClock());
  await expect(c.change({ power: true })).rejects.toThrow("BAD_GENERATION");
  c.dispose();
});
it("coalesces for 150ms and retained timer state never proves an uncertain timer ran", async () => {
  const c = make();
  void c.change({ bright: 25 });
  await vi.advanceTimersByTimeAsync(149);
  expect(writes).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(writes).toHaveLength(1);
  void c.change({ timerMinutes: 10 });
  c.release();
  writes[0]!.resolve({
    ...outcome(10),
    state: { ...sample().data!, bright: 25 },
  });
  await vi.advanceTimersByTimeAsync(0);
  writes[1]!.resolve(outcome(11, "unconfirmed", "timer"));
  await vi.advanceTimersByTimeAsync(0);
  const poll = sample();
  poll.data!.timerSeconds = 600;
  c.applySnapshot(poll);
  expect(c.snapshot().timerOutcome).toBe("unconfirmed");
  expect(c.snapshot().stateOutcome).toBe("confirmed");
  await vi.advanceTimersByTimeAsync(30000);
  expect(writes).toHaveLength(2);
  c.dispose();
});
it("never downgrades a confirmed generation on a delayed pending outcome", () => {
  const c = make();
  void c.change({ power: true });
  c.release();
  c.ack(outcome(10));
  c.ack(outcome(10, "pending"));
  expect(c.snapshot().stateOutcome).toBe("confirmed");
  c.dispose();
});
it("dispose settles queued timer callbacks and ignores late in-flight replies", async () => {
  const c = make();
  void c.change({ bright: 10 });
  c.release();
  const queued = c.change({ timerMinutes: 10 });
  c.dispose();
  expect((await queued).outcome).toBe("cancelled");
  writes[0]!.resolve(outcome(10));
  await vi.advanceTimersByTimeAsync(1000);
  expect(writes).toHaveLength(1);
});
it("keeps newly confirmed desired values when a pre-command poll arrives later", () => {
  const c = make();
  void c.change({ bright: 88 });
  c.release();
  const reply = outcome(10);
  reply.state = { ...sample().data!, bright: 88 };
  c.ack(reply);
  c.applySnapshot(sample());
  expect(c.snapshot().desired?.bright).toBe(88);
  expect(c.snapshot().confirmed?.bright).toBe(88);
  c.dispose();
});
it("keeps an earlier unconfirmed field visible after a different field confirms", async () => {
  const c = make();
  void c.change({ bright: 88 });
  c.release();
  writes[0]!.resolve(outcome(10, "unconfirmed"));
  await vi.advanceTimersByTimeAsync(0);
  void c.change({ speed: 22 });
  c.release();
  const result = outcome(11);
  result.state = { ...sample().data!, speed: 22 };
  writes[1]!.resolve(result);
  await vi.advanceTimersByTimeAsync(0);
  expect(c.snapshot().desired?.bright).toBe(88);
  expect(c.snapshot().stateOutcome).toBe("unconfirmed");
  void c.retry();
  c.release();
  expect(writes[2]!.patch).toEqual({ bright: 88 });
  c.dispose();
});
it("retained earlier timer outcome cannot overwrite newer confirmed ordinary state", async () => {
  const c = make();
  void c.change({ timerMinutes: 5 });
  c.release();
  writes[0]!.resolve(outcome(10, "confirmed", "timer"));
  await vi.advanceTimersByTimeAsync(0);
  void c.change({ bright: 88 });
  c.release();
  const result = outcome(11);
  result.state = { ...sample().data!, bright: 88 };
  writes[1]!.resolve(result);
  await vi.advanceTimersByTimeAsync(0);
  const poll = sample();
  poll.data = { ...result.state };
  poll.commands.state = result;
  poll.commands.timer = outcome(10, "confirmed", "timer");
  c.applySnapshot(poll);
  expect(c.snapshot().confirmed?.bright).toBe(88);
  c.dispose();
});
