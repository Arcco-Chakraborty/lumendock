import { describe,it,expect,vi,afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { NotificationCollector } from '../src/collectors/notifications.js';
import { HubStore } from '../src/store.js';

// Deliberately synthetic fixture: no real notification was ever captured.
const base=JSON.parse(readFileSync(new URL('./fixtures/busctl-notify-synthetic.json',import.meta.url),'utf8'));
const notify=(app:string,title='Synthetic title',body='synthetic body',mutate?:(m:any)=>void)=>{const m=structuredClone(base);m.payload.data[0]=app;m.payload.data[3]=title;m.payload.data[4]=body;mutate?.(m);return JSON.stringify(m)+'\n';};
class FakeChild extends EventEmitter {
 stdout=new PassThrough();stderr=new PassThrough();signals:string[]=[];exited=false;
 constructor(private readonly stubborn=false){super();}
 kill(signal='SIGTERM'){this.signals.push(signal);if(this.stubborn&&signal!=='SIGKILL')return true;this.exit(null);return true;}
 exit(code:number|null){if(this.exited)return;this.exited=true;queueMicrotask(()=>this.emit('exit',code,null));}
 say(text:string){this.stdout.write(text);}
}
const fakeRunner=(opts:{stubborn?:boolean;throws?:boolean}={})=>{
 const calls:{command:string;args:string[];options:any}[]=[];const children:FakeChild[]=[];
 const run=(command:string,args:string[],options:any)=>{calls.push({command,args,options});if(opts.throws)throw Error('synthetic spawn failure');const c=new FakeChild(opts.stubborn);children.push(c);return c as any;};
 return {calls,children,run};
};
let now=1_000_000;const clock={nowMs:()=>now,monotonicMs:()=>now};
const setup=(opts:{stubborn?:boolean;throws?:boolean}={},allowlist:string[]=['SyntheticApp'])=>{
 const runner=fakeRunner(opts);const store=new HubStore({notificationAllowlist:allowlist});
 const collector=new NotificationCollector({runner:runner.run,store,clock});return {runner,store,collector};
};
const items=(store:HubStore,at=now)=>store.snapshot(at).notifications.items;
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();now=1_000_000;});

