import {
  BridgeRequestSchema,
  BridgeReplySchemaFor,
  LIMITS,
  type BridgeOp,
  type BridgeRequest,
  type BridgeReplyData,
  type ErrorCode,
} from "@phone-monitor/protocol";

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}
export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};
export interface NativeBridge {
  postMessage(message: string): void;
  onmessage: ((event: { data: string }) => void) | null;
}
type Args<O extends BridgeOp> = Extract<BridgeRequest, { op: O }>["args"];
type EmptyOp = Exclude<
  BridgeOp,
  "esp.set" | "app.setScreenOn" | "app.setBrightness"
>;
type RequestArgs<O extends BridgeOp> = O extends EmptyOp
  ? [args?: Args<O>]
  : [args: Args<O>];
export interface DeviceAdapter {
  request<O extends BridgeOp>(
    op: O,
    ...args: RequestArgs<O>
  ): Promise<BridgeReplyData<O>>;
  dispose(): void;
}
export class DeviceError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly retryable = false,
  ) {
    super(code);
    this.name = "DeviceError";
  }
}
type Pending = {
  op: BridgeOp;
  resolve: (data: never) => void;
  reject: (error: DeviceError) => void;
  timer: ReturnType<typeof setTimeout>;
};
let sessionNumber = 0;
export function createNativeAdapter(
  bridge: NativeBridge | undefined,
  clock: Clock = systemClock,
): DeviceAdapter {
  const pending = new Map<string, Pending>();
  const prefix = `view-${++sessionNumber}-${Math.random().toString(36).slice(2, 10)}`;
  let counter = 0,
    closed = false;
  const supported =
    bridge !== undefined && typeof bridge.postMessage === "function";
  const previous = bridge?.onmessage ?? null;
  function settle(id: string, error: DeviceError | null, data?: unknown) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    clock.clearTimeout(item.timer);
    if (error) item.reject(error);
    else item.resolve(data as never);
  }
  const receive = (event: { data: string }) => {
    if (closed || typeof event.data !== "string") return;
    // Largest legal response is the hub snapshot plus its reply envelope.
    if (
      new TextEncoder().encode(event.data).byteLength >
      LIMITS.hubBytes + 1024
    )
      return;
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      return;
    }
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("id" in raw) ||
      typeof raw.id !== "string"
    )
      return;
    const item = pending.get(raw.id);
    if (!item) return;
    const parsed = BridgeReplySchemaFor(item.op).safeParse(raw);
    if (!parsed.success) {
      settle(raw.id, new DeviceError("BAD_PAYLOAD"));
      return;
    }
    const reply = parsed.data;
    if (reply.ok) settle(reply.id, null, reply.data);
    else
      settle(
        reply.id,
        new DeviceError(reply.error.code, reply.error.retryable),
      );
  };
  if (supported) bridge.onmessage = receive;
  return {
    request(op, ...args) {
      if (closed) return Promise.reject(new DeviceError("SESSION_ENDED"));
      if (!supported)
        return Promise.reject(
          new DeviceError(
            bridge ? "UNSUPPORTED_WEBVIEW" : "BRIDGE_UNAVAILABLE",
          ),
        );
      const id = `${prefix}-${++counter}`;
      const parsed = BridgeRequestSchema.safeParse({
        v: 1,
        id,
        op,
        args: args[0] ?? {},
      });
      if (!parsed.success)
        return Promise.reject(new DeviceError("BAD_PAYLOAD"));
      if (pending.size >= 16)
        return Promise.reject(new DeviceError("QUEUE_FULL"));
      return new Promise((resolve, reject) => {
        const timer = clock.setTimeout(
          () => settle(id, new DeviceError("REQUEST_TIMEOUT", true)),
          10000,
        );
        pending.set(id, {
          op,
          resolve: resolve as (data: never) => void,
          reject,
          timer,
        });
        try {
          bridge.postMessage(JSON.stringify(parsed.data));
        } catch {
          settle(id, new DeviceError("BRIDGE_UNAVAILABLE", true));
        }
      });
    },
    dispose() {
      if (closed) return;
      closed = true;
      if (bridge?.onmessage === receive) bridge.onmessage = previous;
      for (const id of pending.keys())
        settle(id, new DeviceError("SESSION_ENDED"));
    },
  };
}
