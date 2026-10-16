import { z } from 'zod';

export const LIMITS = Object.freeze({bridgeBytes:16*1024,hubBytes:256*1024,espBytes:64*1024,claudeWindows:2,codexWindows:62,notifications:100,notificationTtlMs:30*60*1000,claudeStaleMs:300000,codexStaleMs:120000,laptopStaleMs:6000,espStaleMs:9000});
const bounded = (max: number) => z.string().refine(value => [...value].length <= max, 'String exceeds code-point budget');
const identifier = bounded(80).refine(value => value.length > 0, 'Empty identifier');
const safeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const generation = safeInt.min(1);
const epochMs = safeInt;
// Last representable second of year 9999. Contemporary millisecond values fail.
const epochSec = safeInt.max(253402300799);
const finite = z.number().finite();
const brightness = finite.min(0.1).max(1);
export const ErrorCodeSchema = z.enum([
  'USB_UNAVAILABLE','AUTH_REQUIRED','PAIRING_EXPIRED','PAIRING_CLOSED','BAD_PAIRING_CODE',
  'TOKEN_PERSIST_FAILED','WIFI_UNAVAILABLE','SENSOR_UNAVAILABLE','BAD_PAYLOAD',
  'UNSUPPORTED_WEBVIEW','COMMAND_UNCONFIRMED','NOTIFICATION_MONITOR_DENIED',
  'SOURCE_CAPACITY_EXCEEDED','SOURCE_UNAVAILABLE','SETUP_BUSY','BAD_GENERATION',
  'REQUEST_TIMEOUT','BRIDGE_UNAVAILABLE','SESSION_ENDED','QUEUE_FULL',
  'NOTIFICATION_MONITOR_UNAVAILABLE','UNSUPPORTED_SOURCE','HUB_UNAVAILABLE',
]);
const errorCode = ErrorCodeSchema.nullable();
export function withByteBudget<T extends z.ZodType>(schema: T, bytes: number) {
  return schema.superRefine((value, ctx) => {
    try {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > bytes) ctx.addIssue({code:'custom',message:'Serialized byte budget exceeded'});
    } catch { ctx.addIssue({code:'custom',message:'Not serializable'}); }
  });
}
export const ProviderSchema = z.enum(['claude','codex']);
export const SourceStateSchema = z.enum(['available','awaiting_data','auth_required','unsupported','error']);
export const UsageWindowSchema = z.strictObject({
  bucketId:identifier,windowId:identifier,label:bounded(80),usedPercent:finite.min(0).nullable(),
  windowDurationMins:finite.positive().nullable(),resetsAtEpochSec:epochSec.nullable(),reportedAtEpochMs:epochMs.nullable(),
});
const sourceObject = z.strictObject({
  provider:ProviderSchema,source:z.enum(['claude_statusline','claude_usage_api','codex_app_server']),state:SourceStateSchema,
  observedAtEpochMs:epochMs.nullable(),lastSuccessAtEpochMs:epochMs.nullable(),stale:z.boolean(),
  windows:z.array(UsageWindowSchema),errorCode,
});
const matchingSource = (source: z.infer<typeof sourceObject>) => source.provider === 'claude' ? source.source !== 'codex_app_server' : source.source === 'codex_app_server';
// Collector boundary accepts over-capacity observations so the store can expose
// SOURCE_CAPACITY_EXCEEDED while retaining a previous complete observation.
export const UsageObservationSchema = withByteBudget(sourceObject.refine(matchingSource,'Provider/source mismatch'),LIMITS.hubBytes);
export const UsageSourceSchema = sourceObject.refine(matchingSource,'Provider/source mismatch').refine(source => source.windows.length <= (source.provider === 'claude' ? LIMITS.claudeWindows : LIMITS.codexWindows),'Source capacity exceeded');
/**
 * Claude reports only while it is used, so a quiet source usually means no new use: a
 * reading stays current until its window resets. Only a reading without a reset time
 * ages out after LIMITS.claudeStaleMs. An elapsed window is shown as reset, not stale.
 */
