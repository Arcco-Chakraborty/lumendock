import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Never run real host actions (mute, launchers) from tests: the route is exercised with a fake.
const executeAction = vi.hoisted(() => vi.fn(async (action: string) => ({ success: true, message: `synthetic ${action}` })));
vi.mock('../src/actions.js', () => ({ executeAction }));
import { buildHub } from '../src/server.js';
import { HubStore } from '../src/store.js';
import { TokenStore } from '../src/config.js';
import { PairingSession } from '../src/pairing.js';
import {
  CalendarPageSchema,
  CalendarSelectReplySchema,
  CalendarSourcesPageSchema,
  HubSnapshotSchema,
} from '@phone-monitor/protocol';
import { CalendarService } from '../src/calendar/service.js';
import { CalendarConnectionStore } from '../src/calendar/connection.js';

const fixtureHub = (): any => JSON.parse(readFileSync(new URL('../../packages/protocol/fixtures/hub-ready.json',import.meta.url),'utf8'));
const dirs: string[] = [];
const apps: ReturnType<typeof buildHub>[] = [];
const makeTestHub = (initial = fixtureHub()) => {
  const dir = mkdtempSync(join(tmpdir(),'phone-monitor-synthetic-')); dirs.push(dir);
  const tokenStore = new TokenStore(join(dir,'app')); const pairing = new PairingSession(tokenStore);
  let now = initial.serverNowEpochMs;
  const store = new HubStore({initialSnapshot:initial,notificationAllowlist:['Synthetic app']});
  const app = buildHub({store,pairing,tokenStore,clock:{nowMs:()=>now,monotonicMs:()=>now-initial.serverNowEpochMs}}); apps.push(app);
  return {app,store,pairing,tokenStore,advance:(ms:number)=>{now+=ms;}};
};
const headers = {host:'127.0.0.1:8765'};
const auth = { ...headers,authorization:`Bearer ${'a'.repeat(64)}` };
afterEach(async () => { await Promise.all(apps.splice(0).map(a=>a.close())); for(const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
describe('authenticated loopback API', () => {
  it('keeps health minimal and rejects unpaired requests without echoing auth', async () => {
    const {app} = makeTestHub();
    const health = await app.inject({url:'/healthz',headers}); expect(health.json()).toEqual({v:1,status:'ok'});
    const r = await app.inject({url:'/v1/snapshot',headers:{...headers,authorization:'Bearer secret-test-value'}});
    expect(r.statusCode).toBe(401); expect(r.body).not.toContain('secret-test-value'); expect(r.headers['cache-control']).toBe('no-store');
  });
  it('returns schema-valid paired snapshots and records only authenticated phone activity', async () => {
    const {app,tokenStore,store,advance} = makeTestHub(); tokenStore.write('a'.repeat(64));
    expect(store.isPhoneActive(0)).toBe(false);
    const r = await app.inject({url:'/v1/snapshot',headers:auth}); expect(r.statusCode).toBe(200);
    expect(HubSnapshotSchema.safeParse(r.json()).success).toBe(true); expect(store.isPhoneActive(9999)).toBe(true); expect(store.isPhoneActive(10000)).toBe(false);
    advance(10000); await app.inject({url:'/v1/snapshot',headers}); expect(store.isPhoneActive(10000)).toBe(false);
  });
  it.each(['localhost:8765','127.0.0.1','127.0.0.1:9999','attacker.example:8765'])('rejects Host %s', async host => {
    const {app,tokenStore} = makeTestHub(); tokenStore.write('a'.repeat(64));
    const r = await app.inject({url:'/v1/snapshot',headers:{...auth,host}}); expect(r.statusCode).toBe(403);
  });
  it('rejects every Origin header, query credentials, and wrong/missing bearer tokens', async () => {
    const {app,tokenStore} = makeTestHub(); tokenStore.write('a'.repeat(64));
    for(const origin of ['https://example.com','null','']) expect((await app.inject({url:'/healthz',headers:{...headers,origin}})).statusCode).toBe(403);
    for(const authorization of ['',`Bearer ${'b'.repeat(64)}`]) expect((await app.inject({url:'/v1/snapshot',headers:{...headers,authorization}})).statusCode).toBe(401);
    expect((await app.inject({url:'/v1/snapshot?token=synthetic-secret',headers:auth})).statusCode).toBe(400);
  });
  it('requires explicit setup and JSON-only strict pairing, counting invalid requests', async () => {
    const {app,pairing,tokenStore} = makeTestHub();
    expect((await app.inject({method:'POST',url:'/v1/pair',headers,payload:{code:'12345678'}})).statusCode).toBe(403);
    const code = pairing.open(fixtureHub().serverNowEpochMs);
    for(const payload of [{code,extra:1},{code:42},{}, {code:'bad'}]) expect((await app.inject({method:'POST',url:'/v1/pair',headers,payload})).statusCode).toBe(400);
    const r = await app.inject({method:'POST',url:'/v1/pair',headers,payload:{code}}); expect(r.statusCode).toBe(200); expect(tokenStore.matchesBearer(`Bearer ${r.json().token}`)).toBe(true);
    expect(r.headers['cache-control']).toBe('no-store'); expect((await app.inject({method:'POST',url:'/v1/pair',headers,payload:{code}})).statusCode).toBe(403);
  });
  it('rejects oversized/malformed/wrong-content pairing bodies without unsafe errors', async () => {
    const {app,pairing} = makeTestHub(); pairing.open(fixtureHub().serverNowEpochMs);
    for (const input of [
      {payload:'{',headers:{...headers,'content-type':'application/json'},status:400},
      {payload:'x'.repeat(16385),headers:{...headers,'content-type':'application/json'},status:413},
      {payload:'12345678',headers:{...headers,'content-type':'text/plain'},status:415},
    ]) {
      const r = await app.inject({method:'POST',url:'/v1/pair',payload:input.payload,headers:input.headers});
      expect(r.statusCode).toBe(input.status); expect(r.json()).toEqual({v:1,error:{code:'BAD_PAYLOAD'}}); expect(r.body).not.toContain('stack');
    }
  });
  it('applies pairing content-type checks and attempt counting to percent-encoded paths too', async () => {
    const {app,pairing} = makeTestHub(); const code = pairing.open(fixtureHub().serverNowEpochMs);
    for(let i=0;i<5;i++) {
      const r = await app.inject({method:'POST',url:'/v1/%70air',payload:'{',headers:{...headers,'content-type':'text/plain'}});
      expect(r.statusCode).toBe(415);
    }
    // Five rejected encoded-path attempts close pairing exactly like plain-path ones.
    expect((await app.inject({method:'POST',url:'/v1/pair',headers,payload:{code}})).statusCode).toBe(403);
  });
  it('closes setup after five failed HTTP bodies, with only one concurrent exchange success', async () => {
    const {app,pairing} = makeTestHub(); let code = pairing.open(fixtureHub().serverNowEpochMs);
    for(let i=0;i<5;i++) expect((await app.inject({method:'POST',url:'/v1/pair',headers,payload:{extra:'synthetic'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/v1/pair',headers,payload:{code}})).statusCode).toBe(403);
    code = pairing.open(fixtureHub().serverNowEpochMs);
    const results = await Promise.all([app.inject({method:'POST',url:'/v1/pair',headers,payload:{code}}),app.inject({method:'POST',url:'/v1/pair',headers,payload:{code}})]);
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,403]);
  });
});
describe('read-time source retention', () => {
  it('computes staleness and TTL under the injected wall clock without mutating stored data', () => {
    const {store,advance} = makeTestHub(); const t = fixtureHub().serverNowEpochMs;
    expect(store.snapshot(t+119999).usage.codex.stale).toBe(false);
    expect(store.snapshot(t+120000).usage.codex.stale).toBe(true);
    expect(store.snapshot(t+299999).usage.claude.stale).toBe(false);
    // Claude readings with a reset time stay current until that reset.
    expect(store.snapshot(t+300000).usage.claude.stale).toBe(false);
    expect(store.snapshot(t+1800000).notifications.items).toHaveLength(0);
    expect(store.snapshot(t).usage.claude.stale).toBe(false); advance(1);
  });
  it('retains good windows after a collector error or malformed replacement', () => {
    const {store} = makeTestHub(); const h = fixtureHub();
    store.updateUsage('codex',{...h.usage.codex,state:'error',errorCode:'SOURCE_UNAVAILABLE',windows:[]});
    const result = store.snapshot(h.serverNowEpochMs); expect(result.usage.codex.windows[0].usedPercent).toBe(17.25); expect(result.usage.codex.stale).toBe(true);
    expect(store.updateUsage('claude',{...h.usage.claude,windows:[{bad:true}]})).toBe(false);
    expect(store.snapshot(h.serverNowEpochMs).usage.claude.windows).toEqual(h.usage.claude.windows);
  });
  it('marks capacity overflow unsupported and retains good data rather than truncating new windows', () => {
    const {store} = makeTestHub(); const h = fixtureHub();
    const incoming = {...h.usage.codex,windows:Array.from({length:63},(_,i)=>({...h.usage.codex.windows[0],windowId:`synthetic-${i}`}))};
    expect(store.updateUsage('codex',incoming)).toBe(false);
    const result = store.snapshot(h.serverNowEpochMs).usage.codex;
    expect(result.state).toBe('unsupported'); expect(result.errorCode).toBe('SOURCE_CAPACITY_EXCEEDED'); expect(result.stale).toBe(true); expect(result.windows).toHaveLength(1);
    const empty = new HubStore(); empty.updateUsage('codex',incoming);
    expect(empty.snapshot(h.serverNowEpochMs).usage.codex.windows).toEqual([]);
  });
  it('starts with notification capture denied and stores only bounded allowlisted ephemeral records', () => {
    const store = new HubStore(); const h = fixtureHub(); const notification = h.notifications.items[0];
    expect(store.addNotification(notification)).toBe(false); expect(store.snapshot(h.serverNowEpochMs).notifications.state).toBe('disabled');
    const {store:allowed} = makeTestHub();
    for(let i=0;i<110;i++) allowed.addNotification({...notification,id:`synthetic-${i}`,receivedAtEpochMs:h.serverNowEpochMs+i,expiresAtEpochMs:h.serverNowEpochMs+i+1800000});
    expect(allowed.snapshot(h.serverNowEpochMs+200).notifications.items).toHaveLength(100);
    expect(allowed.snapshot(h.serverNowEpochMs+200).notifications.items[0].id).toBe('synthetic-10');
  });
  it('fits 256 KiB by omitting oldest complete notifications while retaining every usage window', () => {
    const h = fixtureHub(); const appId = '💡'.repeat(80);
    const store = new HubStore({notificationAllowlist:[appId]});
    for(const provider of ['claude','codex'] as const) {
      const windows = Array.from({length:provider === 'claude' ? 2 : 62},(_,i)=>({...h.usage[provider].windows[0],bucketId:'💡'.repeat(80),windowId:'💡'.repeat(75)+i.toString().padStart(5,'0'),label:'💡'.repeat(80)}));
      expect(store.updateUsage(provider,{...h.usage[provider],windows})).toBe(true);
    }
    for(let i=0;i<100;i++) expect(store.addNotification({id:'💡'.repeat(75)+i.toString().padStart(5,'0'),appId,title:'💡'.repeat(100),body:'💡'.repeat(280),receivedAtEpochMs:h.serverNowEpochMs+i,expiresAtEpochMs:h.serverNowEpochMs+i+1800000})).toBe(true);
    const snapshot = store.snapshot(h.serverNowEpochMs+100);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(262144);
    expect(snapshot.usage.codex.windows).toHaveLength(62); expect(snapshot.usage.claude.windows).toHaveLength(2);
    expect(snapshot.notifications.items.length).toBeLessThan(100);
    expect(snapshot.notifications.items.at(-1)?.id).toBe('💡'.repeat(75)+'00099');
    expect(snapshot.notifications.items.at(-1)?.body).toBe('💡'.repeat(280));
  });
  it('executes actions when authenticated and rejects unauthorized calls', async () => {
    const {app,tokenStore} = makeTestHub(); tokenStore.write('a'.repeat(64));
    const unauth = await app.inject({method:'POST',url:'/v1/action',headers,payload:{action:'media_play_pause'}});
    expect(unauth.statusCode).toBe(401);
    const bad = await app.inject({method:'POST',url:'/v1/action',headers:auth,payload:{}});
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({method:'POST',url:'/v1/action',headers:auth,payload:{action:'media_mute'}});
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(executeAction).toHaveBeenCalledWith('media_mute');
  });

  it('provides default disabled calendar replies when calendar service is absent and keeps snapshot byte-for-byte unchanged', async () => {
    const {app,tokenStore,store} = makeTestHub(); tokenStore.write('a'.repeat(64));
    const snapBefore = await app.inject({url:'/v1/snapshot',headers:auth});
    const rangeReq = {startDate:'2026-03-08',days:7,timeZone:'America/New_York'};

    for (const url of ['/v1/calendar/read','/v1/calendar/sources','/v1/calendar/select']) {
      expect((await app.inject({method:'POST',url,headers,payload:{}})).statusCode).toBe(401);
      expect((await app.inject({method:'POST',url:`${url}?x=1`,headers:auth,payload:{}})).statusCode).toBe(400);
      expect((await app.inject({method:'POST',url,headers:{...auth,origin:'https://evil.example'},payload:{}})).statusCode).toBe(403);
    }

    const readRes = await app.inject({method:'POST',url:'/v1/calendar/read',headers:auth,payload:rangeReq});
    expect(readRes.statusCode).toBe(200);
    expect(CalendarPageSchema.parse(readRes.json()).state).toBe('disabled');
    expect(store.isPhoneActive(0)).toBe(true);

    const sourcesRes = await app.inject({method:'POST',url:'/v1/calendar/sources',headers:auth,payload:{}});
    expect(sourcesRes.statusCode).toBe(200);
    expect(CalendarSourcesPageSchema.parse(sourcesRes.json()).state).toBe('disabled');

    const selectRes = await app.inject({method:'POST',url:'/v1/calendar/select',headers:auth,payload:{sourceIds:[],expectedRevision:'disconnected'}});
    expect(selectRes.statusCode).toBe(409);
    expect(selectRes.json()).toEqual({v:1,error:{code:'CALENDAR_AUTH_REQUIRED'}});

    const snapAfter = await app.inject({url:'/v1/snapshot',headers:auth});
    expect(snapAfter.body).toBe(snapBefore.body);
  });

  it('routes /v1/calendar/{read,sources,select} through CalendarService and validates payloads strictly', async () => {
    const dir = mkdtempSync(join(tmpdir(),'phone-monitor-cal-hub-')); dirs.push(dir);
    const tokenStore = new TokenStore(join(dir,'app')); tokenStore.write('a'.repeat(64));
    const pairing = new PairingSession(tokenStore);
    const now = fixtureHub().serverNowEpochMs;
    const store = new HubStore({initialSnapshot:fixtureHub(),notificationAllowlist:['Synthetic app']});
    const connStore = new CalendarConnectionStore(join(dir,'app'));
    const gen = await connStore.beginConnect();
    await connStore.finishConnect(gen,{clientId:'synthetic-id'},{accessToken:'synthetic-tok',refreshToken:'synthetic-ref',expiresAt:now+3600000});

    const calendar = new CalendarService({
      directory:join(dir,'app'),
      nowMs:()=>now,
      phoneActive:()=>store.isPhoneActive(0),
      fetch:async input => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/users/me/calendarList')) {
          return new Response(JSON.stringify({items:[{id:'work@example.com',summary:'Work',backgroundColor:'#22D3EE',accessRole:'owner'}]}),{status:200});
        }
        if (url.pathname.endsWith('/events')) {
          return new Response(JSON.stringify({items:[{id:'ev1',status:'confirmed',summary:'Desk Sync',start:{dateTime:'2026-03-08T15:00:00Z',timeZone:'America/New_York'},end:{dateTime:'2026-03-08T16:00:00Z',timeZone:'America/New_York'}}]}),{status:200});
        }
        return new Response(JSON.stringify({id:'work@example.com',labelProperties:{eventLabels:[]}}),{status:200});
      },
    });
    const app = buildHub({store,pairing,tokenStore,clock:{nowMs:()=>now,monotonicMs:()=>0},calendar});
    apps.push(app);

    // Invalid payloads rejected with 400 BAD_PAYLOAD
    for (const bad of [{startDate:'2026-03-08',days:7,timeZone:'America/New_York',refresh:true,cursor:'abc'},{startDate:'bad',days:7,timeZone:'UTC'},{extra:1}]) {
      const r = await app.inject({method:'POST',url:'/v1/calendar/read',headers:auth,payload:bad});
      expect(r.statusCode).toBe(400); expect(r.json()).toEqual({v:1,error:{code:'BAD_PAYLOAD'}});
    }

    // Initial sources discovery in setup_required
    await app.inject({method:'POST',url:'/v1/calendar/sources',headers:auth,payload:{}});
    await calendar.flush();
    const sourcesRes = await app.inject({method:'POST',url:'/v1/calendar/sources',headers:auth,payload:{}});
    const sourcesPage = CalendarSourcesPageSchema.parse(sourcesRes.json());
    expect(sourcesPage.state).toBe('setup_required');
    expect(sourcesPage.sources).toHaveLength(1);

    // Stale expectedRevision rejected with 409 CALENDAR_SELECTION_CHANGED
    const staleSelect = await app.inject({method:'POST',url:'/v1/calendar/select',headers:auth,payload:{sourceIds:[],expectedRevision:'wrong_rev'}});
    expect(staleSelect.statusCode).toBe(409);
    expect(staleSelect.json()).toEqual({v:1,error:{code:'CALENDAR_SELECTION_CHANGED'}});

    // Apply selection and read range
    const selectRes = await app.inject({method:'POST',url:'/v1/calendar/select',headers:auth,payload:{sourceIds:[sourcesPage.sources[0]!.sourceId],expectedRevision:sourcesPage.selectionRevision}});
    expect(selectRes.statusCode).toBe(200);
    expect(CalendarSelectReplySchema.parse(selectRes.json()).selectionRevision).toBeTruthy();

    const rangeReq = {startDate:'2026-03-08',days:7,timeZone:'America/New_York'};
    await app.inject({method:'POST',url:'/v1/calendar/read',headers:auth,payload:rangeReq});
    await calendar.flush();
    const readRes = await app.inject({method:'POST',url:'/v1/calendar/read',headers:auth,payload:rangeReq});
    const page = CalendarPageSchema.parse(readRes.json());
    expect(page.state).toBe('available');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.title).toBe('Desk Sync');
    calendar.stop();
  });
});