describe('notification capture lifecycle',()=>{
 it('never starts capture with an empty allowlist',async()=>{
  const {runner,store,collector}=setup({},[]);await collector.start([]);
  expect(runner.calls).toHaveLength(0);expect(store.snapshot(now).notifications).toMatchObject({state:'disabled',errorCode:null});
  await collector.stop();
 });
 it('starts one argument-array monitor per label with an exact match expression and no shell',async()=>{
  const {runner,collector}=setup({},['SyntheticApp','Other App.v2:x-y']);await collector.start(['SyntheticApp','Other App.v2:x-y','SyntheticApp']);
  expect(runner.calls).toHaveLength(2);
  expect(runner.calls[0]).toMatchObject({command:'busctl',args:['--user','--json=short','--no-pager',"--match=type='method_call',interface='org.freedesktop.Notifications',member='Notify',arg0='SyntheticApp'",'monitor']});
  expect(runner.calls[1]!.args[3]).toContain("arg0='Other App.v2:x-y'");
  for(const c of runner.calls)expect(c.options.shell).toBe(false);
  await collector.stop();
 });
 it('caps the allowlist at ten monitors',async()=>{
  const labels=Array.from({length:12},(_,i)=>`App${i}`);const {runner,collector}=setup({},labels);await collector.start(labels);
  expect(runner.calls).toHaveLength(10);expect(runner.calls.map(c=>c.args[3]!.match(/arg0='(.*)'/)![1])).toEqual(labels.slice(0,10));await collector.stop();
 });
 it.each([["x',arg1='y"],['a"b'],['a\\b'],['a\nb'],['a\u0000b'],['a,b'],['é'],['x'.repeat(81)],[''],[' lead'],['trail '],['   ']])('rejects unsafe label %j without spawning',async label=>{
  const {runner,collector}=setup({},['SyntheticApp']);await collector.start([label]);
  expect(runner.calls).toHaveLength(0);await collector.stop();
 });
 it('stores an allowlisted synthetic event with a 30 minute lifetime',async()=>{
  const {runner,store,collector}=setup();await collector.start(['SyntheticApp']);runner.children[0]!.say(notify('SyntheticApp'));
  await vi.waitFor(()=>expect(items(store)).toHaveLength(1));
  expect(items(store)[0]).toMatchObject({appId:'SyntheticApp',title:'Synthetic title',body:'synthetic body',receivedAtEpochMs:now,expiresAtEpochMs:now+1_800_000});
  expect(store.snapshot(now).notifications).toMatchObject({state:'available',errorCode:null});await collector.stop();
 });
 it('expires notifications on read without new traffic and honours the ring cap',async()=>{
  const {runner,store,collector}=setup();await collector.start(['SyntheticApp']);
  for(let i=0;i<150;i++)runner.children[0]!.say(notify('SyntheticApp','t',`synthetic body ${i}`));
  await vi.waitFor(()=>expect(items(store).at(-1)?.body).toBe('synthetic body 149'));
  expect(items(store)).toHaveLength(100);expect(items(store)[0]!.body).toBe('synthetic body 50');
  expect(items(store,now+1_799_999)).toHaveLength(100);expect(items(store,now+1_800_000)).toHaveLength(0);await collector.stop();
 });
 it('suppresses an identical event within two seconds but accepts it afterwards or when different',async()=>{
  const {runner,store,collector}=setup();await collector.start(['SyntheticApp']);const child=runner.children[0]!;
  child.say(notify('SyntheticApp'));await vi.waitFor(()=>expect(items(store)).toHaveLength(1));
  now+=1999;child.say(notify('SyntheticApp'));child.say(notify('SyntheticApp','Synthetic title','synthetic body two'));
  await vi.waitFor(()=>expect(items(store)).toHaveLength(2));
  now+=1;child.say(notify('SyntheticApp'));await vi.waitFor(()=>expect(items(store)).toHaveLength(3));await collector.stop();
 });
 it('truncates by code point, flattens markup and control characters, and keeps plain text',async()=>{
  const {runner,store,collector}=setup();await collector.start(['SyntheticApp']);
  runner.children[0]!.say(notify('SyntheticApp','😀'.repeat(150),`<b>bold</b> &lt;x&gt;\u0007\n${'y'.repeat(400)}`));
  await vi.waitFor(()=>expect(items(store)).toHaveLength(1));
  const [item]=items(store);expect([...item!.title]).toHaveLength(100);expect([...item!.body]).toHaveLength(280);
  expect(item!.body.startsWith('bold <x> y')).toBe(true);expect(item!.body).not.toMatch(/[\u0000-\u001f]/);await collector.stop();
 });
 it('never stores or logs non-allowlisted, hostile, malformed or oversized events, then recovers',async()=>{
  const logs=[vi.spyOn(console,'log'),vi.spyOn(console,'error'),vi.spyOn(console,'warn'),vi.spyOn(console,'info'),vi.spyOn(console,'debug')];
  const out=vi.spyOn(process.stdout,'write');const err=vi.spyOn(process.stderr,'write');
  const {runner,store,collector}=setup();await collector.start(['SyntheticApp']);const child=runner.children[0]!;
  const secret='synthetic secret body';
  child.say(notify('OtherApp','t',secret));
  child.say(notify('SyntheticApp','t',secret,m=>{m.member='NotificationClosed';}));
  child.say(notify('SyntheticApp','t',secret,m=>{m.interface='org.example.Other';}));
  child.say(notify('SyntheticApp','t',secret,m=>{m.type='signal';}));
  child.say(notify('SyntheticApp','t',secret,m=>{m.payload.type='susssasa{sv}u';}));
  child.say(notify('SyntheticApp','t',secret,m=>{m.payload.data[4]=42;}));
  child.say(notify('SyntheticApp','t',secret,m=>{m.payload.data.pop();}));
  child.say(notify('SyntheticApp','t',secret,m=>{m.payload.data[5]='nope';}));
  child.say(`{"not json ${secret}\n`);child.say('[1,2,3]\n');child.say('null\n');child.say('\n');
  child.say(notify('SyntheticApp','t','x'.repeat(300_000)));       // oversized single line, dropped
  child.say('{"partial":"'+'z'.repeat(200_000));child.say('z'.repeat(200_000)+'"}\n'); // oversized across chunks
  child.say('q'.repeat(300_000));child.say(notify('SyntheticApp','t',secret)); // valid-looking tail of an oversized line is still dropped
  child.say(notify('SyntheticApp','t','legit after hostile'));
  await vi.waitFor(()=>expect(items(store)).toHaveLength(1));
  expect(items(store)[0]!.body).toBe('legit after hostile');
  for(const spy of [...logs,out,err])for(const call of spy.mock.calls)expect(JSON.stringify(call)).not.toContain(secret);
  await collector.stop();
 });
 it('ignores events whose app label differs from the monitor that received them',async()=>{
  const {runner,store,collector}=setup({},['SyntheticApp','Other']);await collector.start(['SyntheticApp','Other']);
  runner.children[0]!.say(notify('Other'));runner.children[0]!.say(notify('SyntheticApp','t','ok'));
  await vi.waitFor(()=>expect(items(store)).toHaveLength(1));expect(items(store)[0]!.appId).toBe('SyntheticApp');await collector.stop();
 });
});

