import { vi } from "vitest";
import type { Clock, NativeBridge } from "../src/device.js";
export const fakeClock = (): Clock => ({
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
});
export function fakeBridge() {
  const sent: Array<{ v: number; id: string; op: string; args: unknown }> = [];
  const bridge: NativeBridge = {
    postMessage: (message) => {
      sent.push(JSON.parse(message));
    },
    onmessage: null,
  };
  return {
    bridge,
    sent,
    reply: (id: string, data: unknown) =>
      bridge.onmessage?.({
        data: JSON.stringify({ v: 1, id, ok: true, data }),
      }),
    raw: (data: unknown) => bridge.onmessage?.({ data: JSON.stringify(data) }),
  };
}
export async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}
