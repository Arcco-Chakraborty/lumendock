import { isAbsolute } from 'node:path';

export interface UsbInternetOptions {serial:string;relay:string;relaySha256:string;port:number;lifetimeMs:number}
export interface RelayChild {ready():Promise<void>;exited:Promise<void>;stop():Promise<void>}
export interface UsbInternetDependencies {
  verifyRelay(options:UsbInternetOptions):Promise<void>;
  adb(args:string[]):Promise<string>;
  startRelay(file:string,args:string[]):Promise<RelayChild>;
  sleep(ms:number):Promise<void>;
}
const ipNumber=(ip:string)=>ip.split('.').reduce((n,part)=>n*256+Number(part),0);
const ipString=(n:number)=>[24,16,8,0].map(shift=>Math.floor(n/2**shift)%256).join('.');
/** IPv4 include routes for API29: subtract local/nonpublic ranges instead of relying on API33 excludeRoute. */
export function publicIpv4Routes():string[] {
  const excluded=['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12',
    '192.0.0.0/24','192.0.2.0/24','192.88.99.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/3']
    .map(cidr=>{const [ip,bits]=cidr.split('/');const start=ipNumber(ip!);return [start,start+2**(32-Number(bits))] as const;});
  const output:string[]=[];
  const visit=(start:number,bits:number):void=>{
    const end=start+2**(32-bits);
    if(excluded.some(([low,high])=>start>=low&&end<=high)) return;
    if(excluded.some(([low,high])=>start<high&&end>low)) {visit(start,bits+1);visit(start+2**(31-bits),bits+1);return;}
    output.push(`${ipString(start)}/${bits}`);
  };
  visit(0,0);return output;
}
export function createUsbInternetPlan(options:UsbInternetOptions) {
  const {serial,relay,relaySha256,port,lifetimeMs}=options;
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(serial)||serial.startsWith('emulator-')||!isAbsolute(relay)||/[\x00-\x1f\x7f]/.test(relay)||
    !/^[a-f0-9]{64}$/i.test(relaySha256)||!Number.isInteger(port)||port<1024||port>65535||[8765,8787].includes(port)||
    !Number.isInteger(lifetimeMs)||lifetimeMs<1000||lifetimeMs>8*60*60*1000) throw Error('USB_OPTIONS');
  const device=['-s',serial];
  const activity=['shell','am','start','-a'];
  const component=['-n','com.genymobile.gnirehtet/.GnirehtetActivity'];
  return {
    relayArgs:['relay','-p',String(port)],
    mapping:[...device,'reverse','--no-rebind','localabstract:gnirehtet',`tcp:${port}`],
    start:[...device,...activity,'com.genymobile.gnirehtet.START',...component,'--esa','dnsServers','8.8.8.8','--esa','routes',publicIpv4Routes().join(',')],
    stop:[...device,...activity,'com.genymobile.gnirehtet.STOP',...component],
  };
}
export function parseUsbInternetArgs(args:string[]):{command:'help'|'dry-run'|'start';options?:UsbInternetOptions} {
  if(args.length===0||args.length===1&&['help','--help','-h'].includes(args[0]!)) return {command:'help'};
  const command=args[0];
  if(command!=='dry-run'&&command!=='start') throw Error('USB_ARGUMENTS');
  const values=new Map<string,string>();let prepared=false;
  for(let i=1;i<args.length;i++) {
    const flag=args[i]!;
    if(flag==='--client-prepared'&&!prepared) {prepared=true;continue;}
    if(!['--serial','--relay','--relay-sha256','--port','--lifetime-seconds'].includes(flag)||values.has(flag)||!args[i+1]||args[i+1]!.startsWith('--')) throw Error('USB_ARGUMENTS');
    values.set(flag,args[++i]!);
  }
  if(!values.has('--serial')||!values.has('--relay')||!values.has('--relay-sha256')||command==='start'&&!prepared) throw Error('USB_ARGUMENTS');
  const options={serial:values.get('--serial')!,relay:values.get('--relay')!,relaySha256:values.get('--relay-sha256')!,port:Number(values.get('--port')??31416),lifetimeMs:Number(values.get('--lifetime-seconds')??3600)*1000};
  createUsbInternetPlan(options);return {command,options};
}