describe('capability and failure isolation',()=>{
 it('reports denied BecomeMonitor with a fixed code and never retains raw stderr',async()=>{
  const {runner,store,collector}=setup();await collector.start(['SyntheticApp']);
  runner.children[0]!.stderr.write('Failed to request monitor: Access denied for /home/secret\n');runner.children[0]!.exit(1);
  await vi.waitFor(()=>expect(store.snapshot(now).notifications.errorCode).toBe('NOTIFICATION_MONITOR_DENIED'));
  expect(store.snapshot(now).notifications.state).toBe('unavailable');
  expect(JSON.stringify(store.snapshot(now))).not.toContain('secret');expect(collector.capability).toEqual({state:'unavailable',errorCode:'NOTIFICATION_MONITOR_DENIED'});
  await collector.stop();
 });
 it('reports a missing busctl as unavailable without throwing and keeps quota collectors working',async()=>{
  vi.useFakeTimers();const {runner,store,collector}=setup();await collector.start(['SyntheticApp']);
  runner.children[0]!.emit('error',Object.assign(Error('spawn busctl ENOENT'),{code:'ENOENT'}));runner.children[0]!.exit(null);
  await vi.advanceTimersByTimeAsync(50);
  expect(store.snapshot(now).notifications).toMatchObject({state:'unavailable',errorCode:'NOTIFICATION_MONITOR_UNAVAILABLE'});
  expect(store.updateUsage('claude',{provider:'claude',source:'claude_statusline',state:'awaiting_data',observedAtEpochMs:now,lastSuccessAtEpochMs:null,stale:true,windows:[],errorCode:null})).toBe(true);
  await collector.stop();
 });
 it('survives a synchronous spawn failure',async()=>{
  vi.useFakeTimers();const {runner,store,collector}=setup({throws:true});await expect(collector.start(['SyntheticApp'])).resolves.toBeUndefined();
  expect(store.snapshot(now).notifications).toMatchObject({state:'unavailable',errorCode:'NOTIFICATION_MONITOR_UNAVAILABLE'});
  await collector.stop();expect(vi.getTimerCount()).toBe(0);expect(runner.calls.length).toBe(1);
 });
 it('becomes available after the startup grace period without output',async()=>{
  vi.useFakeTimers();const {store,collector}=setup();await collector.start(['SyntheticApp']);
  expect(store.snapshot(now).notifications.state).toBe('unavailable');await vi.advanceTimersByTimeAsync(1000);
  expect(store.snapshot(now).notifications).toMatchObject({state:'available',errorCode:null});await collector.stop();
 });
 it('restarts a dead monitor with bounded exponential delay and stops cleanly',async()=>{
  vi.useFakeTimers();const {runner,collector}=setup();await collector.start(['SyntheticApp']);
  const delays=[1000,2000,4000,8000,16000,32000,60000,60000];
  for(const [i,delay] of delays.entries()){
   runner.children.at(-1)!.exit(1);await vi.advanceTimersByTimeAsync(delay-1);expect(runner.calls).toHaveLength(i+1);
   await vi.advanceTimersByTimeAsync(1);expect(runner.calls).toHaveLength(i+2);
  }
  await collector.stop();expect(vi.getTimerCount()).toBe(0);const total=runner.calls.length;await vi.advanceTimersByTimeAsync(120000);expect(runner.calls).toHaveLength(total);
 });
 it('escalates to SIGKILL for a monitor that ignores SIGTERM and never leaks it',async()=>{
  vi.useFakeTimers();const {runner,collector}=setup({stubborn:true});await collector.start(['SyntheticApp']);
  const stopping=collector.stop();await vi.advanceTimersByTimeAsync(2100);await stopping;
  expect(runner.children[0]!.signals).toEqual(['SIGTERM','SIGKILL']);expect(vi.getTimerCount()).toBe(0);
 });
});

