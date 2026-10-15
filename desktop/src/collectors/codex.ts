import { spawn as nodeSpawn, execFile } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { LIMITS, UsageSourceSchema, type UsageSource, type UsageWindow, type ErrorCode } from '@phone-monitor/protocol';
import type { HubStore } from '../store.js';
import type { Observation } from './claude.js';

// Protocol shape verified with this installed binary's generate-ts output.
export const CODEX_COMPATIBLE_VERSION='codex-cli 0.162.0-alpha.17.2';
const MESSAGE_BYTES=256*1024;
type ObjectValue=Record<string,unknown>;
const object=(v:unknown):ObjectValue=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as ObjectValue:{};
const identifier=(v:unknown):string=>{if(typeof v!=='string'||v.length===0||[...v].length>80)throw Error('BAD_PAYLOAD');return v;};
const numeric=(v:unknown,reset=false,duration=false):number|null=>{
  if(v===null||v===undefined)return null;
  if(typeof v!=='number'||!Number.isFinite(v)||v<0||(duration&&v===0)||(reset&&(!Number.isSafeInteger(v)||v>253402300799)))throw Error('BAD_PAYLOAD');return v;
};
export function normalizeCodex(result:unknown,observation:Observation):UsageSource {
  const data=object(result);let buckets:Record<string,unknown>;
  if(data.rateLimitsByLimitId!==undefined&&data.rateLimitsByLimitId!==null){
    if(typeof data.rateLimitsByLimitId!=='object'||Array.isArray(data.rateLimitsByLimitId))throw Error('BAD_PAYLOAD');buckets=object(data.rateLimitsByLimitId);
  } else if(data.rateLimits!==undefined&&data.rateLimits!==null){if(typeof data.rateLimits!=='object'||Array.isArray(data.rateLimits))throw Error('BAD_PAYLOAD');const rate=object(data.rateLimits);buckets={[identifier(rate.limitId??'codex')]:rate};}
  else throw Error('BAD_PAYLOAD');
  const windows:UsageWindow[]=[];
  for(const [id,raw]of Object.entries(buckets)){
    identifier(id);if(raw===null||typeof raw!=='object'||Array.isArray(raw))throw Error('BAD_PAYLOAD');
    const bucket=object(raw);const label=bucket.limitName===null||bucket.limitName===undefined?id:identifier(bucket.limitName);
    for(const key of ['primary','secondary']as const){
      const value=bucket[key];if(value===null||value===undefined)continue;
      if(typeof value!=='object'||Array.isArray(value))throw Error('BAD_PAYLOAD');const row=object(value);
      windows.push({bucketId:id,windowId:key,label,usedPercent:numeric(row.usedPercent),windowDurationMins:numeric(row.windowDurationMins,false,true),resetsAtEpochSec:numeric(row.resetsAt,true),reportedAtEpochMs:observation.nowMs});
    }
  }
  if(windows.length>LIMITS.codexWindows)throw Error('SOURCE_CAPACITY_EXCEEDED');
  return UsageSourceSchema.parse({provider:'codex',source:'codex_app_server',state:'available',observedAtEpochMs:observation.nowMs,lastSuccessAtEpochMs:observation.lastSuccessMs,stale:observation.lastSuccessMs===null||observation.nowMs-observation.lastSuccessMs>=LIMITS.codexStaleMs,windows,errorCode:null});
}
export interface CodexCollectorOptions {
  store:HubStore;codexPath?:string;spawn?: (command:string,args:string[],options:{shell:false;stdio:['pipe','pipe','pipe']})=>ChildProcessWithoutNullStreams;
  verifyVersion?:()=>Promise<string>;nowMs?:()=>number;monotonicMs?:()=>number;jitter?:()=>number;
}
interface Pending {method:'initialize'|'account/read'|'account/rateLimits/read';timer:ReturnType<typeof setTimeout>}
export class CodexCollector {
  private child:ChildProcessWithoutNullStreams|null=null;
  private running=false;private stopping:Promise<void>|null=null;
  private retiring:Promise<void>|null=null;private verified=false;private probing:number|null=null;
  private activityTimer:ReturnType<typeof setInterval>|null=null;private scheduledActive=false;
  private pending=new Map<number,Pending>();private sequence=0;private generation=0;
  private timer:ReturnType<typeof setTimeout>|null=null;private failures=0;
  private source:UsageSource|null=null;private bytes=Buffer.alloc(0);private authenticated=false;
  private readonly now:()=>number;private readonly monotonic:()=>number;
  constructor(private readonly options:CodexCollectorOptions){this.now=options.nowMs??Date.now;this.monotonic=options.monotonicMs??(()=>performance.now());}
  async start():Promise<void>{
    if(this.running)return;if(this.stopping)await this.stopping;this.running=true;
    await this.probeVersion();
  }
  private async probeVersion():Promise<void>{
    if(!this.running||this.probing===this.generation)return;
    const generation=++this.generation;this.probing=generation;
    try {
      const version=await (this.options.verifyVersion??(()=>new Promise<string>((resolve,reject)=>execFile(this.options.codexPath??'codex',['--version'],{timeout:10000,maxBuffer:4096},(error,out)=>error?reject(error):resolve(out.trim())))))();
      if(!this.running||generation!==this.generation)return;
      if(version.trim()!==CODEX_COMPATIBLE_VERSION){this.verified=false;this.state('unsupported','UNSUPPORTED_SOURCE');return;}
      this.verified=true;this.connect();
    } catch {if(this.running&&generation===this.generation){this.verified=false;this.state('error','SOURCE_UNAVAILABLE');this.scheduleRestart();}}
    finally{if(this.probing===generation)this.probing=null;}
  }
  private connect():void {
    if(!this.running||this.child||this.retiring)return;
    if(!this.verified){void this.probeVersion();return;}
    this.bytes=Buffer.alloc(0);this.authenticated=false;
    let child:ChildProcessWithoutNullStreams;
    try{child=(this.options.spawn??nodeSpawn)(this.options.codexPath??'codex',['app-server','--listen','stdio://'],{shell:false,stdio:['pipe','pipe','pipe']});}
    catch{this.state('error','SOURCE_UNAVAILABLE');this.scheduleRestart();return;}
    this.child=child;
    this.activityTimer=setInterval(()=>{if(this.authenticated&&!this.pending.size&&this.timer&&this.options.store.isPhoneActive(this.monotonic())!==this.scheduledActive)this.schedulePoll();},1000);
    child.stdin.on('error',()=>{if(this.child===child)this.fail('SOURCE_UNAVAILABLE');});
    child.stdout.on('data',(chunk:Buffer)=>{if(this.child===child)this.consume(Buffer.from(chunk));});
    // Drain without retaining or logging provider stderr, which may contain
    // credentials, account identifiers or private configuration diagnostics.
    child.stderr.on('data',()=>{});
    child.on('error',()=>{if(this.child===child)this.fail('SOURCE_UNAVAILABLE');});
    child.once('exit',()=>{if(this.child!==child)return;this.child=null;this.clearPending();this.clearActivityTimer();if(this.running){this.state('error','SOURCE_UNAVAILABLE');this.scheduleRestart();}});
    this.request('initialize',{clientInfo:{name:'phone_monitor',version:'0.1.0'}});
  }
  private send(value:unknown):void {this.child?.stdin.write(`${JSON.stringify(value)}\n`);}
  private request(method:Pending['method'],params:unknown):void {
    if(!this.child||this.pending.size)return;
    const id=++this.sequence;
    const timer=setTimeout(()=>{if(this.pending.has(id))this.fail('REQUEST_TIMEOUT');},10000);
    this.pending.set(id,{method,timer});this.send({id,method,params});
  }
  private consume(chunk:Buffer):void {
    // Count bytes before decoding; a multibyte UTF-8 split cannot bypass the cap.
    let start=0;
    for(let i=0;i<chunk.length;i++)if(chunk[i]===10){
      const part=chunk.subarray(start,i);if(this.bytes.length+part.length>MESSAGE_BYTES){this.fail('BAD_PAYLOAD');return;}
      const line=Buffer.concat([this.bytes,part]).toString('utf8');this.bytes=Buffer.alloc(0);start=i+1;
      if(line.trim()){try{this.message(JSON.parse(line));}catch(e){this.fail((e as Error).message==='SOURCE_CAPACITY_EXCEEDED'?'SOURCE_CAPACITY_EXCEEDED':'BAD_PAYLOAD');return;}}
      if(!this.child)return;
    }
    if(this.bytes.length+chunk.length-start>MESSAGE_BYTES){this.fail('BAD_PAYLOAD');return;}
    this.bytes=Buffer.concat([this.bytes,chunk.subarray(start)]);
  }
  private message(raw:unknown):void {
    const message=object(raw);
    if(Object.hasOwn(message,'id')){
      if(typeof message.id!=='number')return;
      const pending=this.pending.get(message.id);if(!pending)return;
      clearTimeout(pending.timer);this.pending.delete(message.id);
      if(message.error!==undefined){const code=object(message.error).code;if(code===401||code===-32001){this.authenticated=false;this.state('auth_required','AUTH_REQUIRED');this.schedulePoll(300000);}else this.fail('SOURCE_UNAVAILABLE');return;}
      if(!Object.hasOwn(message,'result'))throw Error('BAD_PAYLOAD');
      if(pending.method==='initialize'){this.send({method:'initialized'});this.request('account/read',{refreshToken:false});}
      else if(pending.method==='account/read'){
        const result=object(message.result);
        if(result.account===null&&result.requiresOpenaiAuth===true){this.authenticated=false;this.state('auth_required','AUTH_REQUIRED');this.schedulePoll(300000);}
        else if(result.account&&typeof result.account==='object'){this.authenticated=true;this.request('account/rateLimits/read',{});}
        else {this.state('unsupported','UNSUPPORTED_SOURCE');this.schedulePoll(300000);}
      } else {
        const now=this.now();const normalized=normalizeCodex(message.result,{nowMs:now,lastSuccessMs:now});this.accept(normalized);this.failures=0;this.schedulePoll();
      }
    }else if(message.method==='account/rateLimits/updated'&&this.authenticated){
      const now=this.now();const update=normalizeCodex(message.params,{nowMs:now,lastSuccessMs:this.source?.lastSuccessAtEpochMs??null});
      const rows=new Map((this.source?.windows??[]).map(row=>[`${row.bucketId}\0${row.windowId}`,row]));
      for(const row of update.windows){const key=`${row.bucketId}\0${row.windowId}`,prior=rows.get(key);rows.set(key,prior?{...row,usedPercent:row.usedPercent??prior.usedPercent,windowDurationMins:row.windowDurationMins??prior.windowDurationMins,resetsAtEpochSec:row.resetsAtEpochSec??prior.resetsAtEpochSec}:row);}
      if(rows.size>LIMITS.codexWindows)throw Error('SOURCE_CAPACITY_EXCEEDED');
      this.accept({...update,windows:[...rows.values()]});
    }
  }
  private accept(source:UsageSource):void {this.source=source;this.options.store.updateUsage('codex',source);}
  private state(state:UsageSource['state'],errorCode:ErrorCode):void {
    this.options.store.updateUsage('codex',{provider:'codex',source:'codex_app_server',state,errorCode,observedAtEpochMs:this.now(),lastSuccessAtEpochMs:this.source?.lastSuccessAtEpochMs??null,stale:true,windows:this.source?.windows??[]});
  }
  private clearPending():void{for(const item of this.pending.values())clearTimeout(item.timer);this.pending.clear();}
  private fail(code:ErrorCode):void {
    this.clearPending();this.state(code==='SOURCE_CAPACITY_EXCEEDED'?'unsupported':'error',code);
    const child=this.child;this.child=null;this.clearActivityTimer();this.clearTimer();
    if(child){this.retiring=this.terminateChild(child);void this.retiring.then(()=>{this.retiring=null;this.scheduleRestart();});}
    else if(!this.retiring)this.scheduleRestart();
  }
  private scheduleRestart():void {
    if(!this.running)return;
    this.clearTimer();const delay=Math.min(60000,1000*2**Math.min(this.failures++,6));this.timer=setTimeout(()=>{this.timer=null;this.connect();},delay);
  }
  private clearTimer():void{if(this.timer)clearTimeout(this.timer);this.timer=null;}
  private schedulePoll(delay?:number):void {
    this.clearTimer();if(!this.running)return;
    this.scheduledActive=this.options.store.isPhoneActive(this.monotonic());
    const cadence=this.scheduledActive?60000:300000;
    const jitter=Math.min(1,Math.max(0,(this.options.jitter??Math.random)()));
    this.timer=setTimeout(()=>{this.timer=null;this.request(this.authenticated?'account/rateLimits/read':'account/read',this.authenticated?{}:{refreshToken:false});},delay??cadence*(0.9+0.2*jitter));
  }
  retry():void {if(!this.running){void this.start();return;}this.clearTimer();if(this.child)this.request(this.authenticated?'account/rateLimits/read':'account/read',this.authenticated?{}:{refreshToken:false});else this.connect();}
  private clearActivityTimer():void{if(this.activityTimer)clearInterval(this.activityTimer);this.activityTimer=null;}
  private terminateChild(child:ChildProcessWithoutNullStreams):Promise<void>{
    return new Promise(resolve=>{
      let complete=false;
      const done=()=>{if(complete)return;complete=true;clearTimeout(force);child.off('exit',done);child.off('close',done);child.off('error',done);resolve();};
      const force=setTimeout(()=>{child.kill('SIGKILL');},2000);
      child.once('exit',done);child.once('close',done);child.once('error',done);
      child.stdin.end();child.kill('SIGTERM');
    });
  }
  async stop():Promise<void> {
    if(this.stopping)return this.stopping;
    this.running=false;this.verified=false;++this.generation;this.clearTimer();this.clearPending();this.clearActivityTimer();const child=this.child;this.child=null;
    this.stopping=(async()=>{if(this.retiring)await this.retiring;if(child)await this.terminateChild(child);})();
    await this.stopping;this.stopping=null;
  }
}
