import { ClaudeObservationStore } from './claude.js';
import { CodexCollector, type CodexCollectorOptions } from './codex.js';
import type { ClaudeUsagePoller } from './claude-usage.js';
import type { HubStore } from '../store.js';
import { inspectClaudeCapture } from '../claude/install.js';
import { claudeUsagePollingEnabled } from '../config.js';
import { claudeWindowStale, type ErrorCode, type UsageSource, type UsageWindow } from '@phone-monitor/protocol';
export interface HubCollectorsOptions {
  store:HubStore;configDir:string;nowMs?:()=>number;codex?:Omit<CodexCollectorOptions,'store'|'nowMs'>;
  /** Opt-in usage polling; it runs only while `enabled()` (the private config flag) and `active()` (the phone is watching). */
  claudeUsage?:{poller:ClaudeUsagePoller;active:()=>boolean;enabled?:()=>boolean};
}
const WINDOW_ORDER=['five_hour','seven_day'];
const FLAG_CHECK_MS=5000;
export class HubCollectors {
  readonly codex:CodexCollector;
  private readonly claude:ClaudeObservationStore;
  private timer:ReturnType<typeof setInterval>|null=null;
  private readonly now:()=>number;
  private lastClaude:UsageSource|null=null;
  private pollingOn=false;
  private flagCheckedAt=-Infinity;
  constructor(private readonly options:HubCollectorsOptions){
    this.now=options.nowMs??Date.now;this.claude=new ClaudeObservationStore(options.configDir);
    this.codex=new CodexCollector({...options.codex,store:options.store,nowMs:this.now});
  }
  async start():Promise<void>{
    if(this.timer)return;
    await this.refresh();this.timer=setInterval(()=>void this.refresh(),1000);
    await this.codex.start();
  }
  /** One tick: re-read the opt-in flag now and then, poll when due, and publish Claude usage. */
  async refresh():Promise<void>{
    const usage=this.options.claudeUsage;
    if(usage){
      const now=this.now();
      if(now-this.flagCheckedAt>=FLAG_CHECK_MS){
        this.flagCheckedAt=now;
        this.pollingOn=(usage.enabled??(()=>claudeUsagePollingEnabled(this.options.configDir)))();
        if(!this.pollingOn)usage.poller.reset();
      }
      if(this.pollingOn&&usage.active())await usage.poller.maybePoll(now).catch(()=>false);
    }
    this.loadClaude();
  }
  private loadClaude():void {
    const now=this.now();
    const poller=this.pollingOn?this.options.claudeUsage?.poller:undefined;
    let line:UsageSource|null=null;
    try{line=this.claude.read(now);if(line)this.lastClaude=line;}
    catch{if(!poller?.windows.length){this.claudeStatus('error','BAD_PAYLOAD');return;}}
    if(poller?.windows.length){this.publishMerged(line,poller.windows,now);return;}
    try{
      if(line)this.options.store.updateUsage('claude',line);
      const readiness=inspectClaudeCapture(this.options.configDir);
      const signedOut=poller&&(poller.state==='signed_out'||poller.state==='rejected');
      if(readiness.state==='ready'){
        if(!line)signedOut?this.claudeStatus('auth_required','AUTH_REQUIRED'):this.claudeStatus('awaiting_data',null);
      }else if(poller)signedOut?this.claudeStatus('auth_required','AUTH_REQUIRED'):this.claudeStatus('awaiting_data',null);
      else this.claudeStatus(readiness.state==='invalid'?'error':'unsupported',readiness.state==='invalid'?'BAD_PAYLOAD':'SOURCE_UNAVAILABLE');
    }catch{this.claudeStatus('error','BAD_PAYLOAD');}
  }
  /** Per window, the newer of the status line's and the usage service's readings wins. */
  private publishMerged(line:UsageSource|null,polled:readonly UsageWindow[],now:number):void {
    const picked=new Map<string,{window:UsageWindow;polled:boolean}>();
    for(const window of line?.windows??[])picked.set(window.windowId,{window,polled:false});
    for(const window of polled){
      const prior=picked.get(window.windowId);
      if(!prior||(prior.window.reportedAtEpochMs??0)<=(window.reportedAtEpochMs??0))picked.set(window.windowId,{window,polled:true});
    }
    const rows=[...picked.values()].sort((a,b)=>WINDOW_ORDER.indexOf(a.window.windowId)-WINDOW_ORDER.indexOf(b.window.windowId));
    const newest=rows.reduce((best,row)=>(row.window.reportedAtEpochMs??0)>(best.window.reportedAtEpochMs??0)?row:best,rows[0]!);
    const at=Math.max(line?.lastSuccessAtEpochMs??0,...rows.map(row=>row.window.reportedAtEpochMs??0))||null;
    const windows=rows.map(row=>row.window);
    this.options.store.updateUsage('claude',{provider:'claude',source:newest.polled?'claude_usage_api':'claude_statusline',state:'available',observedAtEpochMs:at,lastSuccessAtEpochMs:at,stale:windows.some(w=>claudeWindowStale(w,now)),windows,errorCode:null});
  }
  private claudeStatus(state:UsageSource['state'],errorCode:ErrorCode|null):void {
    const prior=this.lastClaude;
    this.options.store.updateUsage('claude',{provider:'claude',source:'claude_statusline',state,observedAtEpochMs:prior?.observedAtEpochMs??null,lastSuccessAtEpochMs:prior?.lastSuccessAtEpochMs??null,stale:true,windows:[],errorCode});
  }
  async stop():Promise<void>{if(this.timer)clearInterval(this.timer);this.timer=null;await this.codex.stop();}
}
