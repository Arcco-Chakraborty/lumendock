import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { applyTextZoom, clippingProblems, controlProblems, expect, overlapProblems, test } from './harness.js';
import { bridgeLog, installSyntheticNativeBridge, setBridgeSlot } from './bridge.js';
const NOW = Date.parse('2026-10-23T10:00:00Z');
const dir = resolve(import.meta.dirname, '..', 'evidence', 'monitor-next');
mkdirSync(dir, { recursive: true });
const row = (page: Page) => page.getByRole('button', { name: 'Next up, open Agenda' });
async function openMonitor(page: Page, width = 800, height = 360) {
  await page.setViewportSize({ width, height });
  await page.clock.install({ time: NOW });
  const data = await installSyntheticNativeBridge(page, { edit(f) {
    const cal = f.calendar.data!;
    cal.serverNowEpochMs = NOW; cal.lastSuccessAtEpochMs = NOW;
    const candidate = structuredClone(cal.items.find(item => item.start.kind === 'time')!);
    candidate.id = 'synthetic_next_beyond_first_page'; candidate.title = 'Synthetic design review';
    candidate.start = { kind: 'time', epochMs: NOW + 1800_000, timeZone: 'UTC' };
    candidate.end = { kind: 'time', epochMs: NOW + 3600_000, timeZone: 'UTC' };
    candidate.label = { name: 'Focus', color: '#A3B7FA' }; candidate.selfResponseStatus = 'accepted';
    cal.nextEvent = candidate;
    cal.items = Array.from({ length: 50 }, (_, i) => ({ ...candidate, id: `synthetic_declined_${i}`, title: `Synthetic declined ${i}`, selfResponseStatus: 'declined' }));
    cal.nextCursor = 'synthetic_page_two';
  }});
  await page.goto('/');
  await expect(row(page)).toContainText('Synthetic design review');
  await page.getByRole('button', { name: 'Hide bar' }).click();
  return data;
}
async function navigate(page: Page, name: string) {
  const opener = page.getByRole('button', { name: 'Open menu / status' });
  if (await opener.isVisible()) await opener.click();
  await page.getByRole('tab', { name, exact: true }).click();
}
async function poll(page: Page) { await page.clock.fastForward(5100); }

test('Monitor fetches whole-range nextEvent immediately and opens current Agenda by keyboard independently of browsed dates', async ({ page }) => {
  await openMonitor(page);
  await expect(row(page)).toHaveAccessibleDescription(/Synthetic design review.*Focus/);
  await expect(row(page)).toContainText('Focus'); await expect(row(page)).not.toContainText('Synthetic declined');
  expect((await bridgeLog(page)).filter(c => c.op === 'hub.calendarSources' || c.op === 'hub.calendarSelect')).toHaveLength(0);
  const initial = (await bridgeLog(page)).filter(c => c.op === 'hub.calendar');
  expect(initial[0]!.args).toMatchObject({ startDate: '2026-10-23', days: 7 });
  expect(initial[0]!.args).not.toHaveProperty('cursor');
  await row(page).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#agenda-panel')).toBeVisible();
  await expect(page.locator('#agenda-panel')).toBeFocused();
  await page.getByRole('button', { name: 'Later dates' }).click();
  await expect(page.getByText('Oct 30 to Nov 5')).toBeVisible();
  await navigate(page, 'Monitor'); await expect(row(page)).toContainText('Synthetic design review');
  await poll(page);
  expect((await bridgeLog(page)).filter(c => c.op === 'hub.calendar').at(-1)!.args).toMatchObject({ startDate: '2026-10-23', days: 7 });
  await row(page).click();
  await expect(page.getByText('Oct 23 to Oct 29')).toBeVisible();
});

