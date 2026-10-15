// Explicit development/test fixture transport. Never imported by the production branch.
import {
  BridgeRequestSchema,
  EspStateSchema,
  type BridgeOp,
  type CommandResult,
  type BridgeReplyData,
} from "@phone-monitor/protocol";
import {
  createNativeAdapter,
  systemClock,
  type Clock,
  type DeviceAdapter,
  type NativeBridge,
} from "../device.js";
export type MockFixtures = { [O in BridgeOp]?: BridgeReplyData<O> };
export function createMockAdapter(
  fixtures: MockFixtures,
  clock: Clock = systemClock,
): DeviceAdapter {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const bridge: NativeBridge = {
    onmessage: null,
    postMessage(message) {
      const request = BridgeRequestSchema.parse(JSON.parse(message));
      const timer = clock.setTimeout(() => {
        timers.delete(timer);
        let data: unknown = fixtures[request.op];
        const esp = fixtures["esp.state"],
          app = fixtures["app.status"];
        if (data === undefined && request.op === "esp.set" && esp?.data) {
          const { patch, generation } = request.args;
          const kind = patch.timerMinutes === undefined ? "state" : "timer";
          const next = EspStateSchema.parse({
            ...esp.data,
            ...(kind === "state"
              ? patch
              : { timerSeconds: patch.timerMinutes! * 60 }),
          });
          esp.data = next;
          const result: CommandResult = {
            generation,
            kind,
            outcome: "confirmed" as const,
            state: next,
            errorCode: null,
          };
          esp.commands[kind] = result;
          data = result;
          if (app)
            app.nextCommandGeneration = Math.max(
              app.nextCommandGeneration,
              generation + 1,
            );
        }
        if (
          data === undefined &&
          app &&
          (request.op === "app.setScreenOn" ||
            request.op === "app.setBrightness")
        ) {
          if (request.op === "app.setScreenOn")
            app.screenOn = request.args.enabled;
          else app.brightness = request.args.value;
          data = { screenOn: app.screenOn, brightness: app.brightness };
        }
        if (data === undefined && request.op === "hub.action") {
          data = { success: true, message: `Action ${request.args.action}` };
        }
        const reply =
          data === undefined
            ? {
                v: 1,
                id: request.id,
                ok: false,
                error: { code: "SOURCE_UNAVAILABLE", retryable: false },
              }
            : { v: 1, id: request.id, ok: true, data };
        bridge.onmessage?.({ data: JSON.stringify(reply) });
      }, 0);
      timers.add(timer);
    },
  };
  const adapter = createNativeAdapter(bridge, clock);
  return {
    request: adapter.request,
    dispose() {
      for (const timer of timers) clock.clearTimeout(timer);
      timers.clear();
      adapter.dispose();
    },
  };
}
