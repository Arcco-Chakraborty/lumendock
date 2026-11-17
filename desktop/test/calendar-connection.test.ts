import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CalendarConnectionStore } from '../src/calendar/connection.js';
const dirs:string[]=[];
const temp=()=>{const p=mkdtempSync(join(tmpdir(),'synthetic-calendar-'));dirs.push(p);return p;};
const client={clientId:'synthetic-client.apps.googleusercontent.com',clientSecret:'synthetic-secret'};
const token={accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresAt:900000};
afterEach(()=>{for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
describe('app-owned calendar connection generations',()=>{
 it('is opt-out and shares connect/disconnect state across independent instances',async()=>{
  const dir=temp(),a=new CalendarConnectionStore(dir),b=new CalendarConnectionStore(dir);
  expect(a.read().connected).toBe(false);
  const generation=await a.beginConnect();await a.finishConnect(generation,client,token);
  expect(b.read()).toMatchObject({generation,connected:true,applied:false});
  expect(b.credentials(generation)?.tokens.accessToken).toBe('synthetic-access');
  await b.disconnect();expect(a.read().connected).toBe(false);expect(a.credentials(generation)).toBeNull();
  expect(await a.saveTokens(generation,{...token,accessToken:'late'})).toBe(false);
  expect(readFileSync(join(dir,'calendar','connection.json'),'utf8')).not.toContain('synthetic-access');
 });
 it('preserves a refresh token omitted by rotation but cannot resurrect after reconnect',async()=>{
  const dir=temp(),a=new CalendarConnectionStore(dir),b=new CalendarConnectionStore(dir);
  const g=await a.beginConnect();await a.finishConnect(g,client,token);
  expect(await b.saveTokens(g,{accessToken:'rotated',expiresAt:990000})).toBe(true);
  expect(a.credentials(g)?.tokens.refreshToken).toBe('synthetic-refresh');
  const next=await b.beginConnect();await b.finishConnect(next,client,token);
  expect(await a.saveTokens(g,{...token,accessToken:'late'})).toBe(false);
  expect(a.credentials(next)?.tokens.accessToken).toBe('synthetic-access');
  await expect(a.applySelection(g,'old',['opaque'])).rejects.toThrow('CALENDAR_SELECTION_CHANGED');
 });
 it('makes concurrent connect tickets and stale selection revisions fail closed',async()=>{
  const a=new CalendarConnectionStore(temp());const first=await a.beginConnect(),second=await a.beginConnect();
  expect(await a.finishConnect(first,client,token)).toBe(false);expect(await a.finishConnect(second,client,token)).toBe(true);
  const rev=a.read().selectionRevision;await a.applySelection(second,rev,['synthetic']);
  expect(a.read()).toMatchObject({applied:true,selectedIds:['synthetic']});
  await expect(a.applySelection(second,rev,[])).rejects.toThrow('CALENDAR_SELECTION_CHANGED');
  if(process.platform!=='win32')expect(statSync(join(a.directory,'tokens.json')).mode&0o777).toBe(0o600);
 });
 it('requires a verified Windows ACL before storing a credential',async()=>{
  const calls:string[]=[];const dir=temp();
  const denied=new CalendarConnectionStore(dir,{platform:'win32',protectWindows:()=>{throw Error('ACL');}});
  await expect(denied.beginConnect()).rejects.toThrow('CALENDAR_PRIVATE_STORAGE');
  const allowed=new CalendarConnectionStore(dir,{platform:'win32',protectWindows:path=>{calls.push(path);}});
  const g=await allowed.beginConnect();await allowed.finishConnect(g,client,token);expect(calls.length).toBeGreaterThan(0);
 });
});
