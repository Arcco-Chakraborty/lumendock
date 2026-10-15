import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSelectedNotificationApps } from '../src/notification-sources.js';
import { runNotificationsCommand } from '../src/notifications-cli.js';
import { listNotificationApps } from '../src/config.js';
const appId='a'.repeat(32),desktop=`chrome-${appId}-Default`;
const setup=()=>mkdtempSync(join(tmpdir(),'lumendock-selected-'));
describe('selected notification setup',()=>{
 it('allows only selected native aliases and a verified WhatsApp PWA identity, never browser-wide capture',()=>{
  const dir=setup();writeFileSync(join(dir,`${desktop}.desktop`),`[Desktop Entry]\nName=WhatsApp Web\nExec=/usr/bin/google-chrome --profile-directory=Default --app-id=${appId}\nStartupWMClass=crx_${appId}\n`);
  const labels=discoverSelectedNotificationApps([dir]);
  expect(labels).toContain(`desktop-entry:whatsapp:${desktop}`);
  expect(labels).toEqual(expect.arrayContaining(['Claude','Claude Code','Codex','WhatsApp','WhatsApp Web']));
  expect(labels).not.toEqual(expect.arrayContaining(['Google Chrome','Chromium','Chrome']));
 });
 it('rejects unrelated, mismatched and hidden desktop metadata',()=>{
  const dir=setup();writeFileSync(join(dir,`${desktop}.desktop`),`[Desktop Entry]\nName=Unrelated browser app\nExec=/usr/bin/google-chrome --app-id=${appId}\nStartupWMClass=crx_${appId}\n`);
  writeFileSync(join(dir,'mismatch.desktop'),`[Desktop Entry]\nName=WhatsApp Web\nExec=/usr/bin/google-chrome --app-id=${appId}\nStartupWMClass=crx_${'b'.repeat(32)}\n`);
  expect(discoverSelectedNotificationApps([dir]).filter(x=>x.startsWith('desktop-entry:'))).toEqual([]);
 });
 it('configures selected aliases atomically while retaining unrelated config, then clears only selection',async()=>{
  const dir=setup();writeFileSync(join(dir,'config.json'),JSON.stringify({unrelated:'synthetic',notificationAllowlist:['OtherApp']}));
  const output:string[]=[];
  expect(await runNotificationsCommand(['notifications','configure-selected'],dir,x=>output.push(x),[])).toBe(0);
  expect(listNotificationApps(dir)).toEqual(discoverSelectedNotificationApps([]));
  expect(JSON.parse(readFileSync(join(dir,'config.json'),'utf8')).unrelated).toBe('synthetic');
  expect(await runNotificationsCommand(['notifications','clear'],dir,x=>output.push(x))).toBe(0);
  expect(listNotificationApps(dir)).toEqual([]);
 });
});
