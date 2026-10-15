// Test-only synthetic native bridge. It exists solely in this e2e harness and is
// injected with page.addInitScript; the production bundle contains no mock adapter.
// Every payload is parsed with the shared protocol schemas before injection so the
// browser receives exactly the serialized shapes the Android bridge would send.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import {
  AppStatusSchema,
  EspHistoryLinkSnapshotSchema,
  EspSnapshotSchema,
  HubLinkSnapshotSchema,
  type AppStatus,
  type EspHistory,
  type EspSnapshot,
  type HubSnapshot,
  type LinkSnapshot,
} from "@phone-monitor/protocol";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../packages/protocol/fixtures/${name}`, import.meta.url),
      "utf8",
    ),
  );

export type HubLink = LinkSnapshot<HubSnapshot>;
export interface Fixtures {
  hub: HubLink;
  esp: EspSnapshot;
  history: LinkSnapshot<EspHistory>;
  app: AppStatus;
}
export interface BridgeOptions {
  /** USB/laptop path state. */
  hub?: "connected" | "disconnected";
  /** Wi-Fi/controller path state. */
  esp?: "connected" | "disconnected";
  /** Mutate the synthetic fixtures before they are validated and injected. */
  edit?: (fixtures: Fixtures) => void;
  /** Delay every reply by this many milliseconds. */
  latencyMs?: number;
  /** Start with esp.set replies held until releaseHeld(). */
  holdSets?: boolean;
  actionResult?: { success: boolean; message?: string };
}

export function fixtures(options: BridgeOptions = {}): Fixtures {
  const hub = HubLinkSnapshotSchema.parse({
    state: "connected",
    ageMs: 0,
    stale: false,
    data: fixture("hub-host.json"),
    errorCode: null,
  });
  const esp = EspSnapshotSchema.parse(fixture("esp-link-ready.json"));
  const history = EspHistoryLinkSnapshotSchema.parse({
    state: "connected",
    ageMs: 0,
    stale: false,
    data: fixture("esp-history.json"),
    errorCode: null,
  });
  const app = AppStatusSchema.parse(fixture("app-status.json"));
  const result: Fixtures = { hub, esp, history, app };
  if (options.hub === "disconnected") {
    result.hub = {
      state: "disconnected",
      ageMs: null,
      stale: true,
      data: null,
      errorCode: "USB_UNAVAILABLE",
    };
  }
  if (options.esp === "disconnected") {
    result.esp = {
      state: "disconnected",
      ageMs: null,
      stale: true,
      data: null,
      errorCode: "WIFI_UNAVAILABLE",
      commands: { state: null, timer: null },
    };
  }
  options.edit?.(result);
  // Fail loudly in the harness if an edit made a payload the bridge could not send.
  HubLinkSnapshotSchema.parse(result.hub);
  EspSnapshotSchema.parse(result.esp);
  EspHistoryLinkSnapshotSchema.parse(result.history);
  AppStatusSchema.parse(result.app);
  return result;
}

export interface BridgeLogEntry {
  op: string;
  args: unknown;
  /** Milliseconds since the init script ran. */
  at: number;
  /** esp.set requests already waiting for a reply when this one arrived. */
  concurrent: number;
}
export interface BridgeConfig extends Fixtures {
  latencyMs: number;
  holdSets: boolean;
  actionResult: { success: boolean; message?: string };
}

// Runs inside the page. It must stay self-contained (no closures over Node values).
function installBridge(config: BridgeConfig): void {
  const w = window as unknown as Record<string, unknown>;
  const started = Date.now();
  const model = {
    hub: config.hub,
    esp: config.esp,
    history: config.history,
    app: config.app,
  };
  const log: BridgeLogEntry[] = [];
  let outstanding = 0,
    maxOutstanding = 0,
    hold = config.holdSets;
  const held: Array<() => void> = [];
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const bridge = {
    onmessage: null as null | ((event: { data: string }) => void),
    postMessage(message: string) {
      const request = JSON.parse(message) as {
        id: string;
        op: string;
        args: { patch?: Record<string, unknown>; generation?: number } & Record<
          string,
          unknown
        >;
      };
      const entry: BridgeLogEntry = {
        op: request.op,
        args: request.args,
        at: Date.now() - started,
        concurrent: outstanding,
      };
      log.push(entry);
      const send = (reply: unknown) =>
        bridge.onmessage?.({ data: JSON.stringify(reply) });
      const ok = (data: unknown) => ({ v: 1, id: request.id, ok: true, data });
      const respond = (data: unknown, release?: () => void) => {
        const deliver = () => {
          release?.();
          send(ok(data));
        };
        setTimeout(deliver, config.latencyMs);
      };
      switch (request.op) {
        case "hub.action":
          respond(config.actionResult);
          break;
        case "hub.snapshot": {
          const hub = clone(model.hub);
          if (hub.data)
            hub.data.serverNowEpochMs += Date.now() - started;
          respond(hub);
          break;
        }
        case "esp.state":
          respond(clone(model.esp));
          break;
        case "esp.history":
          respond(clone(model.history));
          break;
        case "app.status":
          respond(clone(model.app));
          break;
        case "app.setScreenOn":
          model.app.screenOn = Boolean(request.args.enabled);
          respond({
            screenOn: model.app.screenOn,
            brightness: model.app.brightness,
          });
          break;
        case "app.setBrightness":
          model.app.brightness = Number(request.args.value);
          respond({
            screenOn: model.app.screenOn,
            brightness: model.app.brightness,
          });
          break;
        case "app.setupHub":
        case "app.connectEsp":
          respond({ setupId: "synthetic-setup", started: true });
          break;
        case "app.openWifiSettings":
          respond({ opened: true });
          break;
        case "esp.set": {
          outstanding += 1;
          maxOutstanding = Math.max(maxOutstanding, outstanding);
          const patch = request.args.patch ?? {};
          const generation = request.args.generation ?? 1;
          const kind = patch.timerMinutes === undefined ? "state" : "timer";
          const reply = () => {
            const current = model.esp.data;
            if (!current) {
              send({
                v: 1,
                id: request.id,
                ok: false,
                error: { code: "WIFI_UNAVAILABLE", retryable: true },
              });
              return;
            }
            const next = { ...current } as Record<string, unknown>;
            if (kind === "timer")
              next.timerSeconds = Number(patch.timerMinutes) * 60;
            else
              for (const key of ["power", "hex", "bright", "mode", "speed"])
                if (patch[key] !== undefined)
                  next[key] =
                    key === "hex" ? String(patch[key]).toUpperCase() : patch[key];
            model.esp.data = next as unknown as typeof current;
            const result = {
              generation,
              kind,
              outcome: "confirmed",
              state: next,
              errorCode: null,
            };
            (model.esp.commands as Record<string, unknown>)[kind] = result;
            model.app.nextCommandGeneration = Math.max(
              model.app.nextCommandGeneration,
              generation + 1,
            );
            send(ok(result));
          };
          const finish = () => {
            outstanding -= 1;
            reply();
          };
          if (hold) held.push(finish);
          else setTimeout(finish, config.latencyMs);
          break;
        }
        default:
          send({
            v: 1,
            id: request.id,
            ok: false,
            error: { code: "BAD_PAYLOAD", retryable: false },
          });
      }
    },
  };
  w.phoneMonitor = bridge;
  w.__bridge = {
    log,
    maxOutstanding: () => maxOutstanding,
    outstanding: () => outstanding,
    holdSets(value: boolean) {
      hold = value;
      if (!hold) while (held.length) held.shift()!();
    },
    releaseOne() {
      held.shift()?.();
    },
    heldCount: () => held.length,
    set(key: "hub" | "esp" | "history" | "app", value: unknown) {
      (model as Record<string, unknown>)[key] = value;
    },
  };
}

export async function installSyntheticNativeBridge(
  page: Page,
  options: BridgeOptions = {},
): Promise<Fixtures> {
  const data = fixtures(options);
  await page.addInitScript(installBridge, {
    ...data,
    latencyMs: options.latencyMs ?? 5,
    holdSets: options.holdSets ?? false,
    actionResult: options.actionResult ?? {success: true},
  });
  return data;
}

type Slot = "hub" | "esp" | "history" | "app";
/** Replace what the fake bridge will report from the next poll on (validated first). */
export async function setBridgeSlot(
  page: Page,
  slot: Slot,
  value: HubLink | EspSnapshot | LinkSnapshot<EspHistory> | AppStatus,
): Promise<void> {
  if (slot === "hub") HubLinkSnapshotSchema.parse(value);
  if (slot === "esp") EspSnapshotSchema.parse(value);
  if (slot === "history") EspHistoryLinkSnapshotSchema.parse(value);
  if (slot === "app") AppStatusSchema.parse(value);
  await page.evaluate(
    ([key, payload]) =>
      (
        window as unknown as {
          __bridge: { set(key: string, value: unknown): void };
        }
      ).__bridge.set(key as string, payload),
    [slot, value] as const,
  );
}
export const bridgeLog = (page: Page): Promise<BridgeLogEntry[]> =>
  page.evaluate(
    () =>
      (window as unknown as { __bridge: { log: BridgeLogEntry[] } }).__bridge
        .log,
  );
export const bridgeCall = <T>(page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    ([name, params]) =>
      (
        (window as unknown as { __bridge: Record<string, Function> }).__bridge[
          name as string
        ] as Function
      )(...(params as unknown[])) as T,
    [method, args] as const,
  );
