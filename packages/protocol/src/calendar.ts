import { z } from 'zod';

const bounded = (max: number) => z.string().refine(value => [...value].length <= max, 'String exceeds code-point budget');
const opaqueId = z.string().max(80).regex(/^[A-Za-z0-9_-]+$/);
// App-owned cursors may contain base64url segments and safe separators, never URLs.
const cursor = z.string().max(256).regex(/^[A-Za-z0-9._~-]+$/);
const epochMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const year = Number(value.slice(0,4));
  const month = Number(value.slice(5,7));
  const day = Number(value.slice(8,10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31][month - 1]!;
}, 'Invalid Gregorian date');
const timeZone = z.string().min(1).max(80).refine(value => {
  // Intl also permits fixed offset strings on recent runtimes; the wire requires IANA names.
  if (/^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', {timeZone:value}); return true; } catch { return false; }
}, 'Invalid IANA time zone');
const rangeFields = {startDate:date,days:z.number().int().min(1).max(31),timeZone};
const range = z.strictObject(rangeFields);
const withPageBudget = <T extends z.ZodType>(schema: T) => schema.superRefine((value,ctx) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 128*1024) {
    ctx.addIssue({code:'custom',message:'Serialized byte budget exceeded'});
  }
});

export const CalendarRangeRequestSchema = z.strictObject({...rangeFields,cursor:cursor.optional(),refresh:z.boolean().optional()})
  .refine(value => !(value.refresh === true && value.cursor !== undefined), 'Refresh cannot use a cursor');
export const CalendarSourcesRequestSchema = z.strictObject({cursor:cursor.optional()});
export const CalendarSelectRequestSchema = z.strictObject({sourceIds:z.array(opaqueId).max(100).refine(ids => new Set(ids).size === ids.length, 'Duplicate source identifiers'),expectedRevision:opaqueId});
export const CalendarErrorCodeSchema = z.enum(['CALENDAR_AUTH_REQUIRED','CALENDAR_UNAVAILABLE','CALENDAR_CAPACITY','CALENDAR_CURSOR_EXPIRED','CALENDAR_SELECTION_CHANGED','CALENDAR_UNSUPPORTED']);
export const CalendarStateSchema = z.enum(['disabled','setup_required','loading','available','partial','auth_required','error','capacity']);
export const CalendarMomentSchema = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('date'),date}),
  z.strictObject({kind:z.literal('time'),epochMs,timeZone}),
]);
export const CalendarEventSchema = z.strictObject({
  id:opaqueId,sourceId:opaqueId,title:bounded(256).transform(value => value === '' ? 'Untitled event' : value),
  start:CalendarMomentSchema,end:CalendarMomentSchema,calendarName:bounded(120),calendarColor:color.nullable(),
  label:z.strictObject({name:bounded(50).nullable(),color}).nullable(),eventType:bounded(40),
  status:z.enum(['confirmed','tentative']),selfResponseStatus:z.enum(['needsAction','declined','tentative','accepted']).nullable(),
  reminderMinutes:z.number().int().min(0).max(40320).nullable(),
}).refine(event => {
  if (event.start.kind === 'date' && event.end.kind === 'date') return event.start.date < event.end.date;
  if (event.start.kind === 'time' && event.end.kind === 'time') return event.start.epochMs < event.end.epochMs;
  return false;
}, 'Event endpoints must have matching kinds and positive duration');
export const CalendarSourceSchema = z.strictObject({
  sourceId:opaqueId,name:bounded(120),color:color.nullable(),selected:z.boolean(),capability:z.enum(['read','busy','unavailable']),
  state:CalendarStateSchema,lastSuccessAtEpochMs:epochMs.nullable(),errorCode:CalendarErrorCodeSchema.nullable(),
});
export const CalendarPageSchema = withPageBudget(z.strictObject({
  v:z.literal(1),state:CalendarStateSchema,errorCode:CalendarErrorCodeSchema.nullable(),serverNowEpochMs:epochMs,
  range,revision:opaqueId,selectionRevision:opaqueId,lastSuccessAtEpochMs:epochMs.nullable(),
  sourceCount:z.number().int().min(0).max(100),failedSourceCount:z.number().int().min(0).max(100),
  sources:z.array(CalendarSourceSchema).max(50),items:z.array(CalendarEventSchema).max(50),
  nextEvent:CalendarEventSchema.nullable(),nextCursor:cursor.nullable(),
}).refine(page => {
  const sourceIds = new Set(page.sources.map(source => source.sourceId));
  return page.items.every(event => sourceIds.has(event.sourceId));
}, 'Page sources must cover event identities').refine(page => {
  const next = page.nextEvent;
  return next === null || (next.start.kind === 'time' && next.end.kind === 'time'
    && next.selfResponseStatus !== 'declined' && next.end.epochMs > page.serverNowEpochMs);
}, 'Next event must be an eligible timed event'));

export const CalendarSourcesPageSchema = withPageBudget(z.strictObject({
  v:z.literal(1),state:CalendarStateSchema,errorCode:CalendarErrorCodeSchema.nullable(),serverNowEpochMs:epochMs,
  selectionRevision:opaqueId,sources:z.array(CalendarSourceSchema).max(50),nextCursor:cursor.nullable(),
}));
export const CalendarSelectReplySchema = z.strictObject({selectionRevision:opaqueId});

export type CalendarRangeRequest = z.infer<typeof CalendarRangeRequestSchema>;
export type CalendarSourcesRequest = z.infer<typeof CalendarSourcesRequestSchema>;
export type CalendarSelectRequest = z.infer<typeof CalendarSelectRequestSchema>;
export type CalendarErrorCode = z.infer<typeof CalendarErrorCodeSchema>;
export type CalendarState = z.infer<typeof CalendarStateSchema>;
export type CalendarMoment = z.infer<typeof CalendarMomentSchema>;
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
export type CalendarSource = z.infer<typeof CalendarSourceSchema>;
export type CalendarPage = z.infer<typeof CalendarPageSchema>;
export type CalendarSourcesPage = z.infer<typeof CalendarSourcesPageSchema>;
export type CalendarSelectReply = z.infer<typeof CalendarSelectReplySchema>;
