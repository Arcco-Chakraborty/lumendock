import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWrite, ensurePrivateDirectory, readPrivateJson, withLock } from '../private-files.js';
export const generationId=()=>randomBytes(24).toString('base64url');
export interface CalendarClient {clientId:string;clientSecret?:string}
export interface CalendarTokens {accessToken:string;refreshToken?:string;expiresAt:number}
export interface ConnectionState {generation:string;connected:boolean;selectionRevision:string;applied:boolean;selectedIds:string[];/** Set only when Google rejected the grant: the human must reconnect explicitly. */authRequired?:boolean}
const empty:ConnectionState={generation:'disconnected',connected:false,selectionRevision:'disconnected',applied:false,selectedIds:[]};
/** Replace and verify the DACL on this app's calendar directory; all private children inherit it. */
export function protectWindowsDirectory(path:string):void {
 // Rewrite only the DACL of the existing descriptor, and only when it is not already private: a fresh DirectorySecurity makes Set-Acl write the SACL too, which fails with SeSecurityPrivilege once the directory holds files.
 const script=`$ErrorActionPreference='Stop'; $p=$env:LUMENDOCK_CALENDAR_DIRECTORY; if([string]::IsNullOrEmpty($p)){throw 'ACL'}; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; function Test-Private{$a=Get-Acl -LiteralPath $p; if(-not $a.AreAccessRulesProtected -or $a.Access.Count -eq 0){return $false}; foreach($r in $a.Access){if($r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $r.AccessControlType -ne 'Allow'){return $false}}; return $true}; if(-not (Test-Private)){$acl=Get-Acl -LiteralPath $p; $acl.SetAccessRuleProtection($true,$false); foreach($r in @($acl.Access)){[void]$acl.RemoveAccessRule($r)}; $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl}; if(-not (Test-Private)){throw 'ACL'}`;
 // String -Command consumes trailing argv as PowerShell source, not as $args.
 // Keep the literal directory out of the program, including spaces and shell syntax.
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:'pipe',timeout:10000,windowsHide:true,env:{...process.env,LUMENDOCK_CALENDAR_DIRECTORY:path}});
}
export class CalendarConnectionStore {
 readonly directory:string;
 constructor(directory:string,private readonly options:{platform?:string;protectWindows?:(path:string)=>void}={}){this.directory=join(directory,'calendar');}
 private prepare():void {try{ensurePrivateDirectory(this.directory);if((this.options.platform??process.platform)==='win32')(this.options.protectWindows??protectWindowsDirectory)(this.directory);}catch{throw Error('CALENDAR_PRIVATE_STORAGE');}}
 read():ConnectionState {
  try { const v=readPrivateJson(join(this.directory,'connection.json'),32768) as ConnectionState|null;
   if(v===null)return {...empty,selectedIds:[]};
   if(typeof v.generation!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(v.generation)||typeof v.selectionRevision!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(v.selectionRevision)||typeof v.connected!=='boolean'||typeof v.applied!=='boolean'||(v.authRequired!==undefined&&typeof v.authRequired!=='boolean')||!Array.isArray(v.selectedIds)||v.selectedIds.length>100||v.selectedIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(id)))throw Error();
   return v;
  } catch {throw Error('CALENDAR_PRIVATE_STORAGE');}
 }
 private write(state:ConnectionState):void {atomicWrite(join(this.directory,'connection.json'),JSON.stringify(state));}
 private deleteCredentials():void {for(const name of ['client.json','tokens.json']){const p=join(this.directory,name);if(existsSync(p))unlinkSync(p);}}
 async beginConnect():Promise<string>{this.prepare();return withLock(join(this.directory,'connection.lock'),()=>{const generation=generationId();this.write({generation,connected:false,selectionRevision:generationId(),applied:false,selectedIds:[]});this.deleteCredentials();return generation;});}
 async finishConnect(generation:string,client:CalendarClient,tokens:CalendarTokens):Promise<boolean>{this.prepare();return withLock(join(this.directory,'connection.lock'),()=>{
  const current=this.read();if(current.generation!==generation)return false;
  atomicWrite(join(this.directory,'client.json'),JSON.stringify({generation,client}));atomicWrite(join(this.directory,'tokens.json'),JSON.stringify({generation,tokens}));this.write({...current,connected:true});return true;
 });}
 credentials(generation:string):{client:CalendarClient;tokens:CalendarTokens}|null {
  const state=this.read();if(!state.connected||state.generation!==generation)return null;
  const c=readPrivateJson(join(this.directory,'client.json'),32768) as {generation:string;client:CalendarClient}|null;
  const t=readPrivateJson(join(this.directory,'tokens.json'),32768) as {generation:string;tokens:CalendarTokens}|null;
  if(!c||!t||c.generation!==generation||t.generation!==generation||this.read().generation!==generation)return null;
  if(typeof c.client?.clientId!=='string'||typeof t.tokens?.accessToken!=='string'||!Number.isFinite(t.tokens.expiresAt))throw Error('CALENDAR_PRIVATE_STORAGE');
  return {client:c.client,tokens:t.tokens};
 }
 async saveTokens(generation:string,tokens:CalendarTokens):Promise<boolean>{this.prepare();return withLock(join(this.directory,'connection.lock'),()=>{
  const credentials=this.credentials(generation);if(!credentials)return false;
  atomicWrite(join(this.directory,'tokens.json'),JSON.stringify({generation,tokens:{...tokens,refreshToken:tokens.refreshToken??credentials.tokens.refreshToken}}));return true;
 });}
 async applySelection(generation:string,revision:string,ids:string[]):Promise<string>{this.prepare();return withLock(join(this.directory,'connection.lock'),()=>{
  const current=this.read();if(!current.connected||current.generation!==generation||current.selectionRevision!==revision)throw Error('CALENDAR_SELECTION_CHANGED');
  const selectionRevision=generationId();this.write({...current,applied:true,selectedIds:ids,selectionRevision});return selectionRevision;
 });}
 async invalidate(generation:string):Promise<void>{this.prepare();await withLock(join(this.directory,'connection.lock'),()=>{const c=this.read();if(c.generation!==generation)return;this.write({generation:generationId(),connected:false,selectionRevision:generationId(),applied:false,selectedIds:[],authRequired:true});this.deleteCredentials();});}
 async disconnect():Promise<void>{this.prepare();await withLock(join(this.directory,'connection.lock'),()=>{this.write({generation:generationId(),connected:false,selectionRevision:generationId(),applied:false,selectedIds:[]});this.deleteCredentials();});}
}
