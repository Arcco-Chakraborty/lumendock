import { accessSync, constants, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ensurePrivateDirectory, readOwnedFile, readPrivateJson, atomicWrite, withLock } from '../private-files.js';

export interface ClaudeCompatibility {
  claudeVersion:string;shellPath:string;shellVerified:boolean;cancellationVerified:boolean;
}
export interface InstallOptions {
  settingsPath:string;wrapperPath:string;configDir:string;nodePath:string;previousShell?:string;compatibility?:ClaudeCompatibility;
  overrideSettingsPaths?:readonly string[];
}
export interface ClaudeInstallation {
  v:1;phase:'install_pending'|'installed'|'uninstall_pending';settingsPath:string;wrapperPath:string;nodePath:string;previousStatusLine:unknown;hadStatusLine:boolean;
  installedStatusLine:Record<string,unknown>;previousCommand:string|null;previousShell:string|null;compatibility:ClaudeCompatibility|null;
}
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('INVALID_SETTINGS');return v as Record<string,unknown>;};
const equal=(a:unknown,b:unknown):boolean=>JSON.stringify(a)===JSON.stringify(b);
// POSIX single-quote encoding; values never become executable shell syntax.
export const shellQuote=(value:string):string=>`'${value.replaceAll("'","'\\''")}'`;
export function readClaudeInstallation(configDir:string):ClaudeInstallation|null {
  const raw=readPrivateJson(join(configDir,'claude-install.json'));if(raw===null)return null;
  const data=object(raw);
  if(data.v!==1||typeof data.settingsPath!=='string'||typeof data.wrapperPath!=='string'||typeof data.nodePath!=='string'||typeof data.hadStatusLine!=='boolean'||!(data.previousCommand===null||typeof data.previousCommand==='string')||!(data.previousShell===null||typeof data.previousShell==='string'))throw Error('BAD_INSTALLATION_RECORD');
  object(data.installedStatusLine);
  if(data.phase!==undefined&&!['install_pending','installed','uninstall_pending'].includes(String(data.phase)))throw Error('BAD_INSTALLATION_RECORD');
  return {...data,phase:data.phase??'installed'} as unknown as ClaudeInstallation;
}
export interface ClaudeCaptureReadiness {state:'not_installed'|'ready'|'ownership_conflict'|'unavailable'|'invalid'}
/** Read-only, sanitized ownership check. Never returns a command, path or provider identity. */
export function inspectClaudeCapture(configDir:string):ClaudeCaptureReadiness {
  try {
    const record=readClaudeInstallation(configDir);
    if(!record)return {state:'not_installed'};
    if(![record.settingsPath,record.wrapperPath,record.nodePath].every(isAbsolute))return {state:'invalid'};
    const settings=object(JSON.parse(readOwnedFile(record.settingsPath,1024*1024).toString('utf8')));
    if(!equal(settings.statusLine,record.installedStatusLine))return {state:'ownership_conflict'};
    try {
      const wrapper=lstatSync(record.wrapperPath);
      if(!wrapper.isFile()||wrapper.isSymbolicLink()||wrapper.uid!==process.getuid?.())return {state:'unavailable'};
      accessSync(record.wrapperPath,constants.R_OK);accessSync(record.nodePath,constants.X_OK);
    }catch{return {state:'unavailable'};}
    return {state:'ready'};
  }catch{return {state:'invalid'};}
}
function matchesOriginal(settings:Record<string,unknown>,record:ClaudeInstallation):boolean {
  return Object.hasOwn(settings,'statusLine')===record.hadStatusLine&&(!record.hadStatusLine||equal(settings.statusLine,record.previousStatusLine));
}
function saveRecord(configDir:string,record:ClaudeInstallation):void {atomicWrite(join(configDir,'claude-install.json'),JSON.stringify(record));}
function writeSettings(settingsPath:string,bytes:Buffer|null,settings:Record<string,unknown>):void {
  const latest=existsSync(settingsPath)?readOwnedFile(settingsPath,1024*1024):null;
  if(!equal(bytes?.toString('base64')??null,latest?.toString('base64')??null))throw Error('SETTINGS_CHANGED');
  atomicWrite(settingsPath,`${JSON.stringify(settings,null,2)}\n`,bytes?lstatSync(settingsPath).mode&0o777:0o600);
}
function activate(record:ClaudeInstallation,configDir:string,bytes:Buffer|null,settings:Record<string,unknown>):void {
  // The pending record must be readable before the command is activated.
  // Recovery distinguishes either side of the atomic settings commit.
  writeSettings(record.settingsPath,bytes,{...settings,statusLine:record.installedStatusLine});
  saveRecord(configDir,{...record,phase:'installed'});
}
export function diagnoseClaudeOverrides(paths:readonly string[]):string[] {
  const diagnostics:string[]=[];
  for(const path of paths)if(existsSync(path)){
    // Runs after the settings commit, so a malformed/unsafe override file must be reported, never thrown.
    try{
      const data=object(JSON.parse(readOwnedFile(path,1024*1024).toString('utf8')));
      if(Object.hasOwn(data,'statusLine'))diagnostics.push(`Status line override present at ${path}; the user-level wrapper may not run.`);
    }catch{diagnostics.push(`Could not read ${path} (not plain JSON, a symlink, or too large); check it does not override statusLine.`);}
  }
  return diagnostics;
}
export async function installClaudeStatusLine(options:InstallOptions):Promise<{changed:boolean;diagnostics:string[]}> {
  for(const path of [options.settingsPath,options.wrapperPath,options.configDir,options.nodePath])if(!isAbsolute(path)||path.includes('\0'))throw Error('ABSOLUTE_PATH_REQUIRED');
  accessSync(options.nodePath,constants.X_OK);
  try{const wrapper=lstatSync(options.wrapperPath);if(!wrapper.isFile()||wrapper.isSymbolicLink()||wrapper.uid!==process.getuid?.())throw Error();accessSync(options.wrapperPath,constants.R_OK);}catch{throw Error('WRAPPER_UNAVAILABLE');}
  ensurePrivateDirectory(options.configDir);
  return withLock(join(options.configDir,'claude-installer.lock'),()=>withLock(`${options.settingsPath}.phone-monitor.lock`,()=>{
    const bytes=existsSync(options.settingsPath)?readOwnedFile(options.settingsPath,1024*1024):null;
    const settings=bytes?object(JSON.parse(bytes.toString('utf8'))):{};
    const record=readClaudeInstallation(options.configDir);
    if(record){
      if(record.settingsPath!==resolve(options.settingsPath)||record.wrapperPath!==options.wrapperPath||record.nodePath!==options.nodePath)throw Error('STATUSLINE_OWNERSHIP_CONFLICT');
      if(equal(settings.statusLine,record.installedStatusLine)){
        if(record.phase!=='installed')saveRecord(options.configDir,{...record,phase:'installed'});
        return {changed:false,diagnostics:diagnoseClaudeOverrides(options.overrideSettingsPaths??[])};
      }
      if(record.phase==='installed'||!matchesOriginal(settings,record))throw Error('STATUSLINE_OWNERSHIP_CONFLICT');
      if(record.phase==='install_pending'){
        activate(record,options.configDir,bytes,settings);
        return {changed:true,diagnostics:diagnoseClaudeOverrides(options.overrideSettingsPaths??[])};
      }
      // A completed interrupted uninstall can be retired before a new install.
      unlinkSync(join(options.configDir,'claude-install.json'));
    }
    const hadStatusLine=Object.hasOwn(settings,'statusLine');const before=hadStatusLine?object(settings.statusLine):null;
    if(before&&(before.type!=='command'||typeof before.command!=='string'))throw Error('UNSUPPORTED_STATUSLINE');
    const previousCommand=before?.command as string|undefined;
    if(previousCommand!==undefined){
      if(!options.previousShell||!isAbsolute(options.previousShell))throw Error('PREVIOUS_SHELL_REQUIRED');
      const compatible=options.compatibility;
      if(!compatible?.cancellationVerified||!/^2\.1\.\d+$/.test(compatible.claudeVersion))throw Error('CANCELLATION_COMPATIBILITY_REQUIRED');
      if(!compatible.shellVerified||compatible.shellPath!==options.previousShell)throw Error('PREVIOUS_SHELL_UNVERIFIED');
      accessSync(options.previousShell,constants.X_OK);
    }
    const installed={...(before??{type:'command'}),command:`exec ${shellQuote(options.nodePath)} ${shellQuote(options.wrapperPath)} --config-dir ${shellQuote(options.configDir)}`};
    const install:ClaudeInstallation={v:1,phase:'install_pending',settingsPath:resolve(options.settingsPath),wrapperPath:options.wrapperPath,nodePath:options.nodePath,hadStatusLine,previousStatusLine:settings.statusLine??null,installedStatusLine:installed,previousCommand:previousCommand??null,previousShell:previousCommand!==undefined?options.previousShell!:null,compatibility:previousCommand!==undefined?options.compatibility!:null};
    if(bytes)atomicWrite(join(options.configDir,'claude-settings.backup'),bytes);
    saveRecord(options.configDir,install);
    activate(install,options.configDir,bytes,settings);
    return {changed:true,diagnostics:diagnoseClaudeOverrides(options.overrideSettingsPaths??[])};
  }));
}
export async function uninstallClaudeStatusLine(options:{settingsPath:string;configDir:string}):Promise<{changed:boolean}> {
  ensurePrivateDirectory(options.configDir);
  return withLock(join(options.configDir,'claude-installer.lock'),()=>withLock(`${options.settingsPath}.phone-monitor.lock`,()=>{
    const record=readClaudeInstallation(options.configDir);if(!record)return {changed:false};
    if(record.settingsPath!==resolve(options.settingsPath))throw Error('STATUSLINE_OWNERSHIP_CONFLICT');
    const bytes=existsSync(options.settingsPath)?readOwnedFile(options.settingsPath,1024*1024):null;const settings=bytes?object(JSON.parse(bytes.toString('utf8'))):{};
    if(record.phase!=='installed'&&matchesOriginal(settings,record)){
      unlinkSync(join(options.configDir,'claude-install.json'));return {changed:false};
    }
    if(!equal(settings.statusLine,record.installedStatusLine))throw Error('STATUSLINE_OWNERSHIP_CONFLICT');
    saveRecord(options.configDir,{...record,phase:'uninstall_pending'});
    if(record.hadStatusLine)settings.statusLine=record.previousStatusLine;else delete settings.statusLine;
    writeSettings(options.settingsPath,bytes,settings);
    unlinkSync(join(options.configDir,'claude-install.json'));
    return {changed:true};
  }));
}
