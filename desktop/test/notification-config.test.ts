import { describe,it,expect } from 'vitest';
import { mkdtempSync,readFileSync,writeFileSync,readdirSync,statSync,mkdirSync,symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { allowNotificationApp,removeNotificationApp,listNotificationApps,isValidNotificationLabel,MAX_NOTIFICATION_APPS } from '../src/config.js';
import { runNotificationsCommand } from '../src/notifications-cli.js';

const dir=()=>mkdtempSync(join(tmpdir(),'phone-monitor-notif-config-'));
const file=(d:string)=>join(d,'config.json');
describe('notification allowlist persistence',()=>{
 it('starts empty and does not create files when listing',()=>{
  const d=join(dir(),'fresh');expect(listNotificationApps(d)).toEqual([]);expect(()=>statSync(d)).toThrow();
 });
 it('adds, de-duplicates, lists and removes labels in a private atomic file',async()=>{
  const d=dir();
  expect(await allowNotificationApp(d,'SyntheticApp')).toEqual(['SyntheticApp']);
  expect(await allowNotificationApp(d,'Other App.v2')).toEqual(['SyntheticApp','Other App.v2']);
  expect(await allowNotificationApp(d,'SyntheticApp')).toEqual(['SyntheticApp','Other App.v2']);
  expect(listNotificationApps(d)).toEqual(['SyntheticApp','Other App.v2']);
  expect(statSync(file(d)).mode&0o777).toBe(0o600);expect(statSync(d).mode&0o777).toBe(0o700);
  expect(await removeNotificationApp(d,'SyntheticApp')).toEqual(['Other App.v2']);
  expect(await removeNotificationApp(d,'Missing')).toEqual(['Other App.v2']);
  expect(readdirSync(d).filter(n=>n.startsWith('.phone-monitor-')||n.endsWith('.lock'))).toEqual([]);
 });
 it('preserves unrelated keys and unrelated files',async()=>{
  const d=dir();writeFileSync(file(d),JSON.stringify({other:{keep:[1,2]},notificationAllowlist:['SyntheticApp']}));writeFileSync(join(d,'phone-token'),'x');
  await allowNotificationApp(d,'Second');await removeNotificationApp(d,'SyntheticApp');
  expect(JSON.parse(readFileSync(file(d),'utf8'))).toEqual({other:{keep:[1,2]},notificationAllowlist:['Second']});expect(readFileSync(join(d,'phone-token'),'utf8')).toBe('x');
 });
 it.each(["x',arg1='y",'a"b','a\\b','a\nb','a,b','é','x'.repeat(81),'','  ',' lead','trail '])('rejects label %j and leaves config untouched',async label=>{
  const d=dir();expect(isValidNotificationLabel(label)).toBe(false);
  await expect(allowNotificationApp(d,label)).rejects.toThrow('BAD_APP_LABEL');await expect(removeNotificationApp(d,label)).rejects.toThrow('BAD_APP_LABEL');
  expect(()=>statSync(file(d))).toThrow();
 });
 it('accepts the documented charset including the 80 character limit',()=>{
  for(const l of ['a','A b_c.d:e-f','x'.repeat(80)])expect(isValidNotificationLabel(l)).toBe(true);expect(isValidNotificationLabel(5)).toBe(false);
 });
 it('caps the allowlist at ten apps',async()=>{
  const d=dir();for(let i=0;i<MAX_NOTIFICATION_APPS;i++)await allowNotificationApp(d,`App${i}`);
  await expect(allowNotificationApp(d,'Eleventh')).rejects.toThrow('ALLOWLIST_FULL');expect(listNotificationApps(d)).toHaveLength(10);
  expect(await allowNotificationApp(d,'App3')).toHaveLength(10);
 });
 it('fails closed on a corrupt or hostile config instead of overwriting it, and on read ignores bad entries',async()=>{
  const d=dir();writeFileSync(file(d),'{not json');
  await expect(allowNotificationApp(d,'SyntheticApp')).rejects.toThrow('BAD_CONFIG');expect(readFileSync(file(d),'utf8')).toBe('{not json');expect(()=>listNotificationApps(d)).toThrow('BAD_CONFIG');
  writeFileSync(file(d),JSON.stringify({notificationAllowlist:['ok',"bad'",5,'ok',...Array.from({length:20},(_,i)=>`A${i}`)]}));
  expect(listNotificationApps(d)).toEqual(['ok',...Array.from({length:9},(_,i)=>`A${i}`)]);
 });
 it('refuses a symlinked config file',async()=>{
  const d=dir();const target=join(dir(),'elsewhere.json');writeFileSync(target,'{}');symlinkSync(target,file(d));
  await expect(allowNotificationApp(d,'SyntheticApp')).rejects.toThrow();expect(readFileSync(target,'utf8')).toBe('{}');
 });
 it('serialises concurrent writers without losing labels',async()=>{
  const d=dir();await Promise.all(['A','B','C','D'].map(l=>allowNotificationApp(d,l)));expect(listNotificationApps(d).sort()).toEqual(['A','B','C','D']);
 });
});
describe('notifications CLI',()=>{
 const run=async(d:string,...argv:string[])=>{const lines:string[]=[];const code=await runNotificationsCommand(argv,d,l=>lines.push(l));return {code,text:lines.join('\n')};};
 it('allows, lists and removes (with or without the leading command word)',async()=>{
  const d=dir();expect((await run(d,'list')).text).toMatch(/No notification apps/);
  expect((await run(d,'notifications','allow','Synthetic App')).code).toBe(0);expect((await run(d,'allow','Other')).code).toBe(0);
  expect((await run(d,'list')).text).toBe('Synthetic App\nOther');expect(listNotificationApps(d)).toEqual(['Synthetic App','Other']);
  expect((await run(d,'remove','Synthetic App')).code).toBe(0);expect((await run(d,'list')).text).toBe('Other');
 });
 it('rejects bad usage and bad labels with fixed messages and nonzero exit',async()=>{
  const d=dir();
  expect((await run(d)).code).toBe(2);expect((await run(d,'bogus')).code).toBe(2);expect((await run(d,'allow')).code).toBe(2);expect((await run(d,'allow','a','b')).code).toBe(2);expect((await run(d,'list','extra')).code).toBe(2);
  const bad=await run(d,'allow',"x',arg1='y");expect(bad.code).toBe(1);expect(bad.text).toMatch(/not a valid app label/);expect(listNotificationApps(d)).toEqual([]);
  writeFileSync(file(d),'{broken');const broken=await run(d,'list');expect(broken.code).toBe(1);expect(broken.text).not.toMatch(/broken/);
 });
});