test('Monitor polls only while active and visible', async ({ page }) => {
  await openMonitor(page); await poll(page);
  const count = async () => (await bridgeLog(page)).filter(c => c.op === 'hub.calendar').length;
  expect(await count()).toBeGreaterThan(1);
  await navigate(page, 'Deck'); const inactiveCount = await count(); await poll(page); expect(await count()).toBe(inactiveCount);
  await navigate(page, 'Monitor'); await expect(row(page)).toContainText('Synthetic design review');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenCount = await count(); await poll(page); expect(await count()).toBe(hiddenCount);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await poll(page); expect(await count()).toBeGreaterThan(hiddenCount);
  await page.clock.fastForward(86400_000); await poll(page);
  expect((await bridgeLog(page)).filter(c => c.op === 'hub.calendar').at(-1)!.args).toMatchObject({ startDate: '2026-10-24', days: 7 });
});

test('Monitor suppresses expired and declined summaries and clears cached event on authorization or account disconnect', async ({ page }) => {
  const data = await openMonitor(page);
  data.calendar.data!.nextEvent!.start = { kind: 'time', epochMs: NOW - 60000, timeZone: 'UTC' };
  data.calendar.data!.nextEvent!.end = { kind: 'time', epochMs: NOW + 2000, timeZone: 'UTC' };
  await setBridgeSlot(page, 'calendar', data.calendar); await poll(page);
  await expect(row(page)).not.toContainText('Synthetic design review');
  await expect(row(page)).toContainText('No upcoming timed events in the next 7 days');
  data.calendar.data!.nextEvent!.start = { kind: 'time', epochMs: NOW + 1800_000, timeZone: 'UTC' };
  data.calendar.data!.nextEvent!.end = { kind: 'time', epochMs: NOW + 3600_000, timeZone: 'UTC' };
  const candidate = structuredClone(data.calendar.data!.nextEvent!);
  // The server never publishes a declined nextEvent; only declined rows remain on page one.
  data.calendar.data!.nextEvent = null;
  await setBridgeSlot(page, 'calendar', data.calendar); await poll(page); await expect(row(page)).not.toContainText('Synthetic design review');
  data.calendar.data!.nextEvent = candidate;
  await setBridgeSlot(page, 'calendar', data.calendar); await poll(page); await expect(row(page)).toContainText('Synthetic design review');
  for (const state of ['auth_required', 'disabled'] as const) {
    data.calendar.data!.state = state; await setBridgeSlot(page, 'calendar', data.calendar); await poll(page);
    await expect(row(page)).not.toContainText('Synthetic design review');
    await expect(row(page)).toContainText(state === 'disabled' ? 'Connect Google Calendar' : 'Reconnect Google Calendar');
  }
});

