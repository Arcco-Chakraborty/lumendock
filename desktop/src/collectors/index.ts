import { ClaudeObservationStore } from './claude.js';
import { CodexCollector, type CodexCollectorOptions } from './codex.js';
import type { HubStore } from '../store.js';
export interface HubCollectorsOptions {store:HubStore;configDir:string;nowMs?:()=>number;codex?:Omit<CodexCollectorOptions,'store'|'nowMs'>}
export class HubCollectors {
  readonly codex:CodexCollector;
  private readonly claude:ClaudeObservationStore;
  private timer:ReturnType<typeof setInterval>|null=null;
  private readonly now:()=>number;
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
    try{const source=this.claude.read(this.now());if(source)this.options.store.updateUsage('claude',source);}
    catch{this.options.store.updateUsage('claude',{provider:'claude',source:'claude_statusline',state:'error',observedAtEpochMs:this.now(),lastSuccessAtEpochMs:null,stale:true,windows:[],errorCode:'BAD_PAYLOAD'});}
  }
  async stop():Promise<void>{if(this.timer)clearInterval(this.timer);this.timer=null;await this.codex.stop();}
}
