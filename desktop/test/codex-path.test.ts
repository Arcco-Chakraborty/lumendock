import { describe,it,expect } from 'vitest';
import { mkdtempSync,mkdirSync,writeFileSync,chmodSync,utimesSync } from 'node:fs';
import { join } from 'node:path';import { tmpdir } from 'node:os';
import { codexCandidates,resolveCodexPath } from '../src/codex-path.js';

// Synthetic home/config directories only; no real Codex binary is run.
const win=process.platform==='win32',BIN=win?'codex.exe':'codex',BUNDLED=win?'bin/windows-x86_64/codex.exe':'bin/linux-x86_64/codex';
const exe=(path:string,mtime=1000)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,'#!/bin/sh\n');chmodSync(path,0o755);utimesSync(path,mtime,mtime);return path;};
const setup=()=>{const dir=mkdtempSync(join(tmpdir(),'phone-monitor-codex-path-'));const home=join(dir,'home'),configDir=join(dir,'cfg');mkdirSync(home);mkdirSync(configDir,{mode:0o700});return {dir,home,configDir};};
describe('Codex binary resolution',()=>{
 it('finds the newest bundled VS Code extension binary when codex is not on PATH',async()=>{
  const o=setup();
  exe(join(o.home,'.vscode/extensions/openai.chatgpt-1.0.0-linux-x64/'+BUNDLED),1000);
  const newest=exe(join(o.home,'.vscode/extensions/openai.chatgpt-2.0.0-linux-x64/'+BUNDLED),2000);
  expect(resolveCodexPath({configDir:o.configDir,home:o.home,env:{PATH:join(o.dir,'empty-bin')}})).toBe(newest);
 });
 it('prefers PHONE_MONITOR_CODEX, then config codexPath, then PATH',async()=>{
  const o=setup();const envBin=exe(join(o.dir,'env',BIN));const cfgBin=exe(join(o.dir,'cfg-bin',BIN));const pathBin=exe(join(o.dir,'bin',BIN));
  writeFileSync(join(o.configDir,'config.json'),JSON.stringify({codexPath:cfgBin}));chmodSync(join(o.configDir,'config.json'),0o600);
  expect(resolveCodexPath({configDir:o.configDir,home:o.home,env:{PHONE_MONITOR_CODEX:envBin,PATH:join(o.dir,'bin')}})).toBe(envBin);
  expect(resolveCodexPath({configDir:o.configDir,home:o.home,env:{PATH:join(o.dir,'bin')}})).toBe(cfgBin);
  expect(codexCandidates({configDir:join(o.dir,'none'),home:o.home,env:{PATH:join(o.dir,'bin')}})[0]).toBe(pathBin);
 });
 it('ignores relative paths and non-executables and falls back to plain codex',async()=>{
  const o=setup();const plain=join(o.dir,'bin/codex');mkdirSync(join(o.dir,'bin'));writeFileSync(plain,'x');chmodSync(plain,0o644);
  expect(resolveCodexPath({configDir:o.configDir,home:o.home,env:{PHONE_MONITOR_CODEX:'relative/codex',PATH:join(o.dir,'bin')}})).toBe('codex');
 });
});
