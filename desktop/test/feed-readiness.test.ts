import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HubCollectors } from '../src/collectors/index.js';
import { ClaudeObservationStore } from '../src/collectors/claude.js';
import { installClaudeStatusLine, inspectClaudeCapture } from '../src/claude/install.js';
import { HubStore } from '../src/store.js';
const temp = () => {
  const configDir = mkdtempSync(join(tmpdir(),'lumendock-readiness-'));
  const settingsPath = join(configDir,'settings.json'), wrapperPath = join(configDir,'wrapper.js');
  writeFileSync(settingsPath,JSON.stringify({unrelated:42}));writeFileSync(wrapperPath,'// synthetic wrapper');
  return {configDir,settingsPath,wrapperPath,nodePath:process.execPath};
};
const codex = {verifyVersion:async()=>{throw Error('synthetic unavailable');},spawn:()=>{throw Error('must not spawn');}};
afterEach(()=>vi.useRealTimers());
describe('Claude capture readiness',()=>{
  it('reports missing installation read-only without changing settings',()=>{
    const o=temp(),before=readFileSync(o.settingsPath);
    expect(inspectClaudeCapture(o.configDir)).toEqual({state:'not_installed'});
    expect(readFileSync(o.settingsPath)).toEqual(before);
  });
  it('recognizes exact owned settings and detects later ownership loss',async()=>{
    const o=temp();await installClaudeStatusLine(o);
    expect(inspectClaudeCapture(o.configDir)).toEqual({state:'ready'});
    writeFileSync(o.settingsPath,JSON.stringify({statusLine:{type:'command',command:'synthetic user edit'}}));
    expect(inspectClaudeCapture(o.configDir)).toEqual({state:'ownership_conflict'});
  });
  it('sanitizes malformed records and missing wrapper without exposing paths or commands',async()=>{
    const o=temp();await installClaudeStatusLine(o);unlinkSync(o.wrapperPath);
    expect(inspectClaudeCapture(o.configDir)).toEqual({state:'unavailable'});
    writeFileSync(join(o.configDir,'claude-install.json'),'synthetic bad JSON');
    expect(inspectClaudeCapture(o.configDir)).toEqual({state:'invalid'});
  });
  it('marks unconfigured usage unsupported but installed quiet usage awaiting data',async()=>{
    const o=temp();vi.useFakeTimers();const store=new HubStore();
    const collectors=new HubCollectors({store,configDir:o.configDir,nowMs:()=>10_000,codex});
    await collectors.start();
    expect(store.snapshot(10_000).usage.claude).toMatchObject({state:'unsupported',errorCode:'SOURCE_UNAVAILABLE',observedAtEpochMs:null,lastSuccessAtEpochMs:null,windows:[]});
    await installClaudeStatusLine(o);await vi.advanceTimersByTimeAsync(1000);
    expect(store.snapshot(10_000).usage.claude).toMatchObject({state:'awaiting_data',errorCode:null,observedAtEpochMs:null});
    await collectors.stop();
  });
  it('retains last good quotas and their original age when ownership is lost, including on restart',async()=>{
    const o=temp();await installClaudeStatusLine(o);const observations=new ClaudeObservationStore(o.configDir);
    const report=(api:number)=>({session_id:'synthetic-readiness',cost:{total_api_duration_ms:api},rate_limits:{five_hour:{used_percentage:25,resets_at:1900000000}}});
    await observations.capture(report(0),1000);await observations.capture(report(1),2000);
    writeFileSync(o.settingsPath,'{}');vi.useFakeTimers();const store=new HubStore();
    const collectors=new HubCollectors({store,configDir:o.configDir,nowMs:()=>10_000,codex});await collectors.start();
    expect(store.snapshot(10_000).usage.claude).toMatchObject({state:'unsupported',errorCode:'SOURCE_UNAVAILABLE',observedAtEpochMs:2000,lastSuccessAtEpochMs:2000,stale:true,windows:[{usedPercent:25,reportedAtEpochMs:2000}]});
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.snapshot(10_000).usage.claude.observedAtEpochMs).toBe(2000);await collectors.stop();
  });
});
