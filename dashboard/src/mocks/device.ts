// Explicit development/test fixture transport. Never imported by the production branch.
import {
  BridgeRequestSchema,
  EspStateSchema,
  type BridgeOp,
  type CommandResult,
  type BridgeReplyData,
  type ErrorCode,
} from "@phone-monitor/protocol";
import {
  createNativeAdapter,
  systemClock,
  type Clock,
  type DeviceAdapter,
  type NativeBridge,
} from "../device.js";
export type MockFixtures = { [O in BridgeOp]?: BridgeReplyData<O> } & {
  calendarError?: ErrorCode | null | undefined;
};
export function createMockAdapter(
  fixtures: MockFixtures,
  clock: Clock = systemClock,
): DeviceAdapter {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let selectCounter = 1;
  const bridge: NativeBridge = {
    onmessage: null,
    postMessage(message) {
      const request = BridgeRequestSchema.parse(JSON.parse(message));
      const timer = clock.setTimeout(() => {
        timers.delete(timer);
        if (
          fixtures.calendarError &&
          (request.op === "hub.calendar" ||
            request.op === "hub.calendarSources" ||
            request.op === "hub.calendarSelect")
        ) {
          bridge.onmessage?.({
            data: JSON.stringify({
              v: 1,
              id: request.id,
              ok: false,
              error: { code: fixtures.calendarError, retryable: false },
            }),
          });
          return;
        }
        let data: unknown = fixtures[request.op];
        const esp = fixtures["esp.state"],
          app = fixtures["app.status"],
          cal = fixtures["hub.calendar"],
          calSources = fixtures["hub.calendarSources"];
        if (request.op === "hub.calendar" && cal?.data) {
          data = {
            ...cal,
            data: {
              ...cal.data,
              range: {
                startDate: request.args.startDate,
                days: request.args.days,
                timeZone: request.args.timeZone,
              },
            },
          };
        }
        if (
          data === undefined &&
          request.op === "hub.calendarSelect" &&
          (cal || calSources)
        ) {
          const selectionRevision = `synthetic_selection_${++selectCounter}`;
          const allowed = new Set(request.args.sourceIds);
          if (cal?.data) {
            cal.data.selectionRevision = selectionRevision;
            if (cal.data.state === "setup_required") {
              cal.data.state = "available";
            }
            cal.data.sources = cal.data.sources.map((source) => ({
              ...source,
              selected: allowed.has(source.sourceId),
            }));
            cal.data.items = cal.data.items.filter((item) =>
              allowed.has(item.sourceId),
            );
            if (
              cal.data.nextEvent &&
              !allowed.has(cal.data.nextEvent.sourceId)
            ) {
              cal.data.nextEvent = null;
            }
          }
          if (calSources?.data) {
            calSources.data.selectionRevision = selectionRevision;
            if (calSources.data.state === "setup_required") {
              calSources.data.state = "available";
            }
            calSources.data.sources = calSources.data.sources.map((source) => ({
              ...source,
              selected: allowed.has(source.sourceId),
            }));
          }
          data = { selectionRevision };
        }
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
