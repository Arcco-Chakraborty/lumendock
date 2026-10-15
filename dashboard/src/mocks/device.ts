// Explicit development/test fixture transport. Never imported by the production branch.
import {
  BridgeRequestSchema,
  type BridgeOp,
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
        const data = fixtures[request.op];
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
