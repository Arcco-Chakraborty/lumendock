import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { UsageSourceSchema, LIMITS, type UsageSource, type UsageWindow } from '@phone-monitor/protocol';
import { ensurePrivateDirectory, readPrivateJson, withLock, atomicWrite } from '../private-files.js';

type ObjectValue=Record<string,unknown>;
const object=(value:unknown):ObjectValue => value!==null&&typeof value==='object'&&!Array.isArray(value)?value as ObjectValue:{};
const optionalNumber=(value:unknown,reset=false):number|null=>{
  if(value===null||value===undefined)return null;
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||(reset&&(!Number.isSafeInteger(value)||value>253402300799))) throw Error('BAD_PAYLOAD');
  return value;
};
export interface Observation {nowMs:number;lastSuccessMs:number|null}
export interface ClaudeSignature {
  sessionHash:string;api:string;ordinal:number;firstSeenAtEpochMs:number;lastSeenAtEpochMs:number;
}
export interface ClaudeObservation {public:UsageSource;local:ClaudeSignature}
const windowInfo=[['five_hour','5 hours',300],['seven_day','7 days',10080]] as const;
export function normalizeClaude(input:unknown,observation:Observation):UsageSource {
  const rate=object(object(input).rate_limits);const windows:UsageWindow[]=[];
  for(const [key,label,duration]of windowInfo){
    if(rate[key]===null||rate[key]===undefined)continue;
    if(typeof rate[key]!=='object'||Array.isArray(rate[key]))throw Error('BAD_PAYLOAD');
    const window=object(rate[key]);
    windows.push({bucketId:'claude',windowId:key,label,windowDurationMins:duration,usedPercent:optionalNumber(window.used_percentage),resetsAtEpochSec:optionalNumber(window.resets_at,true),reportedAtEpochMs:observation.lastSuccessMs});
  }
  return UsageSourceSchema.parse({provider:'claude',source:'claude_statusline',state:windows.length?'available':'awaiting_data',observedAtEpochMs:observation.lastSuccessMs,lastSuccessAtEpochMs:observation.lastSuccessMs,stale:observation.lastSuccessMs===null||observation.nowMs-observation.lastSuccessMs>=LIMITS.claudeStaleMs,windows,errorCode:null});
}
function apiSignature(input:ObjectValue,previous:string|undefined):string {
  const cost=object(input.cost),context=object(input.context_window);
  // Wall time, paths, prompt contents, costs and model/session display names
  // cannot become response evidence or cross the persistence boundary.
  const supplied=[optionalNumber(cost.total_api_duration_ms),optionalNumber(context.total_input_tokens),optionalNumber(context.total_output_tokens)];
  const prior:unknown[]=previous?JSON.parse(previous):[];
  return JSON.stringify(supplied.map((value,i)=>value??prior[i]??null));
}
export function observeClaude(input:unknown,previous:ClaudeObservation|null,nowMs:number):ClaudeObservation {
  const data=object(input);if(!data.session_id||typeof data.session_id!=='string'||data.session_id.length>1024)throw Error('BAD_PAYLOAD');
  const sessionHash=createHash('sha256').update(data.session_id).digest('hex');
  if(previous&&previous.local.sessionHash!==sessionHash)throw Error('SESSION_MISMATCH');
  const incoming=normalizeClaude(data,{nowMs,lastSuccessMs:null});const api=apiSignature(data,previous?.local.api);
  const apiChanged=previous!==null&&api!==previous.local.api;
  const changed=new Set<string>();
  for(const row of incoming.windows){
    const old=previous?.public.windows.find(w=>w.windowId===row.windowId);
    if(previous&&((row.usedPercent!==null&&row.usedPercent!==old?.usedPercent)||(row.resetsAtEpochSec!==null&&row.resetsAtEpochSec!==old?.resetsAtEpochSec)))changed.add(row.windowId);
  }
  const genuine=apiChanged||changed.size>0;
  const windows:UsageWindow[]=[];
  for(const [key]of windowInfo){
    const supplied=incoming.windows.find(w=>w.windowId===key),old=previous?.public.windows.find(w=>w.windowId===key);
    if(supplied){
      windows.push({...supplied,reportedAtEpochMs:apiChanged||changed.has(key)?nowMs:old?.reportedAtEpochMs??null});
    } else if(old&&old.resetsAtEpochSec!==null&&old.resetsAtEpochSec*1000<=nowMs){windows.push({...old});}
  }
  const at=genuine?nowMs:previous?.public.observedAtEpochMs??null;
  return {public:{...incoming,state:windows.length?'available':'awaiting_data',windows,observedAtEpochMs:at,lastSuccessAtEpochMs:at,stale:windows.length===0||windows.some(w=>w.reportedAtEpochMs===null||nowMs<w.reportedAtEpochMs||nowMs-w.reportedAtEpochMs>=LIMITS.claudeStaleMs)},local:{sessionHash,api,ordinal:(previous?.local.ordinal??0)+(genuine?1:0),firstSeenAtEpochMs:previous?.local.firstSeenAtEpochMs??nowMs,lastSeenAtEpochMs:nowMs}};
}
interface ObservationFile {v:1;ordinal:number;winner:string|null;sessions:Record<string,ClaudeObservation>}
function parseFile(value:unknown):ObservationFile {
  if(value===null)return {v:1,ordinal:0,winner:null,sessions:{}};
  const file=object(value);if(file.v!==1||!Number.isSafeInteger(file.ordinal)||Number(file.ordinal)<0)throw Error('BAD_OBSERVATION_FILE');
  const sessions=object(file.sessions);if(Object.keys(sessions).length>32)throw Error('BAD_OBSERVATION_FILE');
  for(const [hash,raw]of Object.entries(sessions)){
    const entry=object(raw),local=object(entry.local);
    UsageSourceSchema.parse(entry.public);
    if(!/^[a-f0-9]{64}$/.test(hash)||local.sessionHash!==hash||typeof local.api!=='string'||local.api.length>256||![local.ordinal,local.firstSeenAtEpochMs,local.lastSeenAtEpochMs].every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0)||Number(local.ordinal)>Number(file.ordinal))throw Error('BAD_OBSERVATION_FILE');
  }
  if(file.winner!==null&&(typeof file.winner!=='string'||!Object.hasOwn(sessions,file.winner)))throw Error('BAD_OBSERVATION_FILE');
  return file as unknown as ObservationFile;
}
export class ClaudeObservationStore {
  private readonly file:string;
  constructor(private readonly directory:string){this.file=join(directory,'claude-observations.json');}
  async capture(input:unknown,nowMs:number):Promise<UsageSource>{
    ensurePrivateDirectory(this.directory);
    return withLock(join(this.directory,'claude-observation.lock'),()=>{
      const file=parseFile(readPrivateJson(this.file));
      const key=createHash('sha256').update(String(object(input).session_id??'')).digest('hex');
      for(const [id,entry]of Object.entries(file.sessions))if(nowMs-entry.local.lastSeenAtEpochMs>=86400000)delete file.sessions[id];
      const previous=file.sessions[key]??null;const observation=observeClaude(input,previous,nowMs);
      if(observation.local.ordinal>(previous?.local.ordinal??0)){if(file.ordinal>=Number.MAX_SAFE_INTEGER)throw Error('ORDINAL_EXHAUSTED');observation.local.ordinal=++file.ordinal;}
      else observation.local.ordinal=previous?.local.ordinal??0;
      file.sessions[key]=observation;
      const all=Object.entries(file.sessions).sort((a,b)=>b[1].local.lastSeenAtEpochMs-a[1].local.lastSeenAtEpochMs);
      // Cache-only churn must not evict the still-valid greatest genuine report.
      const protectedWinner=file.winner&&file.sessions[file.winner]?.local.ordinal?file.winner:null;
      const retained=new Set(all.filter(([id])=>id!==protectedWinner).slice(0,protectedWinner?31:32).map(([id])=>id));
      if(protectedWinner)retained.add(protectedWinner);
      for(const [id]of all)if(!retained.has(id))delete file.sessions[id];
      let winner=file.winner&&file.sessions[file.winner]?file.winner:null;
      for(const [id,item]of Object.entries(file.sessions)){
        const prior=winner?file.sessions[winner]:null;
        if(!prior||item.local.ordinal>prior.local.ordinal||(item.local.ordinal===0&&prior.local.ordinal===0&&item.local.firstSeenAtEpochMs>prior.local.firstSeenAtEpochMs))winner=id;
      }
      file.winner=winner;
      atomicWrite(this.file,JSON.stringify(file));
      return this.publicAt(file,nowMs)!;
    });
  }
  read(nowMs:number):UsageSource|null {return this.publicAt(parseFile(readPrivateJson(this.file)),nowMs);}
  private publicAt(file:ObservationFile,nowMs:number):UsageSource|null {
    const source=file.winner?file.sessions[file.winner]?.public:null;if(!source)return null;
    const result=UsageSourceSchema.parse(source);
    result.stale=result.windows.length===0||result.windows.some(w=>w.reportedAtEpochMs===null||nowMs<w.reportedAtEpochMs||nowMs-w.reportedAtEpochMs>=LIMITS.claudeStaleMs);
    return result;
  }
}
