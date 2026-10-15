import { describe,it,expect,vi,afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { normalizeCodex, CodexCollector } from '../src/collectors/codex.js';
import { HubStore } from '../src/store.js';
export const fixture=(bucket='custom',duration=45,used=17.25)=>({rateLimitsByLimitId:{[bucket]:{limitId:bucket,primary:{usedPercent:used,windowDurationMins:duration,resetsAt:1900000000},secondary:null}}});
class FakeChild extends EventEmitter {
 stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();pid=undefined; killed=false;
 requests:any[]=[];
 constructor(public mode='ok') {super();let buf='';this.stdin.on('data',chunk=>{buf+=chunk;let at;while((at=buf.indexOf('\n'))>=0){const req=JSON.parse(buf.slice(0,at));buf=buf.slice(at+1);this.requests.push(req);if(!('id'in req)||mode==='timeout')continue;const result=req.method==='initialize'?{}:req.method==='account/read'?{account:mode==='auth'?null:{type:'chatgpt'},requiresOpenaiAuth:true}:fixture();queueMicrotask(()=>this.stdout.write(JSON.stringify({id:req.id,result})+'\n'));}}); }
 kill(){this.killed=true;queueMicrotask(()=>this.emit('exit',0,null));return true;}
}
afterEach(()=>vi.useRealTimers());
describe('Codex normalization and read-only lifecycle',()=>{
 it('uses dynamic durations and every bucket, and supports legacy',()=>{
  const p=normalizeCodex(fixture(),{nowMs:1000,lastSuccessMs:1000});
  expect(p.windows[0]).toMatchObject({bucketId:'custom',windowDurationMins:45,usedPercent:17.25});
  expect(normalizeCodex({rateLimits:{limitId:null,primary:{usedPercent:0,windowDurationMins:null,resetsAt:null}}},{nowMs:1,lastSuccessMs:1}).windows[0]?.usedPercent).toBe(0);
  expect(normalizeCodex({rateLimitsByLimitId:{...fixture('a').rateLimitsByLimitId,...fixture('b').rateLimitsByLimitId}},{nowMs:1,lastSuccessMs:1}).windows).toHaveLength(2);
 });
 it('rejects negative/non-finite and millisecond resets rather than manufacturing zero',()=>{
  expect(()=>normalizeCodex(fixture('a',5,-1),{nowMs:1,lastSuccessMs:1})).toThrow('BAD_PAYLOAD');
  expect(()=>normalizeCodex({rateLimits:{primary:{usedPercent:1,resetsAt:1900000000000}}},{nowMs:1,lastSuccessMs:1})).toThrow('BAD_PAYLOAD');
 });
 it('explicitly reports capacity overflow and preserves last good state',async()=>{
  const child=new FakeChild();const store=new HubStore();const c=new CodexCollector({store,spawn:()=>child as any,verifyVersion:async()=> 'codex-cli 0.162.0-alpha.17.2',nowMs:()=>1000});
  await c.start();await vi.waitFor(()=>expect(store.snapshot(1000).usage.codex.state).toBe('available'));
  const buckets=Object.fromEntries(Array.from({length:63},(_,i)=>[`bucket-${i}`,fixture().rateLimitsByLimitId.custom]));
  child.stdout.write(JSON.stringify({method:'account/rateLimits/updated',params:{rateLimitsByLimitId:buckets}})+'\n');
  await vi.waitFor(()=>expect(store.snapshot(1000).usage.codex.errorCode).toBe('SOURCE_CAPACITY_EXCEEDED'));
  expect(store.snapshot(1000).usage.codex.windows[0]?.usedPercent).toBe(17.25);await c.stop();
 });
 it('handshakes in order, correlates typed IDs, merges updates and never creates turns',async()=>{
  const child=new FakeChild();const store=new HubStore();let now=1000;
  const c=new CodexCollector({store,spawn:()=>child as any,verifyVersion:async()=> 'codex-cli 0.162.0-alpha.17.2',nowMs:()=>now});
  await c.start();await vi.waitFor(()=>expect(store.snapshot(now).usage.codex.windows).toHaveLength(1));
  expect(child.requests.map(r=>r.method)).toEqual(['initialize','initialized','account/read','account/rateLimits/read']);
  expect(child.requests[2].params).toEqual({refreshToken:false});
  now=2000; child.stdout.write(JSON.stringify({method:'account/rateLimits/updated',params:{rateLimits:{limitId:'other',primary:{usedPercent:12,windowDurationMins:7,resetsAt:1900000000}}}})+'\n');
  await vi.waitFor(()=>expect(store.snapshot(now).usage.codex.windows).toHaveLength(2));
  expect(store.snapshot(now).usage.codex.lastSuccessAtEpochMs).toBe(1000);
  expect(store.snapshot(now).usage.codex.observedAtEpochMs).toBe(2000);
  child.stdout.write('{"id":"3","result":{}}\n');
  await c.stop();expect(child.killed).toBe(true);
 });
 it('reports auth-required without issuing quota reads and rejects unsupported versions',async()=>{
  const child=new FakeChild('auth');const store=new HubStore();const c=new CodexCollector({store,spawn:()=>child as any,verifyVersion:async()=> 'codex-cli 0.162.0-alpha.17.2'});
  await c.start();await vi.waitFor(()=>expect(store.snapshot(Date.now()).usage.codex.state).toBe('auth_required'));
  expect(child.requests.map(r=>r.method)).toEqual(['initialize','initialized','account/read']);await c.stop();
  const c2=new CodexCollector({store,spawn:()=>{throw Error('must not spawn');},verifyVersion:async()=> 'unknown'});await c2.start();expect(store.snapshot(Date.now()).usage.codex.state).toBe('unsupported');await c2.stop();
 });
 it('times out handshakes and bounds malformed/oversized lines with sanitized state',async()=>{
  vi.useFakeTimers();const child=new FakeChild('timeout');const store=new HubStore();const c=new CodexCollector({store,spawn:()=>child as any,verifyVersion:async()=> 'codex-cli 0.162.0-alpha.17.2'});
  await c.start();await vi.advanceTimersByTimeAsync(10001);expect(store.snapshot(Date.now()).usage.codex.errorCode).toBe('REQUEST_TIMEOUT');expect(child.killed).toBe(true);await c.stop();
 });
});
it('uses jittered active cadence, one in-flight read and full-read reconciliation',async()=>{
 vi.useFakeTimers();const child=new FakeChild();const store=new HubStore();store.markPhoneActivity(100);
 const c=new CodexCollector({store,spawn:()=>child as any,verifyVersion:async()=> 'codex-cli 0.162.0-alpha.17.2',nowMs:()=>Date.now(),monotonicMs:()=>100,jitter:()=>0});
 await c.start();await vi.advanceTimersByTimeAsync(0);
 child.stdout.write(JSON.stringify({method:'account/rateLimits/updated',params:fixture('other')})+'\n');await vi.advanceTimersByTimeAsync(0);expect(store.snapshot(Date.now()).usage.codex.windows).toHaveLength(2);
 await vi.advanceTimersByTimeAsync(53999);expect(child.requests.filter(r=>r.method==='account/rateLimits/read')).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(1);expect(child.requests.filter(r=>r.method==='account/rateLimits/read')).toHaveLength(2);expect(store.snapshot(Date.now()).usage.codex.windows).toHaveLength(1);
 c.retry();c.retry();c.retry();await vi.advanceTimersByTimeAsync(0);expect(child.requests.filter(r=>r.method==='account/rateLimits/read')).toHaveLength(3);
 await c.stop();
});
it('rejects malformed/oversized child lines without forwarding stderr and restarts with backoff',async()=>{
 vi.useFakeTimers();const children:FakeChild[]=[];const store=new HubStore();const c=new CodexCollector({store,spawn:()=>{const child=new FakeChild();children.push(child);return child as any;},verifyVersion:async()=> 'codex-cli 0.162.0-alpha.17.2'});
 await c.start();await vi.advanceTimersByTimeAsync(0);children[0]!.stderr.write('synthetic private account details');children[0]!.stdout.write('{bad JSON}\n');
 expect(store.snapshot(Date.now()).usage.codex.errorCode).toBe('BAD_PAYLOAD');expect(JSON.stringify(store.snapshot(Date.now()))).not.toContain('private');
 await vi.advanceTimersByTimeAsync(999);expect(children).toHaveLength(1);await vi.advanceTimersByTimeAsync(1);expect(children).toHaveLength(2);await vi.advanceTimersByTimeAsync(0);
 children[1]!.stdout.write('x'.repeat(256*1024+1));expect(store.snapshot(Date.now()).usage.codex.errorCode).toBe('BAD_PAYLOAD');await c.stop();
});
it('rechecks compatibility after a failed version probe instead of spawning unchecked',async()=>{
 vi.useFakeTimers();let verified=false,attempts=0,spawns=0;const store=new HubStore();const c=new CodexCollector({store,verifyVersion:async()=>{attempts++;if(!verified)throw Error('synthetic unavailable');return 'codex-cli 0.162.0-alpha.17.2';},spawn:()=>{spawns++;return new FakeChild() as any;}});
 await c.start();await vi.advanceTimersByTimeAsync(1001);expect(spawns).toBe(0);verified=true;c.retry();await vi.advanceTimersByTimeAsync(0);expect(attempts).toBeGreaterThan(1);expect(spawns).toBe(1);await c.stop();
});
it('switches idle polling to active cadence when the phone becomes active',async()=>{
 vi.useFakeTimers();const child=new FakeChild();const store=new HubStore();let mono=0;const c=new CodexCollector({store,spawn:()=>child as any,verifyVersion:async()=> 'codex-cli 0.162.0-alpha.17.2',monotonicMs:()=>mono,jitter:()=>0.5});
 await c.start();await vi.advanceTimersByTimeAsync(0);mono=1000;store.markPhoneActivity(mono);await vi.advanceTimersByTimeAsync(1000);await vi.advanceTimersByTimeAsync(60000);
 expect(child.requests.filter(r=>r.method==='account/rateLimits/read')).toHaveLength(2);await c.stop();
});
it('does not overlap replacement children while a failed child is still alive',async()=>{
 vi.useFakeTimers();const first=new FakeChild();first.kill=function(){this.killed=true;return true;};let spawns=0;const c=new CodexCollector({store:new HubStore(),spawn:()=>{spawns++;return (spawns===1?first:new FakeChild()) as any;},verifyVersion:async()=> 'codex-cli 0.162.0-alpha.17.2'});
 await c.start();await vi.advanceTimersByTimeAsync(0);first.stdout.write('{malformed}\n');await vi.advanceTimersByTimeAsync(1500);expect(spawns).toBe(1);first.emit('exit',0,null);await vi.advanceTimersByTimeAsync(1000);expect(spawns).toBe(2);await c.stop();
});
it('prefers multi-bucket fixtures and strips account/credits/plan metadata',async()=>{
 const {readFileSync}=await import('node:fs');const messages=readFileSync(new URL('./fixtures/codex-ratelimits.jsonl',import.meta.url),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 const p=normalizeCodex(messages[0].result,{nowMs:1000,lastSuccessMs:1000});expect(p.windows.map(w=>w.usedPercent)).toEqual([17.25,0]);expect(JSON.stringify(p)).not.toMatch(/accountId|synthetic-private|planType|ordinaryUsageAllowed/);
});
it('rejects primitive quota snapshots instead of clearing the last good values',()=>{
 expect(()=>normalizeCodex({rateLimits:42},{nowMs:1,lastSuccessMs:1})).toThrow('BAD_PAYLOAD');
});
it('requires the matching numeric handshake ID before sending initialized or account reads',async()=>{
 const child=new FakeChild('timeout');const c=new CodexCollector({store:new HubStore(),spawn:()=>child as any,verifyVersion:async()=> 'codex-cli 0.162.0-alpha.17.2'});await c.start();
 child.stdout.write('{"id":"1","result":{}}\n');expect(child.requests.map(r=>r.method)).toEqual(['initialize']);
 child.stdout.write('{"id":1,"result":{}}\n');expect(child.requests.map(r=>r.method)).toEqual(['initialize','initialized','account/read']);expect(child.requests[1]).toEqual({method:'initialized'});await c.stop();
});

it('retires an obsolete version probe and starts exactly one replacement after stop/start',async()=>{
 let resolveOld!:(value:string)=>void,resolveNew!:(value:string)=>void;let probes=0,spawns=0;
 const old=new Promise<string>(resolve=>resolveOld=resolve),replacement=new Promise<string>(resolve=>resolveNew=resolve);
 const c=new CodexCollector({store:new HubStore(),verifyVersion:()=>++probes===1?old:replacement,spawn:()=>{spawns++;return new FakeChild() as any;}});
 const firstStart=c.start();await c.stop();const secondStart=c.start();expect(probes).toBe(2);
 resolveOld('codex-cli 0.162.0-alpha.17.2');await firstStart;expect(spawns).toBe(0);c.retry();expect(probes).toBe(2);
 resolveNew('codex-cli 0.162.0-alpha.17.2');await secondStart;expect(spawns).toBe(1);c.retry();expect(spawns).toBe(1);await c.stop();
});
