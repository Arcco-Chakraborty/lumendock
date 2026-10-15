import { describe,it,expect } from 'vitest';
import { mkdtempSync,writeFileSync,readFileSync,statSync } from 'node:fs';
import { join } from 'node:path';import { tmpdir } from 'node:os';
import { installClaudeStatusLine,uninstallClaudeStatusLine } from '../src/claude/install.js';
const setup=()=>{const dir=mkdtempSync(join(tmpdir(),"phone-monitor ' $()`ユニ-"));const settingsPath=join(dir,'settings.json');writeFileSync(settingsPath,JSON.stringify({unrelated:1,statusLine:{type:'command',command:'cat',padding:2,refreshInterval:3}}));const wrapperPath=join(dir,"wrapper ' $()`ユニ.js");writeFileSync(wrapperPath,'process.stdin.pipe(process.stdout);');return {settingsPath,configDir:join(dir,'private'),wrapperPath,nodePath:process.execPath};};
const compatibility={claudeVersion:'2.1.300',shellPath:'/bin/sh',shellVerified:true,cancellationVerified:true};
describe('opt-in settings ownership',()=>{
 it('refuses undeclared shell and unverified cancellation without edits',async()=>{
  const o=setup();const before=readFileSync(o.settingsPath,'utf8');
  await expect(installClaudeStatusLine(o)).rejects.toThrow('PREVIOUS_SHELL_REQUIRED');
  await expect(installClaudeStatusLine({...o,previousShell:'/bin/sh'})).rejects.toThrow('CANCELLATION_COMPATIBILITY_REQUIRED');
  expect(readFileSync(o.settingsPath,'utf8')).toBe(before);
 });
 it('installs idempotently and restores only owned field preserving unrelated edits',async()=>{
  const o=setup();const opts={...o,previousShell:'/bin/sh',compatibility};
  const first=await installClaudeStatusLine(opts);expect(first.changed).toBe(true);
  const configured=JSON.parse(readFileSync(o.settingsPath,'utf8'));expect(configured.statusLine).toMatchObject({padding:2,refreshInterval:3,type:'command'});
  expect(configured.statusLine.command).toContain('exec ');
  expect((await installClaudeStatusLine(opts)).changed).toBe(false);
  writeFileSync(o.settingsPath,JSON.stringify({...configured,unrelated:42}));
  await uninstallClaudeStatusLine(o);expect(JSON.parse(readFileSync(o.settingsPath,'utf8'))).toEqual({unrelated:42,statusLine:{type:'command',command:'cat',padding:2,refreshInterval:3}});
  expect(statSync(o.configDir).mode&0o777).toBe(0o700);
 });
 it('detects conflicting ownership without overwriting edits',async()=>{
  const o=setup();await installClaudeStatusLine({...o,previousShell:'/bin/sh',compatibility});
  const edited={unrelated:5,statusLine:{type:'command',command:'printf changed'}};writeFileSync(o.settingsPath,JSON.stringify(edited));
  await expect(uninstallClaudeStatusLine(o)).rejects.toThrow('STATUSLINE_OWNERSHIP_CONFLICT');expect(JSON.parse(readFileSync(o.settingsPath,'utf8'))).toEqual(edited);
 });
 it('supports no original command and refuses shell mismatch',async()=>{
  const o=setup();await expect(installClaudeStatusLine({...o,previousShell:'/bin/bash',compatibility})).rejects.toThrow('PREVIOUS_SHELL_UNVERIFIED');
  writeFileSync(o.settingsPath,'{"unrelated":1}');await installClaudeStatusLine(o);await uninstallClaudeStatusLine(o);expect(JSON.parse(readFileSync(o.settingsPath,'utf8'))).toEqual({unrelated:1});
 });
});
it('executes quoted Node/wrapper/config paths as data and stores an exact private backup',async()=>{
 const {spawn}=await import('node:child_process');const {existsSync}=await import('node:fs');const o=setup();writeFileSync(o.wrapperPath,'process.stdin.pipe(process.stdout);');
 const original=readFileSync(o.settingsPath);await installClaudeStatusLine({...o,previousShell:'/bin/sh',compatibility});
 expect(readFileSync(join(o.configDir,'claude-settings.backup'))).toEqual(original);expect(statSync(join(o.configDir,'claude-settings.backup')).mode&0o777).toBe(0o600);
 const command=JSON.parse(readFileSync(o.settingsPath,'utf8')).statusLine.command;
 const child=spawn('/bin/sh',['-c',command],{cwd:o.configDir,stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stdin.end('synthetic $() `data` ユニ');
 const code=await new Promise(resolve=>child.once('exit',resolve));expect(code).toBe(0);expect(output).toBe('synthetic $() `data` ユニ');expect(existsSync(join(o.configDir,'INJECTED'))).toBe(false);
});
it('diagnoses explicitly supplied override settings and serializes concurrent installs',async()=>{
 const o=setup();const override=join(o.configDir,'override.json');const {mkdirSync}=await import('node:fs');mkdirSync(o.configDir);writeFileSync(override,'{"statusLine":{"type":"command","command":"synthetic"}}');
 const opts={...o,previousShell:'/bin/sh',compatibility,overrideSettingsPaths:[override]};const results=await Promise.all([installClaudeStatusLine(opts),installClaudeStatusLine(opts)]);
 expect(results.map(r=>r.changed).sort()).toEqual([false,true]);expect(results[0]!.diagnostics[0]).toContain('override');await uninstallClaudeStatusLine(o);expect((await uninstallClaudeStatusLine(o)).changed).toBe(false);
});
it('refuses a missing wrapper before replacing the status line',async()=>{
 const o=setup();const before=readFileSync(o.settingsPath,'utf8');await expect(installClaudeStatusLine({...o,wrapperPath:join(o.configDir,'missing-wrapper.js'),previousShell:'/bin/sh',compatibility})).rejects.toThrow('WRAPPER_UNAVAILABLE');expect(readFileSync(o.settingsPath,'utf8')).toBe(before);
});
