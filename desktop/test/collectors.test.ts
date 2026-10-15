import { it,expect,vi,afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';import { join } from 'node:path';import { tmpdir } from 'node:os';
import { ClaudeObservationStore } from '../src/collectors/claude.js';
import { HubCollectors } from '../src/collectors/index.js';
import { HubStore } from '../src/store.js';
afterEach(()=>vi.useRealTimers());
it('loads reports without inventing reload freshness, isolates absent Codex and stops polling',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'phone-monitor-runtime-'));const observations=new ClaudeObservationStore(dir);
 const report=(api:number)=>({session_id:'synthetic-runtime',cost:{total_api_duration_ms:api},rate_limits:{five_hour:{used_percentage:25,resets_at:1900000000}}});
 await observations.capture(report(0),1000);await observations.capture(report(1),2000);
 vi.useFakeTimers();const store=new HubStore();const collectors=new HubCollectors({store,configDir:dir,nowMs:()=>400000,codex:{verifyVersion:async()=>{throw Error('synthetic missing binary');},spawn:()=>{throw Error('must not spawn');}}});
 await collectors.start();expect(store.snapshot(400000).usage.claude).toMatchObject({observedAtEpochMs:2000,stale:true});expect(store.snapshot(400000).usage.codex.errorCode).toBe('SOURCE_UNAVAILABLE');
 await collectors.stop();expect(vi.getTimerCount()).toBe(0);
});
