import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeClaude, normalizeClaude, ClaudeObservationStore } from '../src/collectors/claude.js';
const report = (api:number, used:number|null=42, extra:Record<string,unknown>={}) => ({session_id:'synthetic-A',cost:{total_api_duration_ms:api},rate_limits:{five_hour:used===null?null:{used_percentage:used,resets_at:100},seven_day:{used_percentage:105.25,resets_at:900000}},...extra});
describe('Claude report classification',()=>{
 it('distinguishes zero, missing and fractional over-limit values',()=>{
  const p=normalizeClaude(report(1,0),{nowMs:1000,lastSuccessMs:1000});
  expect(p.windows.map(w=>w.usedPercent)).toEqual([0,105.25]);
  expect(normalizeClaude({rate_limits:{seven_day:{used_percentage:17.25}}},{nowMs:1,lastSuccessMs:null}).windows).toMatchObject([{windowId:'seven_day',usedPercent:17.25,resetsAtEpochSec:null,reportedAtEpochMs:null}]);
 });
 it('does not turn a timer rerun into a fresh report',()=>{
  const baseline=observeClaude(report(0,null),null,0);
  const first=observeClaude(report(100),baseline,1000);
  const timer=observeClaude(report(100),first,400000);
  expect(timer.public.observedAtEpochMs).toBe(1000); expect(timer.public.stale).toBe(true);
 });
 it('keeps expiry-only rows and their original report age',()=>{
  const base=observeClaude(report(0,null),null,0);
  const first=observeClaude(report(100),base,1000);
  const expired=observeClaude({...report(100),rate_limits:{}},first,900000001);
  expect(expired.public.observedAtEpochMs).toBe(1000);
  expect(expired.public.windows.map(w=>w.reportedAtEpochMs)).toEqual([1000,1000]);
  const week=observeClaude({...report(100),rate_limits:{seven_day:{used_percentage:51,resets_at:990000}}},expired,900000002);
  expect(week.public.windows.map(w=>w.reportedAtEpochMs)).toEqual([1000,900000002]);
 });
 it('treats first-seen cache conservatively and only API changes as response evidence',()=>{
  const first=observeClaude(report(100),null,1000);
  expect(first.public.observedAtEpochMs).toBeNull(); expect(first.public.stale).toBe(true);
  expect(observeClaude({...report(100),cost:{total_api_duration_ms:100,total_duration_ms:5000}},first,2000).public.observedAtEpochMs).toBeNull();
  expect(observeClaude(report(101),first,3000).public.observedAtEpochMs).toBe(3000);
 });
 it('does not invent initially absent windows and rejects invalid supplied fields',()=>{
  expect(observeClaude({session_id:'synthetic'},null,0).public.windows).toEqual([]);
  expect(()=>normalizeClaude(report(1,-1),{nowMs:1,lastSuccessMs:1})).toThrow('BAD_PAYLOAD');
  expect(()=>normalizeClaude(report(1,NaN),{nowMs:1,lastSuccessMs:1})).toThrow('BAD_PAYLOAD');
 });
 it('arbitrates sessions under a persistent genuine ordinal and bounds private state',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'phone-monitor-claude-'));
  const store=new ClaudeObservationStore(dir);
  await store.capture(report(0,null),0); await store.capture(report(1),1000);
  await store.capture(report(0,null,{session_id:'synthetic-B'}),2000);
  await store.capture(report(1,51,{session_id:'synthetic-B'}),3000);
  await store.capture(report(1),4000);
  expect(store.read(4000)?.windows[0]?.usedPercent).toBe(51);
  expect(new ClaudeObservationStore(dir).read(5000)?.observedAtEpochMs).toBe(3000);
  for(let i=0;i<40;i++) await store.capture(report(0,1,{session_id:`synthetic-${i}`}),6000+i);
  const raw=readFileSync(join(dir,'claude-observations.json'),'utf8');
  expect(Object.keys(JSON.parse(raw).sessions)).toHaveLength(32);
  expect(raw).not.toContain('synthetic-');
  expect(statSync(join(dir,'claude-observations.json')).mode&0o777).toBe(0o600);
 });
 it('serializes only public whitelist data and preserves reload time',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'phone-monitor-private-'));
  const a=new ClaudeObservationStore(dir);
  await a.capture({...report(0),transcript_path:'/synthetic/private',notification:'synthetic secret'},1);
  await a.capture(report(1),2);
  const source=new ClaudeObservationStore(dir).read(999999);
  expect(source?.observedAtEpochMs).toBe(2); expect(source?.stale).toBe(true);
  expect(JSON.stringify(source)).not.toMatch(/session|ordinal|api|transcript|secret/);
  expect(readFileSync(join(dir,'claude-observations.json'),'utf8')).not.toContain('private');
 });
});
it('ignores disappearing API counters and keeps the winning genuine report through cache-session churn',async()=>{
 const baseline=observeClaude(report(0,null),null,0);const first=observeClaude(report(1),baseline,1000);
 const missing=observeClaude({...report(1),cost:{}},first,2000);expect(missing.public.observedAtEpochMs).toBe(1000);
 const dir=mkdtempSync(join(tmpdir(),'phone-monitor-churn-'));const store=new ClaudeObservationStore(dir);
 await store.capture(report(0,null),0);await store.capture(report(1),1000);
 for(let i=0;i<40;i++)await store.capture(report(0,1,{session_id:`synthetic-cache-${i}`}),2000+i);
 expect(store.read(5000)?.observedAtEpochMs).toBe(1000);
 expect(store.read(5000)?.windows[0]?.usedPercent).toBe(42);
 await store.capture(report(0,1,{session_id:'synthetic-next-day'}),86405000);
 expect(store.read(86405000)?.observedAtEpochMs).toBeNull();
});
it('accepts the synthetic documented statusline fixture without forwarding private extra fields',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/claude-statusline.json',import.meta.url),'utf8'));
 const p=normalizeClaude(fixture,{nowMs:1000,lastSuccessMs:1000});expect(p.windows.map(w=>w.usedPercent)).toEqual([0,125.5]);expect(JSON.stringify(p)).not.toMatch(/transcript|workspace|model|cost|duration_ms/);
});