for (const [width, height] of [[800,360], [740,320], [360,800], [320,800]] as const) {
  test(`compact Monitor next-event row remains usable at ${width}x${height} and 130% text`, async ({ page }) => {
    await openMonitor(page, width, height); await expect(row(page)).toHaveCount(1);
    expect(await controlProblems(page, '#monitor-panel', { allowVerticalScroll: width < 650 })).toEqual([]);
    expect(await clippingProblems(page, width < 650)).toEqual([]);
    // At 320px the existing usage cards stack; scroll the panel to its bottom
    // so alerts and the preview are measured in their visible position.
    if (width === 320) await page.locator('.main-grid').evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect(await overlapProblems(page)).toEqual([]);
    if (width >= 650) expect(await page.locator('.main-grid').evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await page.screenshot({ path: resolve(dir, `${width}x${height}.png`), animations: 'disabled' });
    await applyTextZoom(page, 1.3);
    expect(await controlProblems(page, '#monitor-panel', { allowVerticalScroll: true })).toEqual([]);
    expect(await clippingProblems(page, true)).toEqual([]);
    await row(page).scrollIntoViewIfNeeded(); await expect(row(page)).toBeInViewport();
    await page.screenshot({ path: resolve(dir, `${width}x${height}-text130.png`), animations: 'disabled' });
  });
}

test('long calendar labels stay within the compact row and remain accessible', async ({ page }) => {
  const data = await openMonitor(page, 740, 320);
  const candidate = data.calendar.data!.nextEvent!;
  candidate.label = { name: 'Synthetic focus label repeated for boundary cases', color: '#A3B7FA' };
  candidate.calendarName = 'Synthetic calendar with an intentionally long display name';
  await setBridgeSlot(page, 'calendar', data.calendar); await poll(page);
  await expect(row(page)).toHaveAccessibleDescription(/Synthetic focus label repeated for boundary cases/);
  expect(await row(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await applyTextZoom(page, 1.3);
  expect(await row(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

for (const state of ['auth_required', 'disabled'] as const) {
  test(`Agenda ${state} invalidates Monitor cache even when the return read fails`, async ({ page }) => {
    const data = await openMonitor(page);
    await row(page).click();
    data.calendar.data!.state = state;
    data.calendar.data!.items = [];
    data.calendar.data!.nextEvent = null;
    await setBridgeSlot(page, 'calendar', data.calendar);
    await page.getByRole('button', { name: 'Refresh agenda' }).click();
    await expect(page.getByRole('heading', { name: state === 'disabled' ? 'Connect Google Calendar on the laptop' : 'Google authorization required' })).toBeVisible();
    await setBridgeSlot(page, 'calendar', { state:'disconnected', ageMs:null, stale:true, data:null, errorCode:'USB_UNAVAILABLE' });
    await navigate(page, 'Monitor');
    await expect(row(page)).not.toContainText('Synthetic design review');
    await poll(page);
    await expect(row(page)).not.toContainText('Synthetic design review');
  });
}

test('successful Agenda deselection invalidates Monitor cache before its failed next read', async ({ page }) => {
  await openMonitor(page);
  await row(page).click();
  await page.getByRole('button', { name: 'Calendars' }).click();
  const sheet = page.locator('dialog.agenda-sheet[open]');
  await expect(sheet).toBeVisible();
  for (const checkbox of await sheet.getByRole('checkbox').all()) await checkbox.uncheck();
  await sheet.getByRole('button', { name: 'Apply calendars' }).click();
  await expect.poll(async () => (await bridgeLog(page)).some(c => c.op === 'hub.calendarSelect')).toBe(true);
  await expect(sheet).toBeHidden();
  await setBridgeSlot(page, 'calendar', { state:'disconnected', ageMs:null, stale:true, data:null, errorCode:'USB_UNAVAILABLE' });
  await navigate(page, 'Monitor');
  await expect(row(page)).not.toContainText('Synthetic design review');
  await poll(page);
  await expect(row(page)).not.toContainText('Synthetic design review');
});

test('Monitor authorization clearing invalidates inactive Agenda before offline click-through', async ({ page }) => {
  const data = await openMonitor(page);
  await row(page).click();
  await expect(page.getByRole('heading', { name: 'Synthetic design review' })).toBeVisible();
  await navigate(page, 'Monitor');
  data.calendar.data!.state = 'auth_required'; data.calendar.data!.items = []; data.calendar.data!.nextEvent = null;
  await setBridgeSlot(page, 'calendar', data.calendar); await poll(page);
  await expect(row(page)).toContainText('Reconnect Google Calendar');
  await setBridgeSlot(page, 'calendar', { state:'disconnected', ageMs:null, stale:true, data:null, errorCode:'USB_UNAVAILABLE' });
  await row(page).click();
  await expect(page.locator('#agenda-panel')).not.toContainText('Synthetic design review');
});

test('known Agenda auth clearing hides Monitor event while its new read is delayed', async ({ page }) => {
  const data = await openMonitor(page); await row(page).click();
  data.calendar.data!.state = 'auth_required'; data.calendar.data!.items = []; data.calendar.data!.nextEvent = null;
  await setBridgeSlot(page, 'calendar', data.calendar); await page.getByRole('button', { name:'Refresh agenda' }).click();
  await expect(page.getByRole('heading', { name:'Google authorization required' })).toBeVisible();
  await page.evaluate(() => {
    const bridge = (window as unknown as { phoneMonitor:{postMessage:(message:string)=>void} }).phoneMonitor;
    const original = bridge.postMessage.bind(bridge);
    bridge.postMessage = (message) => { if (JSON.parse(message).op !== 'hub.calendar') original(message); };
  });
  await navigate(page, 'Monitor');
  await expect(row(page)).not.toContainText('Synthetic design review');
});
