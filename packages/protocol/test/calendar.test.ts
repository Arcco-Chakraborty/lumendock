import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BridgeRequestSchema, BridgeReplySchema, BridgeReplySchemaFor, CalendarRangeRequestSchema,
  CalendarSourcesRequestSchema, CalendarSelectRequestSchema, CalendarSelectReplySchema,
  CalendarEventSchema, CalendarMomentSchema, CalendarSourceSchema, CalendarPageSchema,
  CalendarSourcesPageSchema, CalendarStateSchema, CalendarErrorCodeSchema, HubSnapshotSchema, ErrorCodeSchema } from '../src/index.js';

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = () => fixture('calendar-page');
const sources = () => fixture('calendar-sources');
const event = () => page().items[0];
const range = () => page().range;
const link = (data: unknown) => ({state:'connected',ageMs:0,stale:false,data,errorCode:null});
const request = (op: string, args: unknown) => ({v:1,id:'synthetic-calendar',op,args});
const success = (data: unknown) => ({v:1,id:'synthetic-calendar',ok:true,data});

describe('Calendar wire contract', () => {
  it('accepts a fixed Calendar read operation without adding data to snapshots', () => {
    expect(BridgeRequestSchema.safeParse(request('hub.calendar',range())).success).toBe(true);
    expect(HubSnapshotSchema.safeParse(fixture('hub-ready')).success).toBe(true);
    expect(HubSnapshotSchema.safeParse({...fixture('hub-ready'),calendar:page()}).success).toBe(false);
  });
  it('parses synthetic pages with a range-global timed Next up summary', () => {
    expect(CalendarPageSchema.parse(page())).toEqual(page());
    expect(CalendarSourcesPageSchema.parse(sources())).toEqual(sources());
    const p = page(); p.items = []; p.sources = [];
    expect(CalendarPageSchema.parse(p).nextEvent?.id).toBe('synthetic_dst_event');
  });
  it.each(['disabled','setup_required','loading','available','partial','auth_required','error','capacity'])('supports state %s', state => {
    expect(CalendarStateSchema.parse(state)).toBe(state);
    expect(CalendarPageSchema.safeParse({...page(),state,items:[],sources:[],nextEvent:null}).success).toBe(true);
  });
  it.each(['CALENDAR_AUTH_REQUIRED','CALENDAR_UNAVAILABLE','CALENDAR_CAPACITY','CALENDAR_CURSOR_EXPIRED','CALENDAR_SELECTION_CHANGED','CALENDAR_UNSUPPORTED'])('supports the safe domain and bridge error %s', code => {
    expect(CalendarErrorCodeSchema.parse(code)).toBe(code);
    expect(ErrorCodeSchema.parse(code)).toBe(code);
    expect(BridgeReplySchemaFor('hub.calendar').safeParse({v:1,id:'synthetic',ok:false,error:{code,retryable:false}}).success).toBe(true);
  });
  it.each(['2026-02-29','2026-04-31','2026-00-01','2026-13-01','0000-01-01','2026-3-08','2026-03-08T00:00:00Z'])('rejects unreal or non-date range %s', startDate => {
    expect(CalendarRangeRequestSchema.safeParse({...range(),startDate}).success).toBe(false);
    expect(CalendarMomentSchema.safeParse({kind:'date',date:startDate}).success).toBe(false);
  });
  it('accepts leap days and real DST zones without converting date-only values', () => {
    expect(CalendarRangeRequestSchema.parse({...range(),startDate:'2024-02-29',days:31,timeZone:'Asia/Kolkata'}).startDate).toBe('2024-02-29');
    expect(CalendarMomentSchema.parse({kind:'date',date:'2026-03-08'})).toEqual({kind:'date',date:'2026-03-08'});
    expect(CalendarEventSchema.parse(event()).start).toEqual({kind:'time',epochMs:1772951400000,timeZone:'America/New_York'});
  });
  it.each(['Mars/Olympus','+05:30','America/New_York/../UTC','x'.repeat(81),''])('rejects invalid display or event zone %s', timeZone => {
    expect(CalendarRangeRequestSchema.safeParse({...range(),timeZone}).success).toBe(false);
    expect(CalendarMomentSchema.safeParse({kind:'time',epochMs:0,timeZone}).success).toBe(false);
  });
  it('bounds ranges, enforces refresh/cursor exclusion, and keeps cursor grammar safe', () => {
    for (const days of [0,32,1.5,NaN,Infinity]) expect(CalendarRangeRequestSchema.safeParse({...range(),days}).success).toBe(false);
    for (const args of [{...range(),refresh:true},{...range(),cursor:'synthetic.2_abc-123~',refresh:false}]) expect(CalendarRangeRequestSchema.safeParse(args).success).toBe(true);
    expect(CalendarRangeRequestSchema.safeParse({...range(),refresh:true,cursor:'synthetic'}).success).toBe(false);
    for (const cursor of ['', 'x'.repeat(257),'https://synthetic.invalid','synthetic@example.invalid','synthetic\nvalue','🔒']) {
      expect(CalendarRangeRequestSchema.safeParse({...range(),cursor}).success).toBe(false);
      expect(CalendarSourcesRequestSchema.safeParse({cursor}).success).toBe(false);
    }
    expect(CalendarSourcesRequestSchema.parse({})).toEqual({});
  });
  it('requires unique bounded opaque selection IDs and revisions within the bridge budget', () => {
    const sourceIds = Array.from({length:100},(_,i)=>`synthetic_${i}_${'x'.repeat(65)}`);
    expect(BridgeRequestSchema.safeParse(request('hub.calendarSelect',{sourceIds,expectedRevision:'synthetic_revision'})).success).toBe(true);
    expect(CalendarSelectRequestSchema.parse({sourceIds:[],expectedRevision:'synthetic'}).sourceIds).toEqual([]);
    for (const ids of [['synthetic','synthetic'],[...sourceIds,'synthetic_overflow'],[''],['x'.repeat(81)],['synthetic@example.invalid'],['https://synthetic.invalid']]) expect(CalendarSelectRequestSchema.safeParse({sourceIds:ids,expectedRevision:'synthetic'}).success).toBe(false);
    for (const expectedRevision of ['', 'x'.repeat(81),'synthetic.bad']) expect(CalendarSelectRequestSchema.safeParse({sourceIds:[],expectedRevision}).success).toBe(false);
    expect(CalendarSelectReplySchema.parse({selectionRevision:'synthetic'})).toEqual({selectionRevision:'synthetic'});
  });
  it('requires matching endpoints and strictly positive durations for timed and all-day rows', () => {
    const e = event();
    expect(CalendarEventSchema.safeParse({...e,start:{kind:'date',date:'2026-03-08'},end:{kind:'date',date:'2026-03-09'}}).success).toBe(true);
    for (const end of [{...e.start},{...e.start,epochMs:e.start.epochMs-1},{kind:'date',date:'2026-03-09'}]) expect(CalendarEventSchema.safeParse({...e,end}).success).toBe(false);
    for (const date of ['2026-03-08','2026-03-07']) expect(CalendarEventSchema.safeParse({...e,start:{kind:'date',date:'2026-03-08'},end:{kind:'date',date}}).success).toBe(false);
  });
  it('retains confirmed-but-declined invitations separately and rejects cancelled events', () => {
    expect(CalendarEventSchema.parse({...event(),selfResponseStatus:'declined'}).status).toBe('confirmed');
    expect(CalendarEventSchema.safeParse({...event(),status:'cancelled'}).success).toBe(false);
    expect(CalendarEventSchema.safeParse({...event(),selfResponseStatus:'unknown'}).success).toBe(false);
    for (const reminderMinutes of [0,40320,null]) expect(CalendarEventSchema.safeParse({...event(),reminderMinutes}).success).toBe(true);
    for (const reminderMinutes of [-1,40321,0.5,Infinity]) expect(CalendarEventSchema.safeParse({...event(),reminderMinutes}).success).toBe(false);
  });
  it('normalizes empty titles, counts Unicode code points, and bounds every display field', () => {
    expect(CalendarEventSchema.parse({...event(),title:''}).title).toBe('Untitled event');
    expect(CalendarEventSchema.parse({...event(),title:'💡'.repeat(256)}).title).toBe('💡'.repeat(256));
    for (const patch of [{title:'💡'.repeat(257)},{calendarName:'a'.repeat(121)},{eventType:'a'.repeat(41)},{label:{name:'a'.repeat(51),color:'#123456'}},{calendarColor:'cyan'},{label:{name:null,color:'invalid'}}]) expect(CalendarEventSchema.safeParse({...event(),...patch}).success).toBe(false);
    expect(CalendarEventSchema.safeParse({...event(),label:{name:null,color:'#aAbB00'},calendarColor:null}).success).toBe(true);
    expect(CalendarSourceSchema.safeParse({...sources().sources[0],name:'a'.repeat(121)}).success).toBe(false);
  });
  it('rejects unsafe epochs and invalid source metadata', () => {
    for (const epochMs of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
      expect(CalendarMomentSchema.safeParse({kind:'time',epochMs,timeZone:'UTC'}).success).toBe(false);
      expect(CalendarPageSchema.safeParse({...page(),serverNowEpochMs:epochMs}).success).toBe(false);
      expect(CalendarSourceSchema.safeParse({...sources().sources[0],lastSuccessAtEpochMs:epochMs}).success).toBe(false);
    }
    for (const patch of [{sourceId:'synthetic@example.invalid'},{capability:'write'},{errorCode:'Google says private details'},{color:'red'}]) expect(CalendarSourceSchema.safeParse({...sources().sources[0],...patch}).success).toBe(false);
  });
  it('rejects page, source enumeration, and count overflow without truncation', () => {
    expect(CalendarPageSchema.safeParse({...page(),items:Array(51).fill(event())}).success).toBe(false);
    const manySources=Array.from({length:51},(_,i)=>({...sources().sources[0],sourceId:`synthetic_${i}`}));
    expect(CalendarPageSchema.safeParse({...page(),sourceCount:51,sources:manySources}).success).toBe(false);
    expect(CalendarSourcesPageSchema.safeParse({...sources(),sources:manySources}).success).toBe(false);
    for (const count of [-1,101,1.5,Infinity]) for (const field of ['sourceCount','failedSourceCount']) expect(CalendarPageSchema.safeParse({...page(),[field]:count}).success).toBe(false);
  });
  it('requires page sources to cover row identities while allowing an off-page Next up source', () => {
    const p=page();
    expect(CalendarPageSchema.safeParse({...p,sources:[]}).success).toBe(false);
    expect(CalendarPageSchema.safeParse({...p,items:[{...event(),sourceId:'synthetic_missing'}]}).success).toBe(false);
    expect(CalendarPageSchema.safeParse({...p,nextEvent:{...event(),sourceId:'synthetic_off_page'}}).success).toBe(true);
  });
  it('requires the Next up summary to be a non-declined timed event still in progress or future', () => {
    const p=page();
    for (const nextEvent of [
      {...event(),start:{kind:'date',date:'2026-03-08'},end:{kind:'date',date:'2026-03-09'}},
      {...event(),selfResponseStatus:'declined'},
      {...event(),start:{...event().start,epochMs:p.serverNowEpochMs-1000},end:{...event().end,epochMs:p.serverNowEpochMs}},
    ]) expect(CalendarPageSchema.safeParse({...p,nextEvent}).success).toBe(false);
  });
  it('enforces 128 KiB serialized UTF-8 budgets on each domain page', () => {
    const e={...event(),title:'\u0000'.repeat(256),calendarName:'\u0000'.repeat(120),label:{name:'\u0000'.repeat(50),color:'#123456'},eventType:'\u0000'.repeat(40)};
    const oversized={...page(),items:Array.from({length:50},(_,i)=>({...e,id:`synthetic_${i}`}))};
    expect(new TextEncoder().encode(JSON.stringify(oversized)).length).toBeGreaterThan(128*1024);
    expect(CalendarPageSchema.safeParse(oversized).success).toBe(false);
  });
  it('rejects extra fields including arbitrary URLs, tokens, and emails at every boundary', () => {
    for (const extra of [{url:'https://synthetic.invalid'},{token:'synthetic-secret'},{email:'synthetic@example.invalid'}]) {
      for (const [schema,value] of [[CalendarRangeRequestSchema,range()],[CalendarSourcesRequestSchema,{}],[CalendarSelectRequestSchema,{sourceIds:[],expectedRevision:'synthetic'}],[CalendarSelectReplySchema,{selectionRevision:'synthetic'}],[CalendarEventSchema,event()],[CalendarSourceSchema,sources().sources[0]],[CalendarPageSchema,page()],[CalendarSourcesPageSchema,sources()] ] as const) expect(schema.safeParse({...value,...extra}).success).toBe(false);
      expect(CalendarMomentSchema.safeParse({...event().start,...extra}).success).toBe(false);
      expect(CalendarEventSchema.safeParse({...event(),label:{...event().label,...extra}}).success).toBe(false);
      expect(CalendarPageSchema.safeParse({...page(),range:{...range(),...extra}}).success).toBe(false);
    }
  });
  it('validates each bridge op against its own args and reply shape', () => {
    const cases=[['hub.calendar',range(),link(page())],['hub.calendarSources',{},link(sources())],['hub.calendarSelect',{sourceIds:[],expectedRevision:'synthetic'},{selectionRevision:'synthetic_next'}]] as const;
    for (const [op,args,data] of cases) {
      expect(BridgeRequestSchema.safeParse(request(op,args)).success).toBe(true);
      expect(BridgeReplySchemaFor(op).safeParse(success(data)).success).toBe(true);
      expect(BridgeReplySchema.safeParse(success(data)).success).toBe(true);
      for (const [otherOp,,otherData] of cases) if (otherOp!==op) expect(BridgeReplySchemaFor(op).safeParse(success(otherData)).success).toBe(false);
    }
    expect(BridgeRequestSchema.safeParse(request('hub.calendarSources',range())).success).toBe(false);
    expect(BridgeRequestSchema.safeParse(request('hub.calendar',{})).success).toBe(false);
    expect(BridgeReplySchemaFor('hub.calendar').safeParse(success({...link(page()),ageMs:null})).success).toBe(false);
  });
});
