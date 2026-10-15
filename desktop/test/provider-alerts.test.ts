import { describe,expect,it } from 'vitest';
import { mkdtempSync,writeFileSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installClaudeAlerts,uninstallClaudeAlerts,installCodexAlerts,uninstallCodexAlerts,emitProviderAlert } from '../src/provider-alerts.js';
const setup=()=>{const configDir=mkdtempSync(join(tmpdir(),"lumendock alerts ' $()-")),settingsPath=join(configDir,'settings.json'),adapterPath=join(configDir,'adapter.js');writeFileSync(adapterPath,'// synthetic');return {configDir,settingsPath,adapterPath,nodePath:process.execPath};};
describe('fixed provider alerts',()=>{
 it('forwards only a fixed Claude attention event and never forwards input fields',()=>{
  const calls:string[][]=[];const input={hook_event_name:'Notification',notification_type:'permission_prompt',message:'SYNTHETIC_PRIVATE_BODY',transcript_path:'/synthetic/private',session_id:'synthetic-session'};
  expect(emitProviderAlert('claude',JSON.stringify(input),(_file,args)=>{calls.push(args);return true;})).toBe(true);
  expect(calls[0]).toContain('--app-name=Claude Code');expect(JSON.stringify(calls)).not.toMatch(/SYNTHETIC_PRIVATE_BODY|synthetic-session|\/synthetic\/private/);
 });
 it('forwards Codex completion as fixed text without response or user content',()=>{
  const calls:string[][]=[];expect(emitProviderAlert('codex',JSON.stringify({type:'agent-turn-complete','last-assistant-message':'SYNTHETIC_PRIVATE_BODY','input-messages':['SYNTHETIC_PRIVATE_PROMPT']}),(_file,args)=>{calls.push(args);return true;})).toBe(true);
  expect(calls[0]).toContain('--app-name=Codex');expect(JSON.stringify(calls)).not.toContain('SYNTHETIC_PRIVATE');
 });
 it('drops wrong events, malformed and oversized input without invoking a notifier',()=>{
  const run=()=>{throw Error('must not notify');};
  for(const payload of ['bad JSON','{}','x'.repeat(65537),JSON.stringify({hook_event_name:'Notification',notification_type:'auth_success'})])expect(emitProviderAlert('claude',payload,run)).toBe(false);
  expect(emitProviderAlert('codex',JSON.stringify({type:'other'}),run)).toBe(false);
 });
 it('owns only its exact Claude hook and preserves statusLine, unrelated hooks and later edits on rollback',async()=>{
  const o=setup(),original={statusLine:{type:'command',command:'synthetic untouched'},hooks:{Stop:[{hooks:[{type:'command',command:'synthetic stop'}]}],Notification:[{matcher:'synthetic-other',hooks:[{type:'command',command:'synthetic prior'}]}]},unrelated:1};
  writeFileSync(o.settingsPath,JSON.stringify(original));expect((await installClaudeAlerts(o)).changed).toBe(true);expect((await installClaudeAlerts(o)).changed).toBe(false);
  const installed=JSON.parse(readFileSync(o.settingsPath,'utf8'));expect(installed.statusLine).toEqual(original.statusLine);expect(installed.hooks.Notification).toHaveLength(2);
  installed.unrelated=2;installed.hooks.Stop.push({hooks:[{type:'command',command:'synthetic new'}]});writeFileSync(o.settingsPath,JSON.stringify(installed));
  await uninstallClaudeAlerts(o);const restored=JSON.parse(readFileSync(o.settingsPath,'utf8'));expect(restored.hooks.Notification).toEqual(original.hooks.Notification);expect(restored.hooks.Stop).toHaveLength(2);expect(restored.statusLine).toEqual(original.statusLine);expect(restored.unrelated).toBe(2);
 });
 it('refuses changed owned Claude hook without deleting user edits',async()=>{
  const o=setup();writeFileSync(o.settingsPath,'{}');await installClaudeAlerts(o);const current=JSON.parse(readFileSync(o.settingsPath,'utf8'));current.hooks.Notification[0].hooks[0].args.push('synthetic edit');writeFileSync(o.settingsPath,JSON.stringify(current));
  await expect(uninstallClaudeAlerts(o)).rejects.toThrow('ALERT_OWNERSHIP_CONFLICT');expect(JSON.parse(readFileSync(o.settingsPath,'utf8'))).toEqual(current);
 });
 it('adds Codex notify at the TOML root and removes only its prefix, preserving subsequent edits',async()=>{
  const o=setup();writeFileSync(o.settingsPath,'[synthetic]\nvalue = 1\n');expect((await installCodexAlerts(o)).changed).toBe(true);expect((await installCodexAlerts(o)).changed).toBe(false);
  const installed=readFileSync(o.settingsPath,'utf8');expect(installed.startsWith('# LumenDock provider alerts\nnotify = [')).toBe(true);writeFileSync(o.settingsPath,installed+'extra = 2\n');
  await uninstallCodexAlerts(o);expect(readFileSync(o.settingsPath,'utf8')).toBe('[synthetic]\nvalue = 1\nextra = 2\n');
 });
 it('refuses existing Codex notify without running or replacing it',async()=>{
  const o=setup();const original='"no\\u0074ify" = ["synthetic-existing"]\n';writeFileSync(o.settingsPath,original);
  await expect(installCodexAlerts(o)).rejects.toThrow('EXISTING_CODEX_NOTIFY');expect(readFileSync(o.settingsPath,'utf8')).toBe(original);
 });
 it('refuses malformed settings without changing them',async()=>{
  const o=setup();writeFileSync(o.settingsPath,'invalid JSON or TOML');await expect(installClaudeAlerts(o)).rejects.toThrow();expect(readFileSync(o.settingsPath,'utf8')).toBe('invalid JSON or TOML');await expect(installCodexAlerts(o)).rejects.toThrow('INVALID_CODEX_CONFIG');
 });
});
