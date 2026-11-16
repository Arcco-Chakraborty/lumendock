import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEvent, CalendarPage, CalendarSource } from '@phone-monitor/protocol';
import type { DeviceAdapter } from '../src/device.js';
import { DeviceError } from '../src/device.js';
import { CalendarStore } from '../src/calendar/store.js';
import { addDays, dateInZone, eventDates, eventTime, formatReminder, isToday, nextSummary, sourceDisplayName } from '../src/calendar/time.js';
import { AgendaView } from '../src/components/AgendaView.js';
const now = Date.parse('2026-10-21T10:00:00Z');
export const source: CalendarSource = {sourceId:'synthetic_source',name:'Synthetic calendar',color:null,selected:true,capability:'read',state:'available',lastSuccessAtEpochMs:now,errorCode:null};
export const event: CalendarEvent = {id:'synthetic_event',sourceId:source.sourceId,title:'Synthetic review',calendarName:source.name,calendarColor:null,label:{name:'Focus',color:'#FFCC00'},start:{kind:'time' as const,epochMs:now-60000,timeZone:'UTC'},end:{kind:'time' as const,epochMs:now+60000,timeZone:'UTC'},eventType:'default',status:'confirmed' as const,selfResponseStatus:'accepted' as const,reminderMinutes:10};
export const page = (patch: Partial<CalendarPage> = {}): CalendarPage => ({v:1,state:'available',errorCode:null,serverNowEpochMs:now,range:{startDate:'2026-10-21',days:7,timeZone:'UTC'},revision:'synthetic_r1',selectionRevision:'synthetic_s1',lastSuccessAtEpochMs:now,sourceCount:1,failedSourceCount:0,sources:[source],items:[event],nextEvent:event,nextCursor:null,...patch});
function harness() {
 const calls: Array<{op:string,args:any}> = [];
 const replies: Array<() => Promise<any>> = [];
 const adapter = {request(op:string,args:unknown) {calls.push({op,args}); return replies.shift()?.() ?? Promise.resolve({state:'connected',stale:false,ageMs:0,errorCode:null,data:page()});},dispose(){}} as DeviceAdapter;
 const store = new CalendarStore(adapter,{startDate:'2026-10-21',days:7,timeZone:'UTC'});
 return {calls,replies,store};
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const stores: CalendarStore[]=[];
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{stores.forEach(s=>s.dispose());stores.length=0;vi.useRealTimers();});
function useHarness(){const h=harness();stores.push(h.store);return h;}
describe('calendar range lifecycle',()=>{
 it('rejects a delayed second page after a newer poll replaces its dataset',async()=>{
  const {store,replies}=useHarness();
  const link=(data:CalendarPage)=>({state:'connected',stale:false,ageMs:0,errorCode:null,data});
  replies.push(async()=>link(page({nextCursor:'synthetic_cursor'})));store.setActive(true);await flush();
  let finish!:(x:unknown)=>void;replies.push(()=>new Promise(resolve=>{finish=resolve;}));const pending=store.loadMore();
  replies.push(async()=>link(page({revision:'synthetic_r2',selectionRevision:'synthetic_s2',items:[],nextEvent:null})));
  await vi.advanceTimersByTimeAsync(5000);
  finish(link(page({items:[{...event,id:'synthetic_removed_page2'}]})));await pending;
  expect(store.snapshot().items).toEqual([]);expect(store.snapshot().page?.revision).toBe('synthetic_r2');expect(store.snapshot().selectionRevision).toBe('synthetic_s2');
 });
 it('does not restore deselected rows while the selection reply is pending',async()=>{
  const {store,replies}=useHarness();store.setActive(true);await flush();
  let finish!:(x:unknown)=>void;replies.push(()=>new Promise(resolve=>{finish=resolve;}));const pending=store.selectSources([]);
  await vi.advanceTimersByTimeAsync(5000);expect(store.snapshot().selecting).toBe(true);expect(store.snapshot().items).toEqual([]);expect(store.snapshot().page?.nextEvent).toBeNull();
  finish({selectionRevision:'synthetic_s2'});await pending;
 });
 it.each(['disabled','setup_required'] as const)('purges old enumerated identities on authenticated %s and rejects a late enumeration',async(state)=>{
  const {store,replies}=useHarness();store.setActive(true);await flush();
  const sourcesLink={state:'connected',stale:false,ageMs:0,errorCode:null,data:{v:1,state:'available',errorCode:null,serverNowEpochMs:now,selectionRevision:'synthetic_s1',sources:[source],nextCursor:null}};
  replies.push(async()=>sourcesLink);await store.loadSources();
  let finish!:(x:unknown)=>void;replies.push(()=>new Promise(resolve=>{finish=resolve;}));const pending=store.loadSources();
  replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({state,selectionRevision:'synthetic_new_connection',items:[],sources:[],nextEvent:null})}));
  await vi.advanceTimersByTimeAsync(5000);expect(store.snapshot().sources).toEqual([]);
  finish(sourcesLink);await pending;expect(store.snapshot().sources).toEqual([]);
 });
 it('returns failed Apply as failure and reconciles optimistic rows and checkboxes',async()=>{
  const {store,replies}=useHarness();store.setActive(true);await flush();
  replies.push(async()=>{throw new DeviceError('CALENDAR_SELECTION_CHANGED');});
  expect(await store.selectSources([])).toBe(false);await flush();
  expect(store.snapshot().items).toHaveLength(1);expect(store.snapshot().sources[0]?.selected).toBe(true);expect(store.snapshot().sourcesErrorCode).toBe('CALENDAR_SELECTION_CHANGED');
 });
 it('keeps source sync age separate from a fresh native receipt and retains an ongoing event',async()=>{
  const {store,replies}=useHarness();replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({lastSuccessAtEpochMs:now-60000,nextEvent:{...event,end:{kind:'time',epochMs:now+30000,timeZone:'UTC'}}})}));
  store.setActive(true);await flush();expect(store.snapshot().nowEpochMs).toBe(now);expect(store.snapshot().ageMs).toBe(60000);expect(store.snapshot().stale).toBe(false);
  expect(renderToStaticMarkup(createElement(AgendaView,{store,laptopConnected:true}))).toContain('Now');
 });
 it('only reads while active and visible, preserving session rows on tab switches',async()=>{const {store,calls}=useHarness(); await vi.advanceTimersByTimeAsync(5000);expect(calls).toHaveLength(0);store.setActive(true);await flush();expect(store.snapshot().items).toHaveLength(1);store.setActive(false);await vi.advanceTimersByTimeAsync(10000);expect(calls).toHaveLength(1);expect(store.snapshot().items).toHaveLength(1);store.setVisible(false);store.setActive(true);expect(calls).toHaveLength(1);store.setVisible(true);await flush();expect(calls).toHaveLength(2);});
 it('uses the whole-range nextEvent even when absent from the loaded first page',async()=>{const {store,replies}=useHarness();replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({items:[],nextCursor:'synthetic_cursor'})}));store.setActive(true);await flush();expect(store.snapshot().items).toEqual([]);expect(store.snapshot().page?.nextEvent?.id).toBe('synthetic_event');});
 it('retains cached rows and advances server time when USB fails',async()=>{const {store,replies}=useHarness();store.setActive(true);await flush();replies.push(async()=>{throw new DeviceError('USB_UNAVAILABLE');});await vi.advanceTimersByTimeAsync(5000);expect(store.snapshot().items).toHaveLength(1);expect(store.snapshot().offline).toBe(true);expect(store.snapshot().nowEpochMs).toBeGreaterThanOrEqual(now+5000);});
 it('resets cursor and obsolete pending data on date changes',async()=>{const {store,replies,calls}=useHarness();let finish!: (x:unknown)=>void;replies.push(()=>new Promise(resolve=>{finish=resolve;}));store.setActive(true);store.setRange({startDate:'2026-10-28',days:1,timeZone:'UTC'});finish({state:'connected',stale:false,ageMs:0,errorCode:null,data:page()});await flush();await flush();expect(calls.at(-1)?.args).toEqual({startDate:'2026-10-28',days:1,timeZone:'UTC'});expect(store.snapshot().range.startDate).toBe('2026-10-28');expect(store.snapshot().items).toEqual([]);});
 it('appends pages only within the same revision and resets an expired cursor',async()=>{const {store,replies,calls}=useHarness();replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({nextCursor:'synthetic_cursor'})}));store.setActive(true);await flush();replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({items:[{...event,id:'synthetic_second'}],nextCursor:null})}));await store.loadMore();expect(store.snapshot().items.map(x=>x.id)).toEqual(['synthetic_event','synthetic_second']);expect(calls.at(-1)?.args.cursor).toBe('synthetic_cursor');replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({revision:'synthetic_r2',items:[]})}));await store.refresh();expect(store.snapshot().items).toEqual([]);expect(calls.at(-1)?.args).toEqual({startDate:'2026-10-21',days:7,timeZone:'UTC',refresh:true});});
 it('restarts from page one when loadMore encounters an expired cursor or changed revision',async()=>{const {store,replies,calls}=useHarness();replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({nextCursor:'synthetic_cursor'})}));store.setActive(true);await flush();replies.push(async()=>{throw new DeviceError('CALENDAR_CURSOR_EXPIRED');},async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({revision:'synthetic_r2',items:[{...event,id:'synthetic_fresh'}],nextCursor:null})}));await store.loadMore();await flush();expect(calls.at(-1)?.args).toEqual({startDate:'2026-10-21',days:7,timeZone:'UTC'});expect(store.snapshot().items.map(x=>x.id)).toEqual(['synthetic_fresh']);expect(store.snapshot().nextCursor).toBeNull();});
 it('clears removed rows before selecting, and ignores a late page from the previous selection',async()=>{const {store,replies}=useHarness();store.setActive(true);await flush();let finish!: (x:unknown)=>void;replies.push(()=>new Promise(resolve=>{finish=resolve;}));const pending=store.refresh();replies.push(async()=>({selectionRevision:'synthetic_s2'}));const selecting=store.selectSources([]);expect(store.snapshot().items).toEqual([]);await selecting;finish({state:'connected',stale:false,ageMs:0,errorCode:null,data:page()});await pending;await flush();expect(store.snapshot().items).toEqual([]);});
 it('clears private cached rows on an authenticated disconnect or reconnect setup state',async()=>{const {store,replies}=useHarness();store.setActive(true);await flush();replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({state:'disabled',items:[],nextEvent:null})}));await store.refresh();expect(store.snapshot().items).toEqual([]);expect(store.snapshot().page?.state).toBe('disabled');});
 it('enumerates all source pages and requires Apply before rendering setup events',async()=>{const {store,replies}=useHarness();replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({state:'setup_required',items:[],nextEvent:null})}));store.setActive(true);await flush();replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:{v:1,state:'setup_required',errorCode:null,serverNowEpochMs:now,selectionRevision:'synthetic_s1',sources:[source],nextCursor:'sources_next'}}),async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:{v:1,state:'setup_required',errorCode:null,serverNowEpochMs:now,selectionRevision:'synthetic_s1',sources:[{...source,sourceId:'synthetic_other'}],nextCursor:null}}));await store.loadSources();expect(store.snapshot().sources).toHaveLength(2);expect(store.snapshot().items).toEqual([]);});
 it('reports old hub unsupported independently',async()=>{const {store,replies}=useHarness();replies.push(async()=>{throw new DeviceError('CALENDAR_UNSUPPORTED');});store.setActive(true);await flush();expect(store.snapshot().errorCode).toBe('CALENDAR_UNSUPPORTED');});
 it('rebases a shifted range on setToday and rolls over across local midnight',async()=>{const {store,replies,calls}=useHarness();store.setActive(true);await flush();store.setRange({startDate:'2026-11-01',days:7,timeZone:'UTC'});await flush();expect(store.snapshot().range.startDate).toBe('2026-11-01');replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({serverNowEpochMs:Date.parse('2026-10-21T23:59:58Z')})}));store.setToday();await flush();expect(store.snapshot().range.startDate).toBe('2026-10-21');await vi.advanceTimersByTimeAsync(5000);await flush();expect(store.snapshot().range.startDate).toBe('2026-10-22');expect(calls.at(-1)?.args).toEqual({startDate:'2026-10-22',days:7,timeZone:'UTC'});});
});
describe('calendar date presentation',()=>{
 it('keeps date-only spans exclusive through DST boundaries',()=>{const allDay={...event,start:{kind:'date' as const,date:'2026-03-07'},end:{kind:'date' as const,date:'2026-03-10'}};expect(eventDates(allDay,'America/New_York')).toEqual(['2026-03-07','2026-03-09']);expect(eventTime(allDay,'America/New_York')).toBe('All day');expect(isToday(allDay,'2026-03-09','America/New_York')).toBe(true);expect(isToday(allDay,'2026-03-10','America/New_York')).toBe(false);expect(addDays('2026-03-08',1)).toBe('2026-03-09');});
 it('renders timed DST and overnight instants in the requested zone',()=>{expect(dateInZone(Date.parse('2026-03-08T04:30:00Z'),'America/New_York')).toBe('2026-03-07');const dst={...event,start:{kind:'time' as const,epochMs:Date.parse('2026-03-08T06:30:00Z'),timeZone:'America/New_York'},end:{kind:'time' as const,epochMs:Date.parse('2026-03-08T07:30:00Z'),timeZone:'America/New_York'}};expect(eventTime(dst,'America/New_York')).toContain('1:30');expect(eventTime(dst,'America/New_York')).toContain('3:30');});
 it('shows Now with end time, rejects ended/all-day/self-declined summaries',()=>{expect(nextSummary(event,now,'UTC')).toContain('Now');expect(nextSummary(event,now,'UTC')).toContain('10:01');expect(nextSummary(event,now+60000,'UTC')).toBeNull();expect(nextSummary({...event,selfResponseStatus:'declined'},now,'UTC')).toBeNull();expect(nextSummary({...event,start:{kind:'time',epochMs:now+60000,timeZone:'UTC'},end:{kind:'time',epochMs:now+120000,timeZone:'UTC'}},now,'UTC')).toContain('10:01');});
 it('disambiguates duplicate source names and formats reminders cleanly',()=>{const dupA={...source,sourceId:'cal_team_alpha',name:'Team'};const dupB={...source,sourceId:'cal_team_bravo',name:'Team'};expect(sourceDisplayName(dupA,[dupA,dupB])).not.toBe(sourceDisplayName(dupB,[dupA,dupB]));expect(formatReminder(10)).toBe('Reminder 10 min before');expect(formatReminder(0)).toBe('Reminder at start');});
});
describe('agenda view states and badges',()=>{
 it('renders the actual requested range even when server today differs or the view remounts',async()=>{
  const {store,replies}=useHarness();replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({serverNowEpochMs:Date.parse('2026-10-22T10:00:00Z')})}));store.setActive(true);await flush();
  expect(renderToStaticMarkup(createElement(AgendaView,{store,laptopConnected:true}))).toContain('Oct 21 to Oct 27');
  store.setRange({startDate:'2026-11-01',days:3,timeZone:'UTC'});store.setActive(false);
  expect(renderToStaticMarkup(createElement(AgendaView,{store,laptopConnected:true}))).toContain('Nov 1 to Nov 3');
 });
 it('groups an ongoing spanning all-day event on the first visible occupied day',async()=>{
  const {store,replies}=useHarness();const span={...event,start:{kind:'date' as const,date:'2026-10-20'},end:{kind:'date' as const,date:'2026-10-24'}};
  replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({items:[span],nextEvent:null})}));store.setActive(true);await flush();
  const html=renderToStaticMarkup(createElement(AgendaView,{store,laptopConnected:true}));expect(html).toContain('Today · Wed, Oct 21');expect(html).not.toContain('Fri, Oct 23');
 });
 it('shows label fallback guidance without hiding partial event rows or claiming hub incompatibility',async()=>{
  const {store,replies}=useHarness();replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({state:'partial',errorCode:'CALENDAR_UNSUPPORTED',sources:[{...source,state:'partial',errorCode:'CALENDAR_UNSUPPORTED'}]})}));store.setActive(true);await flush();
  const html=renderToStaticMarkup(createElement(AgendaView,{store,laptopConnected:true}));expect(html).toContain('Synthetic review');expect(html).toMatch(/label.*unavailable/i);expect(html).not.toContain('Calendar unavailable on this hub version');
 });
 it('renders distinct labelled, unnamed-label, unlabelled, all-day and self-declined events',async()=>{
  const unnamed={...event,id:'synthetic_unnamed',title:'Synthetic unnamed label',label:{name:null,color:'#00AA88'}};
  const unlabelled={...event,id:'synthetic_plain',title:'Synthetic plain event',label:null};
  const declined={...event,id:'synthetic_declined',title:'Synthetic declined invite',selfResponseStatus:'declined' as const};
  const allDay={...event,id:'synthetic_allday',title:'Synthetic milestone',start:{kind:'date' as const,date:'2026-10-21'},end:{kind:'date' as const,date:'2026-10-22'},label:null};
  const {store,replies}=useHarness();
  replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({items:[allDay,event,unnamed,unlabelled,declined],nextEvent:event})}));
  store.setActive(true);await flush();
  const html=renderToStaticMarkup(createElement(AgendaView,{store,laptopConnected:true}));
  expect(html).toContain('Next up');
  expect(html).toContain('Focus');
  expect(html).toContain('Labelled');
  expect(html).toContain('Synthetic calendar');
  expect(html).toContain('All day');
  expect(html).toContain('Declined');
  expect(html).not.toContain('style=');
 });
 it('distinguishes setup_required, disabled CLI setup, auth_required, partial, capacity and old-hub unsupported states',async()=>{
  const {store,replies}=useHarness();
  replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({state:'disabled',items:[],nextEvent:null})}));
  store.setActive(true);await flush();
  const disabledHtml=renderToStaticMarkup(createElement(AgendaView,{store,laptopConnected:true}));
  expect(disabledHtml).toContain('node desktop/dist/main.js calendar connect --client');
  replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({state:'setup_required',items:[],nextEvent:null,sources:[source,{...source,sourceId:'synthetic_partial_src',name:'Synthetic partial',state:'partial',errorCode:'CALENDAR_UNSUPPORTED'}]})}));
  await store.refresh();
  const setupHtml=renderToStaticMarkup(createElement(AgendaView,{store,laptopConnected:true}));
  expect(setupHtml).toContain('Apply calendars');
  expect(setupHtml).toContain('Readable · events');
  expect(setupHtml).toContain('Readable · labels unavailable');
  expect(setupHtml).not.toContain('Readable · events and labels');
  replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({state:'auth_required',errorCode:'CALENDAR_AUTH_REQUIRED',items:[],nextEvent:null})}));
  await store.refresh();
  expect(renderToStaticMarkup(createElement(AgendaView,{store,laptopConnected:true}))).toContain('authorization');
  replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({state:'partial',errorCode:'CALENDAR_UNAVAILABLE',failedSourceCount:1,sourceCount:2})}));
  await store.refresh();
  expect(renderToStaticMarkup(createElement(AgendaView,{store,laptopConnected:true}))).toContain('Partial');
  replies.push(async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:page({state:'capacity',errorCode:'CALENDAR_CAPACITY',items:[],nextEvent:null})}));
  await store.refresh();
  expect(renderToStaticMarkup(createElement(AgendaView,{store,laptopConnected:true}))).toContain('capacity');
  replies.push(async()=>{throw new DeviceError('CALENDAR_UNSUPPORTED');});
  await store.refresh();
  expect(renderToStaticMarkup(createElement(AgendaView,{store,laptopConnected:true}))).toContain('Update the LumenDock desktop hub');
 });
});