/** One foreground session. No persistent daemon/PID file and no cleanup of borrowed resources. */
export class UsbInternetSession {
  private readonly plan:ReturnType<typeof createUsbInternetPlan>;
  private child:RelayChild|undefined;
  private mappingOwned=false;
  private clientRequested=false;
  private stopped=false;
  private starting:Promise<void>|undefined;
  private stopping:Promise<void>|undefined;
  constructor(private readonly options:UsbInternetOptions,private readonly deps:UsbInternetDependencies) {this.plan=createUsbInternetPlan(options);}
  private adb(...args:string[]) {return this.deps.adb(['-s',this.options.serial,...args]);}
  private async mapping():Promise<string|undefined> {
    const rows=await this.adb('reverse','--list');
    return rows.split(/\r?\n/).map(row=>row.trim().split(/\s+/)).find(parts=>parts[0]===this.options.serial&&parts[1]==='localabstract:gnirehtet')?.[2];
  }
  get exited():Promise<void> {return this.child?.exited??Promise.resolve();}
  start():Promise<void> {
    if(this.starting) return this.starting;
    if(this.stopped) return Promise.reject(Error('USB_STOPPED'));
    this.starting=this.begin().catch(async error=>{await this.cleanup();throw error;});return this.starting;
  }
  private checkRunning():void {if(this.stopped) throw Error('USB_STOPPED');}
  private async begin():Promise<void> {
    await this.deps.verifyRelay(this.options);this.checkRunning();
    if((await this.adb('get-state')).trim()!=='device') throw Error('USB_DEVICE_UNAVAILABLE');
    if(!(await this.adb('shell','pm','path','com.genymobile.gnirehtet')).trim().startsWith('package:')) throw Error('USB_CLIENT_MISSING');
    if((await this.adb('shell','pidof','com.genymobile.gnirehtet')).trim()) throw Error('USB_CLIENT_IN_USE');
    if(await this.mapping()) throw Error('USB_MAPPING_IN_USE');
    for(let attempt=0;attempt<3;attempt++) {
      this.checkRunning();
      try {this.child=await this.deps.startRelay(this.options.relay,this.plan.relayArgs);await this.child.ready();break;}
      catch {await this.child?.stop().catch(()=>undefined);this.child=undefined;if(attempt===2) throw Error('USB_RELAY_UNAVAILABLE');await this.deps.sleep(attempt===0?250:1000);}
    }
    this.checkRunning();
    // no-rebind fails rather than stealing a mapping created after the preflight.
    await this.deps.adb(this.plan.mapping);this.mappingOwned=true;this.checkRunning();
    // If the activity reply is lost, its side effect is uncertain: clean up, never retry START.
    this.clientRequested=true;
    try {await this.deps.adb(this.plan.start);} catch {throw Error('USB_CLIENT_START_FAILED');}
    this.checkRunning();
  }
  private async cleanup():Promise<void> {
    let stillOwned=false;
    if(this.mappingOwned) {try {stillOwned=await this.mapping()===`tcp:${this.options.port}`;} catch { /* Device absent: cannot claim mapping ownership. */ }}
    if(stillOwned&&this.clientRequested) await this.deps.adb(this.plan.stop).catch(()=>undefined);
    if(stillOwned) await this.adb('reverse','--remove','localabstract:gnirehtet').catch(()=>undefined);
    this.mappingOwned=false;this.clientRequested=false;
    await this.child?.stop().catch(()=>undefined);this.child=undefined;
  }
  stop():Promise<void> {
    if(this.stopping) return this.stopping;
    this.stopped=true;
    this.stopping=(async()=>{await this.starting?.catch(()=>undefined);await this.cleanup();})();return this.stopping;
  }
}