export function claudeWindowStale(window: z.infer<typeof UsageWindowSchema>, nowMs: number): boolean {
  const at = window.reportedAtEpochMs;
  if (at === null || nowMs < at) return true;
  return window.resetsAtEpochSec === null && nowMs - at >= LIMITS.claudeStaleMs;
}
export const SelectedNotificationSchema = z.strictObject({
  id:identifier,appId:identifier,title:bounded(100),body:bounded(280),receivedAtEpochMs:epochMs,expiresAtEpochMs:epochMs,
}).refine(n => n.expiresAtEpochMs > n.receivedAtEpochMs && n.expiresAtEpochMs - n.receivedAtEpochMs <= LIMITS.notificationTtlMs,'Invalid notification lifetime');
const notifications = z.strictObject({state:z.enum(['disabled','available','unavailable']),errorCode,items:z.array(SelectedNotificationSchema).max(LIMITS.notifications)});
// Laptop state for the Deck: what is playing and the audio/notification toggles.
// Every field is nullable because each comes from a separate, optional desktop tool.
export const HostMediaSchema = z.strictObject({player:bounded(40),status:z.enum(['playing','paused','stopped']),title:bounded(120),artist:bounded(120)});
// Laptop vitals for the Laptop screen. Each part is null when the laptop does not expose it.
const tempC = finite.min(-50).max(200).nullable();
const percent = finite.min(0).max(100).nullable();
const watts = finite.min(0).max(2000).nullable();
const mhz = safeInt.max(20000).nullable();
export const HostVitalsSchema = z.strictObject({
  cpu:z.strictObject({name:bounded(80),usagePercent:percent,threadUsage:z.array(finite.min(0).max(100)).max(128),tempC,clockMhz:mhz,powerW:watts}).nullable(),
  gpu:z.strictObject({name:bounded(80),state:z.enum(['active','asleep']),usagePercent:percent,tempC,hotspotC:tempC,powerW:watts,memoryUsedMb:safeInt.nullable(),memoryTotalMb:safeInt.nullable(),clockMhz:mhz}).nullable(),
  igpu:z.strictObject({usagePercent:percent,tempC}).nullable(),
  memory:z.strictObject({usedBytes:safeInt,totalBytes:safeInt,swapUsedBytes:safeInt,swapTotalBytes:safeInt}).nullable(),
  power:z.strictObject({source:z.enum(['ac','battery','unknown']),batteryPercent:percent,charging:z.boolean().nullable(),watts,minutesLeft:safeInt.max(100000).nullable()}).nullable(),
  storageTempC:tempC,
});
export const HostStateSchema = z.strictObject({
  media:HostMediaSchema.nullable(),volumePercent:safeInt.max(150).nullable(),muted:z.boolean().nullable(),
  micMuted:z.boolean().nullable(),doNotDisturb:z.boolean().nullable(),vitals:HostVitalsSchema.nullable().optional(),
});
const hubObject = z.strictObject({v:z.literal(1),serverNowEpochMs:epochMs,usage:z.strictObject({claude:UsageSourceSchema,codex:UsageSourceSchema}),notifications,host:HostStateSchema.optional()});
export const HubSnapshotSchema = withByteBudget(hubObject.refine(h => h.usage.claude.provider === 'claude' && h.usage.codex.provider === 'codex','Usage provider mismatch'),LIMITS.hubBytes);
export const EspStateSchema = z.strictObject({
  power:z.boolean(),hex:z.string().regex(/^#[0-9A-F]{6}$/),bright:safeInt.min(1).max(100),mode:safeInt.max(8),speed:safeInt.min(1).max(100),
  timerSeconds:safeInt.max(43200),sensorOk:z.boolean(),temperatureC:finite.nullable(),humidityPercent:finite.min(0).max(100).nullable(),uptimeSeconds:safeInt,
});
export const EspHistorySchema = withByteBudget(z.strictObject({intervalSeconds:finite.positive(),temperatureC:z.array(finite.nullable()).max(120),humidityPercent:z.array(finite.min(0).max(100).nullable()).max(120)}).refine(h => h.temperatureC.length === h.humidityPercent.length,'Unpaired sensor samples'),LIMITS.espBytes);
export const LightPatchSchema = z.strictObject({power:z.boolean().optional(),hex:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),bright:safeInt.min(1).max(100).optional(),mode:safeInt.max(8).optional(),speed:safeInt.min(1).max(100).optional(),timerMinutes:safeInt.max(720).optional()}).refine(p => Object.keys(p).length > 0 && Object.values(p).every(v=>v !== undefined),'Empty or undefined patch field').refine(p => p.timerMinutes === undefined || Object.keys(p).length === 1,'Timer must be separate');
export const CommandResultSchema = z.strictObject({generation,kind:z.enum(['state','timer']),outcome:z.enum(['pending','confirmed','unconfirmed','cancelled','superseded']),state:EspStateSchema.nullable(),errorCode}).refine(c => c.outcome !== 'confirmed' || c.state !== null,'Confirmed command needs state');
const linkObject = <T extends z.ZodType>(data: T) => z.strictObject({state:z.enum(['connecting','connected','disconnected','error']),ageMs:finite.min(0).nullable(),stale:z.boolean(),data:data.nullable(),errorCode});
export function LinkSnapshotSchema<T extends z.ZodType>(data: T): z.ZodType<LinkSnapshot<z.output<T>>> {
  // Zod's generic object inference treats an unresolved payload as optional.
  // The runtime field remains required, and this signature retains its exact
  // payload type for consumers of the exported operation-specific reply map.
  return linkObject(data).refine(link => Reflect.get(link,'data') === null || link.ageMs !== null,'Cached payload requires age') as unknown as z.ZodType<LinkSnapshot<z.output<T>>>;
}
export const HubLinkSnapshotSchema = LinkSnapshotSchema(HubSnapshotSchema);
export const EspHistoryLinkSnapshotSchema = LinkSnapshotSchema(EspHistorySchema);
export const EspSnapshotSchema = withByteBudget(linkObject(EspStateSchema).extend({commands:z.strictObject({state:CommandResultSchema.nullable(),timer:CommandResultSchema.nullable()})}).refine(s => s.data === null || s.ageMs !== null,'Cached payload requires age').refine(s => (s.commands.state === null || s.commands.state.kind === 'state') && (s.commands.timer === null || s.commands.timer.kind === 'timer'),'Command kind mismatch'),LIMITS.espBytes);
export const PairResultSchema = z.strictObject({paired:z.boolean()});
export const SetupStateSchema = z.strictObject({setupId:identifier.nullable(),state:z.enum(['idle','in_progress','succeeded','cancelled','failed']),errorCode}).refine(s => (s.state === 'idle') === (s.setupId === null),'Setup identifier/state mismatch').refine(s => s.state === 'failed' ? s.errorCode !== null : s.errorCode === null,'Setup error/state mismatch');
export const SetupResultSchema = z.strictObject({setupId:identifier,started:z.boolean()});
export const AppStatusSchema = z.strictObject({paired:z.boolean(),webViewSupported:z.boolean(),wifiMode:z.enum(['none','app_request','manual']),setup:z.strictObject({hub:SetupStateSchema,esp:SetupStateSchema}),screenOn:z.boolean(),brightness,nextCommandGeneration:generation}).refine(s => !(s.setup.hub.state === 'in_progress' && s.setup.esp.state === 'in_progress'),'Competing setup flows');
export const ScreenSettingsResultSchema = z.strictObject({screenOn:z.boolean(),brightness});
export const WifiSettingsResultSchema = z.strictObject({opened:z.boolean()});
export const ActionReplySchema = z.strictObject({success:z.boolean(),message:bounded(100).optional()});
const emptyArgs = z.strictObject({});
export const BridgeArgsSchemas = {
  'hub.snapshot':emptyArgs,'esp.state':emptyArgs,'esp.history':emptyArgs,
  'esp.set':z.strictObject({patch:LightPatchSchema,generation}),
  'hub.action':z.strictObject({action:identifier}),
  'app.status':emptyArgs,'app.setupHub':emptyArgs,'app.connectEsp':emptyArgs,'app.openWifiSettings':emptyArgs,
  'app.setScreenOn':z.strictObject({enabled:z.boolean()}),'app.setBrightness':z.strictObject({value:brightness}),
} as const;
export const BridgeOpSchema = z.enum(Object.keys(BridgeArgsSchemas) as [keyof typeof BridgeArgsSchemas,...(keyof typeof BridgeArgsSchemas)[]]);
export const BridgeRequestSchema = withByteBudget(z.discriminatedUnion('op',[
  z.strictObject({v:z.literal(1),id:identifier,op:z.literal('hub.snapshot'),args:BridgeArgsSchemas['hub.snapshot']}),
  z.strictObject({v:z.literal(1),id:identifier,op:z.literal('esp.state'),args:BridgeArgsSchemas['esp.state']}),
  z.strictObject({v:z.literal(1),id:identifier,op:z.literal('esp.history'),args:BridgeArgsSchemas['esp.history']}),
  z.strictObject({v:z.literal(1),id:identifier,op:z.literal('esp.set'),args:BridgeArgsSchemas['esp.set']}),
  z.strictObject({v:z.literal(1),id:identifier,op:z.literal('hub.action'),args:BridgeArgsSchemas['hub.action']}),
  z.strictObject({v:z.literal(1),id:identifier,op:z.literal('app.status'),args:BridgeArgsSchemas['app.status']}),
  z.strictObject({v:z.literal(1),id:identifier,op:z.literal('app.setupHub'),args:BridgeArgsSchemas['app.setupHub']}),
  z.strictObject({v:z.literal(1),id:identifier,op:z.literal('app.connectEsp'),args:BridgeArgsSchemas['app.connectEsp']}),
  z.strictObject({v:z.literal(1),id:identifier,op:z.literal('app.openWifiSettings'),args:BridgeArgsSchemas['app.openWifiSettings']}),
  z.strictObject({v:z.literal(1),id:identifier,op:z.literal('app.setScreenOn'),args:BridgeArgsSchemas['app.setScreenOn']}),
  z.strictObject({v:z.literal(1),id:identifier,op:z.literal('app.setBrightness'),args:BridgeArgsSchemas['app.setBrightness']}),
]),LIMITS.bridgeBytes);
export const BridgeReplyDataSchemas = {
  'hub.snapshot':HubLinkSnapshotSchema,'esp.state':EspSnapshotSchema,'esp.history':EspHistoryLinkSnapshotSchema,'esp.set':CommandResultSchema,
  'hub.action':ActionReplySchema,
  'app.status':AppStatusSchema,'app.setupHub':SetupResultSchema,'app.connectEsp':SetupResultSchema,'app.openWifiSettings':WifiSettingsResultSchema,'app.setScreenOn':ScreenSettingsResultSchema,'app.setBrightness':ScreenSettingsResultSchema,
} as const;
const bridgeError = z.strictObject({code:ErrorCodeSchema,retryable:z.boolean()});
export function BridgeReplySchemaFor<O extends keyof typeof BridgeReplyDataSchemas>(op: O) {
  return z.discriminatedUnion('ok',[
    z.strictObject({v:z.literal(1),id:identifier,ok:z.literal(true),data:BridgeReplyDataSchemas[op]}),
    z.strictObject({v:z.literal(1),id:identifier,ok:z.literal(false),error:bridgeError}),
  ]);
}
export const BridgeReplySchema = z.discriminatedUnion('ok',[
  z.strictObject({v:z.literal(1),id:identifier,ok:z.literal(true),data:z.union([HubLinkSnapshotSchema,EspSnapshotSchema,EspHistoryLinkSnapshotSchema,CommandResultSchema,ActionReplySchema,AppStatusSchema,SetupResultSchema,WifiSettingsResultSchema,ScreenSettingsResultSchema])}),
  z.strictObject({v:z.literal(1),id:identifier,ok:z.literal(false),error:bridgeError}),
]);
export const PairRequestSchema = z.strictObject({code:z.string().regex(/^\d{8}$/)});
export const PairExchangeResultSchema = z.strictObject({token:z.string().regex(/^[a-f0-9]{64}$/)});
export type Provider = z.infer<typeof ProviderSchema>;
export type SourceState = z.infer<typeof SourceStateSchema>;
export type UsageWindow = z.infer<typeof UsageWindowSchema>;
export type UsageSource = z.infer<typeof UsageSourceSchema>;
export type SelectedNotification = z.infer<typeof SelectedNotificationSchema>;
export type HubSnapshot = z.infer<typeof HubSnapshotSchema>;
export type HostState = z.infer<typeof HostStateSchema>;
export type HostMedia = z.infer<typeof HostMediaSchema>;
export type HostVitals = z.infer<typeof HostVitalsSchema>;
export type EspState = z.infer<typeof EspStateSchema>;
export type EspHistory = z.infer<typeof EspHistorySchema>;
export type LightPatch = z.infer<typeof LightPatchSchema>;
export type CommandResult = z.infer<typeof CommandResultSchema>;
export type EspSnapshot = z.infer<typeof EspSnapshotSchema>;
export type LinkSnapshot<T> = {state:'connecting'|'connected'|'disconnected'|'error';ageMs:number|null;stale:boolean;data:T|null;errorCode:ErrorCode|null};
export type PairResult = z.infer<typeof PairResultSchema>;
export type SetupState = z.infer<typeof SetupStateSchema>;
export type SetupResult = z.infer<typeof SetupResultSchema>;
export type AppStatus = z.infer<typeof AppStatusSchema>;
export type BridgeOp = z.infer<typeof BridgeOpSchema>;
export type BridgeRequest = z.infer<typeof BridgeRequestSchema>;
export type BridgeReply = z.infer<typeof BridgeReplySchema>;
export type BridgeReplyData<O extends BridgeOp> = z.infer<(typeof BridgeReplyDataSchemas)[O]>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
