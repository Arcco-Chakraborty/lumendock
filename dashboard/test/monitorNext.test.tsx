import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CalendarEvent, CalendarPage } from '@phone-monitor/protocol';
import { CalendarStore } from '../src/calendar/store.js';
import { MonitorNextEvent } from '../src/components/MonitorNextEvent.js';
import type { DeviceAdapter } from '../src/device.js';
const NOW = Date.parse('2026-10-23T10:00:00Z');
const event: CalendarEvent = { id:'synthetic_next', sourceId:'synthetic_source', title:'Synthetic whole-range next', calendarName:'Synthetic work', calendarColor:'#22D3EE', label:{ name:'Focus', color:'#A3B7FA' }, start:{kind:'time',epochMs:NOW+1800_000,timeZone:'UTC'}, end:{kind:'time',epochMs:NOW+3600_000,timeZone:'UTC'}, eventType:'default', status:'confirmed', selfResponseStatus:'accepted', reminderMinutes:10 };
const calendarPage = (patch: Partial<CalendarPage> = {}): CalendarPage => ({v:1,state:'available',errorCode:null,serverNowEpochMs:NOW,range:{startDate:'2026-10-23',days:7,timeZone:'UTC'},revision:'synthetic_r1',selectionRevision:'synthetic_s1',lastSuccessAtEpochMs:NOW,sourceCount:1,failedSourceCount:0,sources:[],items:[{...event,id:'synthetic_first',title:'Synthetic first-page event'}],nextEvent:event,nextCursor:'synthetic_cursor',...patch});
const stores:CalendarStore[]=[];
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{stores.forEach(store=>store.dispose());stores.length=0;vi.useRealTimers();});
async function renderPage(patch:Partial<CalendarPage> = {}, props:{laptopConnected?:boolean;unpaired?:boolean}={}) {
 const adapter={request:async()=>({state:'connected',stale:false,ageMs:0,errorCode:null,data:calendarPage(patch)}),dispose(){}} as DeviceAdapter;
 const store=new CalendarStore(adapter,{startDate:'2026-10-23',days:7,timeZone:'UTC'});stores.push(store);await store.refresh();
 return renderToStaticMarkup(<MonitorNextEvent store={store} laptopConnected onOpenAgenda={()=>{}} {...props}/>);
}
it('renders only the server whole-range nextEvent with time, zone, source and label',async()=>{
 const html=await renderPage();expect(html).toContain('Synthetic whole-range next');expect(html).not.toContain('Synthetic first-page event');
 expect(html).toContain('10:30 AM');expect(html).toContain('UTC');expect(html).toContain('Focus');expect(html).toContain('Synthetic work');expect(html).not.toContain('style=');
});
it.each([
 ['tomorrow',86400_000,'Tomorrow'],['later',3*86400_000,'Oct 26'],['ongoing',-1800_000,'Now'],
] as const)('makes %s timing unambiguous',async(_,offset,want)=>{
 const html=await renderPage({nextEvent:{...event,start:{kind:'time',epochMs:NOW+offset,timeZone:'UTC'},end:{kind:'time',epochMs:NOW+offset+3600_000,timeZone:'UTC'}}});expect(html).toContain(want);
});
it.each([
 ['expired',{...event,end:{kind:'time' as const,epochMs:NOW,timeZone:'UTC'}}],
 ['declined',{...event,selfResponseStatus:'declined' as const}],
 ['all-day',{...event,start:{kind:'date' as const,date:'2026-10-23'},end:{kind:'date' as const,date:'2026-10-24'}}],
] as const)('never shows an ineligible %s candidate',async(_,candidate)=>{
 const html=await renderPage({nextEvent:candidate});expect(html).not.toContain(event.title);expect(html).toContain('No upcoming timed events in the next 7 days');
});
it.each([
 ['disabled','Connect Google Calendar'],['setup_required','Choose calendars in Agenda'],['auth_required','Reconnect Google Calendar'],['capacity','Calendar capacity reached'],['error','Calendar unavailable'],['loading','Loading calendar'],
] as const)('does not leak cached candidate in %s state',async(state,want)=>{
 const html=await renderPage({state});expect(html).not.toContain(event.title);expect(html).toContain(want);
});
it('distinguishes incomplete and stale results from an empty successful window',async()=>{
 expect(await renderPage({state:'partial',nextEvent:null,failedSourceCount:1})).toContain('Some calendars unavailable');
 const html=await renderPage({state:'partial',failedSourceCount:1},{laptopConnected:false});expect(html).toContain(event.title);expect(html).toContain('Offline');expect(html).toContain('Partial');
 expect(await renderPage({lastSuccessAtEpochMs:NOW-200_000})).toContain('Stale');
 expect(await renderPage({}, {unpaired:true})).not.toContain(event.title);
});
it('keeps unnamed-label and unlabelled calendar identities readable',async()=>{
 expect(await renderPage({nextEvent:{...event,label:{name:null,color:'#A3B7FA'}}})).toContain('Labelled');
 expect(await renderPage({nextEvent:{...event,label:null}})).toContain('Synthetic work');
});
it('invalidating a superseded calendar context rejects a delayed reply without changing its date range', async () => {
 let complete!: (value: unknown) => void;
 const adapter = { request: () => new Promise<unknown>(resolve => { complete = resolve; }), dispose() {} } as unknown as DeviceAdapter;
 const store = new CalendarStore(adapter, { startDate:'2026-10-23', days:7, timeZone:'UTC' });
 stores.push(store);
 const read = store.refresh();
 store.invalidate();
 complete({ state:'connected', stale:false, ageMs:0, errorCode:null, data:calendarPage() });
 await read;
 expect(store.snapshot().page).toBeNull();
 expect(store.snapshot().items).toEqual([]);
 expect(store.snapshot().range).toEqual({ startDate:'2026-10-23', days:7, timeZone:'UTC' });
});
