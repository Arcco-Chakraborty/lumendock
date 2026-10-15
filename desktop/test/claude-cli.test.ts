import { describe,it,expect } from 'vitest';
import { mkdtempSync,writeFileSync,readFileSync,existsSync,chmodSync,symlinkSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';import { tmpdir } from 'node:os';
import { runClaudeInstallCommand,runClaudeUninstallCommand,type ClaudeCliDeps } from '../src/claude-cli.js';

// Temp directories only: no real Claude settings, no Claude process, no provider auth.
const setup=(settings:object|null)=>{
 const dir=mkdtempSync(join(tmpdir(),'phone-monitor-claude-cli-'));const settingsPath=join(dir,'settings.json');
 if(settings)writeFileSync(settingsPath,JSON.stringify(settings));
 const wrapperPath=join(dir,'wrapper.js');writeFileSync(wrapperPath,'// synthetic wrapper\n');chmodSync(wrapperPath,0o644);
 const out:string[]=[],err:string[]=[];
 const deps:ClaudeCliDeps={io:{out:l=>out.push(l),err:l=>err.push(l)},settingsPath,configDir:join(dir,'cfg'),nodePath:process.execPath,wrapperPath};
 return {dir,settingsPath,deps,out,err,read:()=>readFileSync(settingsPath,'utf8')};
};
const attest=['--previous-shell','/bin/sh','--claude-version','2.1.300','--attest-shell','--attest-cancellation'];
describe('claude-install / claude-uninstall commands',()=>{
 it('dry run reports state and writes nothing',async()=>{
  const o=setup({unrelated:1});const before=o.read();
  expect(await runClaudeInstallCommand(['--dry-run'],o.deps)).toBe(0);
  expect(o.read()).toBe(before);expect(existsSync(o.deps.configDir)).toBe(false);
  expect(o.out.join('\n')).toContain('Dry run: nothing is written.');
 });
 it('dry run fails when the wrapper is not built',async()=>{
  const o=setup({unrelated:1});
  expect(await runClaudeInstallCommand(['--dry-run'],{...o.deps,wrapperPath:join(o.dir,'missing.js')})).toBe(1);
  expect(o.out.join('\n')).toContain('NO (run npm ci');
 });
 it('installs with no existing status line, is idempotent, and uninstall removes only the owned field',async()=>{
  const o=setup({unrelated:1});
  expect(await runClaudeInstallCommand([],o.deps)).toBe(0);
  const installed=JSON.parse(o.read());expect(installed.unrelated).toBe(1);expect(installed.statusLine.command).toContain('exec ');
  expect(await runClaudeInstallCommand([],o.deps)).toBe(0);expect(o.out.join('\n')).toContain('Already installed');
  writeFileSync(o.settingsPath,JSON.stringify({...installed,unrelated:7}));
  expect(await runClaudeUninstallCommand([],o.deps)).toBe(0);expect(JSON.parse(o.read())).toEqual({unrelated:7});
  expect(await runClaudeUninstallCommand([],o.deps)).toBe(0);expect(o.out.join('\n')).toContain('Nothing to remove');
 });
 it('refuses an existing command without full attestation and changes nothing',async()=>{
  const o=setup({statusLine:{type:'command',command:'echo secret-existing-command'}});const before=o.read();
  expect(await runClaudeInstallCommand([],o.deps)).toBe(1);
  expect(await runClaudeInstallCommand(['--previous-shell','/bin/sh'],o.deps)).toBe(1);
  expect(await runClaudeInstallCommand(['--previous-shell','/bin/sh','--claude-version','2.1.300','--attest-cancellation'],o.deps)).toBe(1);
  expect(await runClaudeInstallCommand(['--previous-shell','/bin/sh','--claude-version','3.0.1','--attest-shell','--attest-cancellation'],o.deps)).toBe(1);
  expect(o.read()).toBe(before);expect(o.err.join('\n')).not.toContain('secret-existing-command');
  expect(o.err.length).toBe(4);
 });
 it('accepts an existing command only with every explicit attestation and restores it on uninstall',async()=>{
  const original={statusLine:{type:'command',command:'echo hi',padding:1}};const o=setup(original);
  expect(await runClaudeInstallCommand(attest,o.deps)).toBe(0);expect(JSON.parse(o.read()).statusLine.command).toContain('exec ');
  expect(await runClaudeUninstallCommand([],o.deps)).toBe(0);expect(JSON.parse(o.read())).toEqual(original);
 });
 it('dry run explains attestation requirements for an existing command without printing it',async()=>{
  const o=setup({statusLine:{type:'command',command:'echo secret-existing-command'}});
  expect(await runClaudeInstallCommand(['--dry-run'],o.deps)).toBe(0);
  const text=o.out.join('\n');expect(text).toContain('--attest-cancellation');expect(text).not.toContain('secret-existing-command');
 });
 it('refuses uninstall after the user changed the status line',async()=>{
  const o=setup({});await runClaudeInstallCommand([],o.deps);
  const edited={statusLine:{type:'command',command:'printf mine'}};writeFileSync(o.settingsPath,JSON.stringify(edited));
  expect(await runClaudeUninstallCommand([],o.deps)).toBe(1);expect(JSON.parse(o.read())).toEqual(edited);
 });
 it('rejects unknown, duplicate and relative arguments with exit 2',async()=>{
  const o=setup({});
  expect(await runClaudeInstallCommand(['--force'],o.deps)).toBe(2);
  expect(await runClaudeInstallCommand(['--dry-run','--dry-run'],o.deps)).toBe(2);
  expect(await runClaudeInstallCommand(['--settings','relative.json','--dry-run'],o.deps)).toBe(2);
  expect(await runClaudeInstallCommand(['--previous-shell','sh'],o.deps)).toBe(2);
  expect(await runClaudeUninstallCommand(['--wat'],o.deps)).toBe(2);
 });
 it('refuses a wrapper that cannot load (e.g. shared protocol not built) and changes nothing',async()=>{
  const o=setup({unrelated:1});const before=o.read();
  writeFileSync(o.deps.wrapperPath,"import '@phone-monitor/definitely-missing';\n");
  expect(await runClaudeInstallCommand([],o.deps)).toBe(1);
  expect(o.err.join('\n')).toContain('cannot load');expect(o.read()).toBe(before);
  expect(await runClaudeInstallCommand(['--dry-run'],o.deps)).toBe(1);
 });
 it('creates a missing settings folder for a first-time Claude user',async()=>{
  const o=setup(null);const nested=join(o.dir,'fresh','.claude','settings.json');
  expect(await runClaudeInstallCommand(['--settings',nested],o.deps)).toBe(0);
  expect(JSON.parse(readFileSync(nested,'utf8')).statusLine.command).toContain('exec ');
 });
 it('dry run and install both refuse a symlinked settings file with a clear message',async()=>{
  const o=setup(null);const real=join(o.dir,'real-settings.json');writeFileSync(real,JSON.stringify({unrelated:1}));
  symlinkSync(real,o.settingsPath);
  expect(await runClaudeInstallCommand(['--dry-run'],o.deps)).toBe(1);
  expect(o.out.join('\n')).toContain('symbolic link');
  expect(await runClaudeInstallCommand([],o.deps)).toBe(1);
  expect(o.err.join('\n')).toContain('symbolic link');
  expect(JSON.parse(readFileSync(real,'utf8'))).toEqual({unrelated:1});
 });
 it('reports a malformed override file as a warning after a successful install, not as a failure',async()=>{
  const o=setup({unrelated:1});const local=join(o.dir,'settings.local.json');writeFileSync(local,'{ // not json\n}');
  expect(await runClaudeInstallCommand([],{...o.deps,overrideSettingsPaths:[local]})).toBe(0);
  expect(o.out.join('\n')).toContain('Could not read');expect(o.err).toEqual([]);
  expect(JSON.parse(o.read()).statusLine.command).toContain('exec ');
 });
});
