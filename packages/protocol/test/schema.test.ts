import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AppStatusSchema, BridgeRequestSchema, BridgeReplyDataSchemas, BridgeReplySchemaFor,
  EspStateSchema, EspSnapshotSchema, EspHistorySchema, HubSnapshotSchema, LightPatchSchema } from '../src/index.js';

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
const fixtureHub = () => fixture('hub-ready');
const fixtureWithClaude = (source: any) => ({ ...fixtureHub(), usage: { ...fixtureHub().usage, claude: source } });
describe('wire boundaries', () => {
  it('validates every shared synthetic fixture', () => {
    for (const name of ['hub-ready', 'hub-unknown']) expect(HubSnapshotSchema.safeParse(fixture(name)).success).toBe(true);
    expect(EspStateSchema.safeParse(fixture('esp-ready')).success).toBe(true);
    expect(EspHistorySchema.safeParse(fixture('esp-history')).success).toBe(true);
    expect(AppStatusSchema.safeParse(fixture('app-status')).success).toBe(true);
    expect(EspSnapshotSchema.safeParse(fixture('esp-link-ready')).success).toBe(true);
  });
  it('accepts optional laptop host state and rejects malformed host fields', () => {
    const host = fixture('hub-host');
    expect(HubSnapshotSchema.safeParse(host).success).toBe(true);
    expect(HubSnapshotSchema.safeParse({...host, host:{...host.host, media:null, volumePercent:null, muted:null, micMuted:null, doNotDisturb:null}}).success).toBe(true);
    for (const bad of [{volumePercent:151}, {volumePercent:4.5}, {micMuted:'yes'}, {media:{...host.host.media, status:'buffering'}}, {media:{...host.host.media, title:'x'.repeat(121)}}, {extra:true}])
      expect(HubSnapshotSchema.safeParse({...host, host:{...host.host, ...bad}}).success).toBe(false);
  });
  it('keeps absent usage distinct from zero and preserves fractional/above-limit percentages', () => {
    const source = fixtureHub().usage.claude;
    for (const value of [null, 0, 17.25, 120]) {
      source.windows[0].usedPercent = value;
      expect(HubSnapshotSchema.parse(fixtureWithClaude(source)).usage.claude.windows[0]?.usedPercent).toBe(value);
    }
  });
  it.each([NaN, Infinity, -1])('rejects invalid percentages %s', value => {
    const h = fixtureHub(); h.usage.claude.windows[0].usedPercent = value;
    expect(HubSnapshotSchema.safeParse(h).success).toBe(false);
  });
  it('rejects milliseconds in epoch-second reset fields, protocol drift, and unknown fields', () => {
    const h = fixtureHub(); h.usage.codex.windows[0].resetsAtEpochSec = 1791993600000;
    expect(HubSnapshotSchema.safeParse(h).success).toBe(false);
    expect(HubSnapshotSchema.safeParse({ ...fixtureHub(), v: 2 }).success).toBe(false);
    expect(HubSnapshotSchema.safeParse({ ...fixtureHub(), token: 'synthetic-secret' }).success).toBe(false);
  });
  it('bounds Unicode code points and rejects >62 Codex windows without truncation', () => {
    const h = fixtureHub(); h.usage.codex.windows[0].label = '💡'.repeat(80);
    expect(HubSnapshotSchema.safeParse(h).success).toBe(true);
    h.usage.codex.windows[0].label += '💡'; expect(HubSnapshotSchema.safeParse(h).success).toBe(false);
    h.usage.codex.windows = Array.from({length: 63}, (_, i) => ({ ...fixtureHub().usage.codex.windows[0], windowId: `synthetic-${i}` }));
    expect(HubSnapshotSchema.safeParse(h).success).toBe(false);
  });
  it('requires a native age for cached link data and correct command kinds', () => {
    const s = fixture('esp-link-ready'); s.ageMs = null;
    expect(EspSnapshotSchema.safeParse(s).success).toBe(false);
    s.ageMs = 0; s.commands.state = {generation:1,kind:'timer',outcome:'pending',state:null,errorCode:null};
    expect(EspSnapshotSchema.safeParse(s).success).toBe(false);
  });
  it('accepts the approved QUEUE_FULL error in failed esp.set replies', () => {
    const reply = {v:1,id:'synthetic-queue-overflow',ok:false,error:{code:'QUEUE_FULL',retryable:true}};
    expect(BridgeReplySchemaFor('esp.set').safeParse(reply).success).toBe(true);
    expect(BridgeReplySchemaFor('esp.set').safeParse({...reply,error:{...reply.error,code:'COMMAND_QUEUE_FULL'}}).success).toBe(false);
  });
  it('requires uppercase normalized ESP state while accepting lowercase colour intent', () => {
    const state = fixture('esp-ready');
    expect(EspStateSchema.safeParse({...state,hex:'#12ABEF'}).success).toBe(true);
    expect(EspStateSchema.safeParse({...state,hex:'#12abef'}).success).toBe(false);
    expect(LightPatchSchema.safeParse({hex:'#12abef'}).success).toBe(true);
  });
  it('rejects empty/mixed timer patches, invalid ranges, and unsafe generations', () => {
    for (const patch of [{}, {timerMinutes:10,power:true}, {bright:0}, {mode:9}, {hex:'#xyzxyz'}, {speed:101}]) {
      expect(LightPatchSchema.safeParse(patch).success).toBe(false);
    }
    for (const generation of [0,-1,1.2,Number.MAX_SAFE_INTEGER+1]) {
      expect(BridgeRequestSchema.safeParse({v:1,id:'synthetic-1',op:'esp.set',args:{patch:{power:true},generation}}).success).toBe(false);
    }
    expect(LightPatchSchema.parse({timerMinutes:0})).toEqual({timerMinutes:0});
  });
  it('rejects undefined-only patches instead of accepting a command with no wire fields', () => {
    expect(LightPatchSchema.safeParse({power:undefined}).success).toBe(false);
    expect(LightPatchSchema.safeParse({timerMinutes:1,power:undefined}).success).toBe(false);
  });
  it('accepts each exact app reply and bounded setting arguments', () => {
    const replies = {'app.status':fixture('app-status'),'app.setupHub':{setupId:'synthetic-setup',started:true},'app.connectEsp':{setupId:'synthetic-setup',started:false},'app.openWifiSettings':{opened:true},'app.setScreenOn':{screenOn:false,brightness:0.1},'app.setBrightness':{screenOn:true,brightness:1}} as const;
    for (const [op,data] of Object.entries(replies)) expect(BridgeReplySchemaFor(op as keyof typeof replies).safeParse({v:1,id:'synthetic',ok:true,data}).success).toBe(true);
    for (const value of [0.1,1]) expect(BridgeRequestSchema.safeParse({v:1,id:'synthetic',op:'app.setBrightness',args:{value}}).success).toBe(true);
    expect(BridgeRequestSchema.safeParse({v:1,id:'synthetic',op:'app.setScreenOn',args:{enabled:false}}).success).toBe(true);
  });
  it('freezes operation-specific arguments and rejects oversized bridge input', () => {
    for (const op of ['hub.snapshot','esp.state','esp.history','app.status','app.setupHub','app.connectEsp','app.openWifiSettings']) {
      expect(BridgeRequestSchema.safeParse({v:1,id:'synthetic',op,args:{}}).success).toBe(true);
      expect(BridgeRequestSchema.safeParse({v:1,id:'synthetic',op,args:{extra:true}}).success).toBe(false);
    }
    for (const args of [{value:0}, {value:1.1}, {value:NaN}, {value:0.5,extra:1}, {enabled:true}]) {
      expect(BridgeRequestSchema.safeParse({v:1,id:'synthetic',op:'app.setBrightness',args}).success).toBe(false);
    }
    expect(BridgeRequestSchema.safeParse({v:1,id:'synthetic',op:'app.setScreenOn',args:{enabled:'true'}}).success).toBe(false);
    expect(BridgeRequestSchema.safeParse({v:1,id:'synthetic',op:'unknown',args:{}}).success).toBe(false);
    expect(BridgeRequestSchema.safeParse({v:1,id:'x'.repeat(16385),op:'app.status',args:{}}).success).toBe(false);
  });
  it('rejects malformed setup states and operation-incompatible reply data', () => {
    const a = fixture('app-status'); a.setup.hub = {setupId:null,state:'in_progress',errorCode:null};
    expect(AppStatusSchema.safeParse(a).success).toBe(false);
    a.setup.hub = {setupId:'synthetic',state:'failed',errorCode:null};
    expect(AppStatusSchema.safeParse(a).success).toBe(false);
    a.setup.hub = {setupId:'synthetic',state:'in_progress',errorCode:null};
    a.setup.esp = {...a.setup.hub}; expect(AppStatusSchema.safeParse(a).success).toBe(false);
    expect(BridgeReplyDataSchemas['app.setupHub'].parse({setupId:'synthetic-setup',started:false})).toEqual({setupId:'synthetic-setup',started:false});
    expect(BridgeReplySchemaFor('app.setBrightness').safeParse({v:1,id:'synthetic',ok:true,data:{opened:true}}).success).toBe(false);
    expect(BridgeReplySchemaFor('app.status').safeParse({v:1,id:'synthetic',ok:false,error:{code:'arbitrary provider message',retryable:false}}).success).toBe(false);
  });
});
