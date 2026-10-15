import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWrite, ensurePrivateDirectory, readOwnedFile, readPrivateJson, withLock } from './private-files.js';
import { defaultConfigDirectory } from './config.js';
import { parseOptions } from './setup-cli.js';
import { inspectClaudeCapture } from './claude/install.js';

type Provider='claude'|'codex';
export interface AlertInstallOptions {settingsPath:string;configDir:string;nodePath:string;adapterPath:string}
interface AlertRecord {v:1;provider:Provider;settingsPath:string;phase:'pending'|'installed'|'uninstall_pending';entry?:unknown;prefix?:string;hadHooks?:boolean;hadNotification?:boolean}
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_ALERT_SETTINGS');return value as Record<string,unknown>;};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const recordPath=(dir:string,provider:Provider)=>join(dir,`${provider}-alerts-install.json`);
function recordAt(dir:string,provider:Provider):AlertRecord|null {
 const value=readPrivateJson(recordPath(dir,provider));if(value===null)return null;
 const r=object(value);if(r.v!==1||r.provider!==provider||typeof r.settingsPath!=='string'||!isAbsolute(r.settingsPath)||!['pending','installed','uninstall_pending'].includes(String(r.phase)))throw Error('BAD_ALERT_RECORD');
 if(provider==='codex'&&typeof r.prefix!=='string')throw Error('BAD_ALERT_RECORD');
 if(provider==='claude'&&(!r.entry||typeof r.hadHooks!=='boolean'||typeof r.hadNotification!=='boolean'))throw Error('BAD_ALERT_RECORD');
 return r as unknown as AlertRecord;
}
function bytesAt(path:string):Buffer|null{return existsSync(path)?readOwnedFile(path,1024*1024):null;}
function saveSettings(path:string,before:Buffer|null,after:string):void {
 if(!same(before?.toString('base64')??null,bytesAt(path)?.toString('base64')??null))throw Error('SETTINGS_CHANGED');
 atomicWrite(path,after,before?lstatSync(path).mode&0o777:0o600);
}
async function settingsLock<T>(o:AlertInstallOptions,task:()=>Promise<T>|T):Promise<T>{
 for(const path of [o.settingsPath,o.configDir,o.nodePath,o.adapterPath])if(!isAbsolute(path)||path.includes('\0'))throw Error('ABSOLUTE_PATH_REQUIRED');
 ensurePrivateDirectory(o.configDir);mkdirSync(dirname(o.settingsPath),{recursive:true,mode:0o700});
 return withLock(join(o.configDir,'provider-alerts.lock'),()=>withLock(`${o.settingsPath}.phone-monitor.lock`,task));
}
function checkAdapter(o:AlertInstallOptions):void {
 accessSync(o.nodePath,constants.X_OK);const s=lstatSync(o.adapterPath);
 if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.())throw Error('ALERT_ADAPTER_UNAVAILABLE');accessSync(o.adapterPath,constants.R_OK);
}
export async function installClaudeAlerts(o:AlertInstallOptions):Promise<{changed:boolean}>{
 return settingsLock(o,()=>{
  checkAdapter(o);const before=bytesAt(o.settingsPath),settings=before?object(JSON.parse(before.toString('utf8'))):{};
  const hooks=settings.hooks===undefined?{}:object(settings.hooks),list=hooks.Notification??[];
  if(!Array.isArray(list))throw Error('INVALID_ALERT_SETTINGS');
  const entry={matcher:'^(permission_prompt|idle_prompt|agent_needs_input|agent_completed)$',hooks:[{type:'command',command:o.nodePath,args:[o.adapterPath,'claude'],timeout:5}]};
  let record=recordAt(o.configDir,'claude');
  if(record){
   if(record.settingsPath!==o.settingsPath||!same(record.entry,entry))throw Error('ALERT_OWNERSHIP_CONFLICT');
   if(list.some(item=>same(item,entry))){atomicWrite(recordPath(o.configDir,'claude'),JSON.stringify({...record,phase:'installed'}));return {changed:false};}
   if(record.phase!=='pending')throw Error('ALERT_OWNERSHIP_CONFLICT');
  }else{
   if(list.some(item=>same(item,entry)))throw Error('ALERT_OWNERSHIP_CONFLICT');
   record={v:1,provider:'claude',settingsPath:o.settingsPath,phase:'pending',entry,hadHooks:Object.hasOwn(settings,'hooks'),hadNotification:Object.hasOwn(hooks,'Notification')};
   atomicWrite(recordPath(o.configDir,'claude'),JSON.stringify(record));
  }
  saveSettings(o.settingsPath,before,JSON.stringify({...settings,hooks:{...hooks,Notification:[...list,entry]}},null,2)+'\n');
  atomicWrite(recordPath(o.configDir,'claude'),JSON.stringify({...record,phase:'installed'}));return {changed:true};
 });
}
export async function uninstallClaudeAlerts(o:AlertInstallOptions):Promise<{changed:boolean}>{
 return settingsLock(o,()=>{
  const record=recordAt(o.configDir,'claude');if(!record)return {changed:false};
  if(record.settingsPath!==o.settingsPath)throw Error('ALERT_OWNERSHIP_CONFLICT');
  const before=bytesAt(o.settingsPath),settings=before?object(JSON.parse(before.toString('utf8'))):{},hooks=settings.hooks===undefined?{}:object(settings.hooks),list=hooks.Notification??[];
  if(!Array.isArray(list))throw Error('ALERT_OWNERSHIP_CONFLICT');
  const indexes=list.flatMap((entry,i)=>same(entry,record.entry)?[i]:[]);
  if(indexes.length!==1){
   if(!indexes.length&&record.phase!=='installed'){unlinkSync(recordPath(o.configDir,'claude'));return {changed:false};}
   throw Error('ALERT_OWNERSHIP_CONFLICT');
  }
  const remaining=list.filter((_entry,i)=>i!==indexes[0]),nextHooks={...hooks,Notification:remaining};
  if(!remaining.length&&!record.hadNotification)delete (nextHooks as Record<string,unknown>).Notification;
  const next={...settings,hooks:nextHooks};if(!Object.keys(nextHooks).length&&!record.hadHooks)delete (next as Record<string,unknown>).hooks;
  atomicWrite(recordPath(o.configDir,'claude'),JSON.stringify({...record,phase:'uninstall_pending'}));
  saveSettings(o.settingsPath,before,JSON.stringify(next,null,2)+'\n');unlinkSync(recordPath(o.configDir,'claude'));return {changed:true};
 });
}
// Python's standard TOML parser validates only this settings document; it emits one fixed metadata word.
// No configuration values, commands, credentials or parse-error text leave the subprocess.
function codexHasNotify(text:string):boolean {
 const result=spawnSync('/usr/bin/python3',['-c',"import sys,tomllib; d=tomllib.loads(sys.stdin.read()); print('present' if 'notify' in d else 'absent')"],{input:text,encoding:'utf8',timeout:3000,maxBuffer:1024*1024,stdio:['pipe','pipe','ignore']});
 if(result.status!==0||!['present','absent'].includes(result.stdout.trim()))throw Error('INVALID_CODEX_CONFIG');return result.stdout.trim()==='present';
}
export async function installCodexAlerts(o:AlertInstallOptions):Promise<{changed:boolean}>{
 return settingsLock(o,()=>{
  checkAdapter(o);const before=bytesAt(o.settingsPath),text=before?.toString('utf8')??'';
  const prefix='# LumenDock provider alerts\nnotify = '+JSON.stringify([o.nodePath,o.adapterPath,'codex'])+'\n\n';
  let record=recordAt(o.configDir,'codex');
  if(record){
   if(record.settingsPath!==o.settingsPath||record.prefix!==prefix)throw Error('ALERT_OWNERSHIP_CONFLICT');
   if(text.startsWith(prefix)){atomicWrite(recordPath(o.configDir,'codex'),JSON.stringify({...record,phase:'installed'}));return {changed:false};}
   if(record.phase!=='pending')throw Error('ALERT_OWNERSHIP_CONFLICT');
  }
  if(codexHasNotify(text))throw Error('EXISTING_CODEX_NOTIFY');
  record??={v:1,provider:'codex',settingsPath:o.settingsPath,phase:'pending',prefix};
  atomicWrite(recordPath(o.configDir,'codex'),JSON.stringify(record));saveSettings(o.settingsPath,before,prefix+text);
  atomicWrite(recordPath(o.configDir,'codex'),JSON.stringify({...record,phase:'installed'}));return {changed:true};
 });
}
export async function uninstallCodexAlerts(o:AlertInstallOptions):Promise<{changed:boolean}>{
 return settingsLock(o,()=>{
  const record=recordAt(o.configDir,'codex');if(!record)return {changed:false};if(record.settingsPath!==o.settingsPath)throw Error('ALERT_OWNERSHIP_CONFLICT');
  const before=bytesAt(o.settingsPath),text=before?.toString('utf8')??'';
  if(!text.startsWith(record.prefix!)){
   if(record.phase!=='installed'&&!codexHasNotify(text)){unlinkSync(recordPath(o.configDir,'codex'));return {changed:false};}
   throw Error('ALERT_OWNERSHIP_CONFLICT');
  }
  atomicWrite(recordPath(o.configDir,'codex'),JSON.stringify({...record,phase:'uninstall_pending'}));saveSettings(o.settingsPath,before,text.slice(record.prefix!.length));unlinkSync(recordPath(o.configDir,'codex'));return {changed:true};
 });
}
export type NotifierRunner=(command:string,args:string[])=>boolean;
const notify:NotifierRunner=(command,args)=>spawnSync(command,args,{stdio:'ignore',timeout:3000,shell:false}).status===0;
/** Read only event discriminators; all other hook input is discarded. Never read transcript_path. */
export function emitProviderAlert(provider:Provider,input:string,run:NotifierRunner=notify):boolean {
 if(Buffer.byteLength(input,'utf8')>65536)return false;
 let data:Record<string,unknown>;try{data=object(JSON.parse(input));}catch{return false;}
 let title:string,body:string;
 if(provider==='claude'){
  if(data.hook_event_name!=='Notification')return false;
  switch(data.notification_type){
   case 'permission_prompt':case 'agent_needs_input':title='Claude needs attention';body='Check Claude on the laptop.';break;
   case 'idle_prompt':case 'agent_completed':title='Claude is ready';body='A Claude task has finished or is waiting.';break;
   default:return false;
  }
 }else{if(data.type!=='agent-turn-complete')return false;title='Codex is ready';body='A Codex task has finished. Check the laptop.';}
 try{return run('/usr/bin/notify-send',[`--app-name=${provider==='claude'?'Claude Code':'Codex'}`,'--hint=string:desktop-entry:lumendock-provider-alerts','--expire-time=10000','--',title,body]);}catch{return false;}
}
async function main(args:string[]):Promise<void>{
 const command=args[0];
 if(command==='claude'){
  let input='',overflow=false;for await(const chunk of process.stdin){if(Buffer.byteLength(input)+chunk.length>65536){overflow=true;input='';}else if(!overflow)input+=chunk.toString('utf8');}
  if(!overflow)emitProviderAlert('claude',input);return;
 }
 if(command==='codex'){if(args.length===2)emitProviderAlert('codex',args[1]!);return;}
 const parsed=parseOptions(args.slice(1),{'--settings':'value','--config-dir':'value'});
 if(typeof parsed==='string')throw Error('INVALID_ALERT_ARGUMENTS');
 const configDir=parsed.values.get('--config-dir')??defaultConfigDirectory();
 if(command==='status'){console.log(JSON.stringify({claudeCapture:inspectClaudeCapture(configDir)}));return;}
 const provider=command?.endsWith('-claude')?'claude':command?.endsWith('-codex')?'codex':null;
 if(!provider||!['install-claude','uninstall-claude','install-codex','uninstall-codex'].includes(command!))throw Error('INVALID_ALERT_ARGUMENTS');
 const settingsPath=parsed.values.get('--settings')??(provider==='claude'?join(homedir(),'.claude','settings.json'):join(process.env.CODEX_HOME||join(homedir(),'.codex'),'config.toml'));
 const o={configDir,settingsPath,nodePath:process.execPath,adapterPath:fileURLToPath(import.meta.url)};
 const result=await (command!.startsWith('install-')?(provider==='claude'?installClaudeAlerts(o):installCodexAlerts(o)):(provider==='claude'?uninstallClaudeAlerts(o):uninstallCodexAlerts(o)));
 console.log(result.changed?'Provider alert setup updated.':'Provider alert setup unchanged.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main(process.argv.slice(2)).catch(error=>{const code=(error as Error).message;console.error(['ALERT_OWNERSHIP_CONFLICT','EXISTING_CODEX_NOTIFY','INVALID_CODEX_CONFIG'].includes(code)?code:'PROVIDER_ALERT_SETUP_FAILED');process.exitCode=1;});
}
