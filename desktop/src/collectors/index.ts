import { ClaudeObservationStore } from './claude.js';
import { CodexCollector, type CodexCollectorOptions } from './codex.js';
import type { HubStore } from '../store.js';
import { inspectClaudeCapture } from '../claude/install.js';
import type { ErrorCode, UsageSource } from '@phone-monitor/protocol';
export interface HubCollectorsOptions {store:HubStore;configDir:string;nowMs?:()=>number;codex?:Omit<CodexCollectorOptions,'store'|'nowMs'>}
export class HubCollectors {
  readonly codex:CodexCollector;
  private readonly claude:ClaudeObservationStore;
  private timer:ReturnType<typeof setInterval>|null=null;
  private readonly now:()=>number;
  private lastClaude:UsageSource|null=null;
  constructor(private readonly options:HubCollectorsOptions){
    this.now=options.nowMs??Date.now;this.claude=new ClaudeObservationStore(options.configDir);
    this.codex=new CodexCollector({...options.codex,store:options.store,nowMs:this.now});
  }
  async start():Promise<void>{
    if(this.timer)return;
    this.loadClaude();this.timer=setInterval(()=>this.loadClaude(),1000);
    await this.codex.start();
  }
  private loadClaude():void {
    try{
      const source=this.claude.read(this.now());
      if(source){this.lastClaude=source;this.options.store.updateUsage('claude',source);}
      const readiness=inspectClaudeCapture(this.options.configDir);
      if(readiness.state==='ready'){
        if(!source)this.claudeStatus('awaiting_data',null);
      }else this.claudeStatus(readiness.state==='invalid'?'error':'unsupported',readiness.state==='invalid'?'BAD_PAYLOAD':'SOURCE_UNAVAILABLE');
    }catch{this.claudeStatus('error','BAD_PAYLOAD');}
  }
  private claudeStatus(state:UsageSource['state'],errorCode:ErrorCode|null):void {
    const prior=this.lastClaude;
    this.options.store.updateUsage('claude',{provider:'claude',source:'claude_statusline',state,observedAtEpochMs:prior?.observedAtEpochMs??null,lastSuccessAtEpochMs:prior?.lastSuccessAtEpochMs??null,stale:true,windows:[],errorCode});
  }
  async stop():Promise<void>{if(this.timer)clearInterval(this.timer);this.timer=null;await this.codex.stop();}
}