describe('generation-owned lifecycle',()=>{
 it('stop then start never leaves a stale child, timer or event path',async()=>{
  vi.useFakeTimers();const {runner,store,collector}=setup();await collector.start(['SyntheticApp']);const old=runner.children[0]!;
  await collector.stop();expect(old.signals).toEqual(['SIGTERM']);expect(vi.getTimerCount()).toBe(0);
  await collector.start(['SyntheticApp']);expect(runner.children).toHaveLength(2);
  old.say(notify('SyntheticApp','t','from stale child'));old.emit('exit',1,null);await vi.advanceTimersByTimeAsync(70000);
  expect(items(store)).toHaveLength(0);expect(runner.calls).toHaveLength(2);
  await collector.stop();expect(runner.children[1]!.signals).toEqual(['SIGTERM']);expect(vi.getTimerCount()).toBe(0);
 });
 it('serialises overlapping start calls so only the final allowlist is running',async()=>{
  const {runner,collector}=setup({},['A','B']);const first=collector.start(['A']);const second=collector.start(['B']);await Promise.all([first,second]);
  const alive=runner.children.filter((c,i)=>!c.signals.length&&!c.exited);expect(alive).toHaveLength(1);
  expect(runner.calls[runner.children.indexOf(alive[0]!)]!.args[3]).toContain("arg0='B'");await collector.stop();
  expect(runner.children.every(c=>c.signals.length>0)).toBe(true);
 });
 it('reconciles a settings change without respawning unchanged labels and drops removed events',async()=>{
  const {runner,store,collector}=setup({},['A','B','C']);await collector.start(['A','B']);
  runner.children[0]!.say(notify('A','t','from A'));await vi.waitFor(()=>expect(items(store)).toHaveLength(1));
  await collector.start(['B','C']);expect(runner.calls).toHaveLength(3);expect(runner.children[0]!.signals).toEqual(['SIGTERM']);expect(runner.children[1]!.signals).toEqual([]);
  expect(runner.calls[2]!.args[3]).toContain("arg0='C'");expect(items(store)).toHaveLength(0);
  await collector.start([]);expect(store.snapshot(now).notifications).toMatchObject({state:'disabled',errorCode:null});
  expect(runner.children.every(c=>c.signals.length>0)).toBe(true);await collector.stop();
 });
 it('a removed monitor that exits late does not trigger a restart',async()=>{
  vi.useFakeTimers();const {runner,collector}=setup({stubborn:true},['A']);await collector.start(['A']);
  const stopping=collector.start([]);await vi.advanceTimersByTimeAsync(2100);await stopping;await vi.advanceTimersByTimeAsync(70000);
  expect(runner.calls).toHaveLength(1);expect(vi.getTimerCount()).toBe(0);
 });
});
