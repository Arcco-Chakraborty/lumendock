import {
  LightPatchSchema,
  type CommandResult,
  type ErrorCode,
  type EspSnapshot,
  type EspState,
  type LightPatch,
} from "@phone-monitor/protocol";
import { DeviceError, systemClock, type Clock } from "../device.js";
type Unit = {
  patch: LightPatch;
  generation: number;
  kind: "state" | "timer";
  settle: (result: CommandResult) => void;
};
export interface IntentSnapshot {
  desired: EspState | null;
  confirmed: EspState | null;
  stateOutcome: CommandResult["outcome"] | null;
  timerOutcome: CommandResult["outcome"] | null;
  queued: number;
  ready: boolean;
}
export class LightIntentController {
  private floor: number | null = null;
  private disposed = false;
  private connected = false;
  private desired: EspState | null = null;
  private confirmed: EspState | null = null;
  private queue: Unit[] = [];
  private inflight: Unit | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private current = { state: 0, timer: 0 };
  private outcomes: {
    state: CommandResult["outcome"] | null;
    timer: CommandResult["outcome"] | null;
  } = { state: null, timer: null };
  private retryPatch: LightPatch | null = null;
  private confirmedGeneration = 0;
  private consumed: Record<
    "state" | "timer",
    { generation: number; outcome: CommandResult["outcome"] } | null
  > = { state: null, timer: null };
  private cached: IntentSnapshot | null = null;
  constructor(
    private readonly send: (
      patch: LightPatch,
      generation: number,
    ) => Promise<CommandResult>,
    private readonly clock: Clock = systemClock,
  ) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = (): IntentSnapshot =>
    (this.cached ??= {
      desired: this.desired,
      confirmed: this.confirmed,
      stateOutcome: this.outcomes.state,
      timerOutcome: this.outcomes.timer,
      queued: this.queue.length,
      ready: this.floor !== null && this.connected && !this.disposed,
    });
  private notify() {
    this.cached = null;
    for (const fn of this.listeners) fn();
  }
  initialize(next: number) {
    if (Number.isSafeInteger(next) && next > 0) {
      this.floor = Math.max(this.floor ?? 1, next);
      this.notify();
    }
  }
  private result(
    unit: Unit,
    outcome: CommandResult["outcome"],
    errorCode: ErrorCode | null = null,
  ): CommandResult {
    return {
      generation: unit.generation,
      kind: unit.kind,
      outcome,
      state: this.confirmed,
      errorCode,
    };
  }
  change(patch: LightPatch): Promise<CommandResult> {
    if (this.disposed) return Promise.reject(new DeviceError("SESSION_ENDED"));
    if (this.floor === null)
      return Promise.reject(new DeviceError("BAD_GENERATION"));
    if (!this.connected)
      return Promise.reject(new DeviceError("WIFI_UNAVAILABLE"));
    const parsed = LightPatchSchema.safeParse(patch);
    if (!parsed.success) return Promise.reject(new DeviceError("BAD_PAYLOAD"));
    patch = parsed.data;
    if (patch.power === false) {
      const cancelled = this.queue.filter((u) => u.kind === "timer");
      this.queue = this.queue.filter((u) => u.kind !== "timer");
      for (const u of cancelled) {
        u.settle(this.result(u, "cancelled"));
        if (this.current.timer === u.generation)
          this.outcomes.timer = "cancelled";
      }
    }
    const kind = patch.timerMinutes === undefined ? "state" : "timer";
    const tail = this.queue[this.queue.length - 1];
    const merge = kind === "state" && tail?.kind === "state";
    if (!merge && this.queue.length >= 4)
      return Promise.reject(new DeviceError("QUEUE_FULL"));
    const generation = this.floor++;
    this.current[kind] = generation;
    this.outcomes[kind] = "pending";
    if (kind === "state" && this.desired) {
      const next = { ...this.desired };
      if (patch.power !== undefined) next.power = patch.power;
      if (patch.hex !== undefined) next.hex = patch.hex.toUpperCase();
      if (patch.bright !== undefined) next.bright = patch.bright;
      if (patch.mode !== undefined) next.mode = patch.mode;
      if (patch.speed !== undefined) next.speed = patch.speed;
      this.desired = next;
      this.retryPatch = { ...(this.retryPatch ?? {}), ...patch };
    }
    const promise = new Promise<CommandResult>((settle) => {
      if (merge) {
        tail.settle(this.result(tail, "superseded"));
        tail.patch = { ...tail.patch, ...patch };
        tail.generation = generation;
        tail.settle = settle;
      } else this.queue.push({ patch, generation, kind, settle });
    });
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.pump();
    }, 150);
    this.notify();
    return promise;
  }
  release() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.pump();
  }
  private pump() {
    if (this.disposed || !this.connected || this.inflight || !this.queue.length)
      return;
    const unit = this.queue.shift()!;
    this.inflight = unit;
    this.notify();
    void this.send(unit.patch, unit.generation)
      .then(
        (result) => {
          if (!this.disposed) {
            this.ack(result);
            unit.settle(result);
          }
        },
        (error) => {
          if (!this.disposed) {
            const code =
              error instanceof DeviceError ? error.code : "COMMAND_UNCONFIRMED";
            this.fail(unit.generation, code);
            unit.settle(this.result(unit, "unconfirmed", code));
          }
        },
      )
      .finally(() => {
        if (this.inflight === unit) this.inflight = null;
        if (!this.disposed && this.timer === null) this.pump();
      });
  }
  ack(result: CommandResult) {
    if (this.disposed || result.generation !== this.current[result.kind])
      return;
    const previous = this.consumed[result.kind];
    if (
      previous?.generation === result.generation &&
      previous.outcome === result.outcome
    )
      return;
    if (
      previous?.generation === result.generation &&
      previous.outcome === "confirmed" &&
      result.outcome !== "confirmed"
    )
      return;
    if (
      this.outcomes[result.kind] === "confirmed" &&
      result.outcome !== "confirmed"
    )
      return;
    if (
      result.outcome === "pending" &&
      this.outcomes[result.kind] !== "pending"
    )
      return;
    this.consumed[result.kind] = {
      generation: result.generation,
      outcome: result.outcome,
    };
    this.outcomes[result.kind] = result.outcome;
    if (result.state && result.generation >= this.confirmedGeneration) {
      this.confirmed = result.state;
      this.confirmedGeneration = result.generation;
    }
    if (
      result.kind === "state" &&
      result.outcome === "confirmed" &&
      result.state
    ) {
      // A newer, unrelated field must not erase an earlier uncertain field.
      const remaining: LightPatch = {};
      for (const field of [
        "power",
        "hex",
        "bright",
        "mode",
        "speed",
      ] as const) {
        const wanted = this.retryPatch?.[field];
        if (
          wanted !== undefined &&
          (field === "hex"
            ? String(wanted).toUpperCase() !== result.state.hex
            : wanted !== result.state[field])
        ) {
          Object.assign(remaining, { [field]: wanted });
        }
      }
      this.retryPatch = Object.keys(remaining).length ? remaining : null;
      if (this.retryPatch) this.outcomes.state = "unconfirmed";
    }
    this.notify();
  }
  fail(generation: number, code: ErrorCode) {
    for (const kind of ["state", "timer"] as const)
      if (this.current[kind] === generation)
        this.ack({
          generation,
          kind,
          outcome: "unconfirmed",
          state: null,
          errorCode: code,
        });
  }
  applySnapshot(snapshot: EspSnapshot) {
    if (this.disposed) return;
    this.connected = snapshot.state === "connected" && !snapshot.stale;
    const observedGeneration = Math.max(
      snapshot.commands.state?.generation ?? 0,
      snapshot.commands.timer?.generation ?? 0,
    );
    // Outcomes describe command completion; snapshot.data is the newer observation.
    // Consume transitions first so historical result.state cannot replace that sample.
    for (const kind of ["state", "timer"] as const) {
      const result = snapshot.commands[kind];
      if (result) this.ack(result);
    }
    if (snapshot.data) {
      // A bridge poll started before dispatch can arrive after its reply.
      if (observedGeneration >= this.confirmedGeneration)
        this.confirmed = snapshot.data;
      const currentObserved =
        (snapshot.commands.state?.generation ?? 0) >= this.current.state;
      if (
        this.desired === null ||
        (currentObserved &&
          !this.retryPatch &&
          this.outcomes.state !== "pending")
      )
        this.desired = snapshot.data;
    }
    if (!this.connected) {
      this.cancelQueue();
      if (this.inflight)
        this.fail(this.inflight.generation, "COMMAND_UNCONFIRMED");
    }
    this.notify();
  }
  retry() {
    return this.retryPatch
      ? this.change(this.retryPatch)
      : Promise.reject(new DeviceError("BAD_PAYLOAD"));
  }
  private cancelQueue() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    for (const u of this.queue) {
      u.settle(this.result(u, "cancelled"));
      if (this.current[u.kind] === u.generation)
        this.outcomes[u.kind] = "cancelled";
    }
    this.queue = [];
  }
  dispose() {
    if (this.disposed) return;
    this.cancelQueue();
    if (this.inflight)
      this.inflight.settle(this.result(this.inflight, "cancelled"));
    this.disposed = true;
    this.listeners.clear();
  }
}
