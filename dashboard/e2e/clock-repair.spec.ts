import { test, expect, controlProblems } from './harness.js';
import { installSyntheticNativeBridge } from './bridge.js';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';

test.use({ timezoneId: 'UTC' });
const evidenceRun = `flip-${Date.now()}`;

async function openClock(page: Page, width = 740, height = 320, text = false) {
  await page.setViewportSize({ width, height });
  await installSyntheticNativeBridge(page);
  // Synthetic tests are silent and never request native/browser fullscreen.
  await page.addInitScript(() => { Object.defineProperty(window, 'AudioContext', { value: undefined }); });
  await page.goto('/');
  if (text) await page.evaluate(() => document.documentElement.style.fontSize = '19.5px');
  await page.getByRole('button', { name: 'Open clock, timers, and alarms' }).click();
}
async function reveal(page: Page) {
  const show = page.getByRole('button', { name: 'Show controls', exact: true });
  if (await show.isVisible()) await show.click();
}
async function geometry(page: Page) {
  return page.locator('.clock-view').evaluate(root => {
    const problems: string[] = [];
    const visible = (e: Element) => { const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && e.getClientRects().length > 0; };
    const chrome = Array.from(root.querySelectorAll('.clock-header,.clock-bottom')).filter(visible);
    for (const el of root.querySelectorAll('.flip-card-value,.timer-big-digits,.stopwatch-readout,.clock-tab')) {
      if (!visible(el)) continue;
      const b = el.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(el); const t = range.getBoundingClientRect();
      if (b.x < 0 || b.right > innerWidth + .5 || b.y < 0 || b.bottom > innerHeight + .5) problems.push(`${el.className} outside viewport`);
      if (t.x < b.x - 1 || t.right > b.right + 1 || t.y < b.y - 1 || t.bottom > b.bottom + 1) problems.push(`${el.className} text clipped`);
      if (!el.matches('.clock-tab')) for (const c of chrome) { const d = c.getBoundingClientRect(); if (b.left < d.right && b.right > d.left && b.top < d.bottom && b.bottom > d.top) problems.push(`${el.className} overlaps chrome`); }
    }
    const ring = root.querySelector('.timer-svg');
    if (ring && visible(ring)) {
      const b = ring.getBoundingClientRect();
      const digits = root.querySelector('.timer-big-digits')!.getBoundingClientRect();
      if (Math.abs(b.width - b.height) > 1 || b.width < 140) problems.push('Timer ring is not a usable circle');
      if (digits.left < b.left + 4 || digits.right > b.right - 4 || digits.top < b.top + 4 || digits.bottom > b.bottom - 4) problems.push('Countdown leaves ring');
      for (const c of chrome) { const d = c.getBoundingClientRect(); if (b.left < d.right && b.right > d.left && b.top < d.bottom && b.bottom > d.top) problems.push('Timer ring overlaps chrome'); }
    }
    return problems;
  });
}
for (const [width, height] of [[800, 360], [740, 320], [360, 800], [320, 800]]) {
  for (const text of [false, true]) test(`all clock modes readable at ${width}x${height}${text ? ' text130' : ''}`, async ({ page }) => {
    await openClock(page, width, height, text);
    expect(await geometry(page)).toEqual([]);
    if (!text) await page.screenshot({ path: resolve(import.meta.dirname, '../evidence/clock-repair', evidenceRun, `desk-${width}x${height}.png`) });
    const before = await page.locator('.wallpaper-digits-box').boundingBox();
    await reveal(page);
    expect(await page.locator('.wallpaper-digits-box').boundingBox()).toEqual(before);
    for (const mode of ['Clock', 'Timer', 'Alarms', 'Stopwatch']) {
      await page.getByRole('tab', { name: mode, exact: true }).click();
      expect(await geometry(page), mode).toEqual([]);
      expect(await controlProblems(page, '.clock-view', { allowVerticalScroll: true }), mode).toEqual([]);
      if (mode === 'Clock') {
        await page.getByRole('button', { name: 'Appearance', exact: true }).click();
        await page.getByLabel('Clock layout').selectOption('stacked');
        await page.getByLabel('Clock theme').selectOption('amber');
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        expect(await geometry(page), 'Saved stacked option').toEqual([]);
      }
      if (mode === 'Timer') {
        await page.getByLabel('Minutes', { exact: true }).fill('61');
        await page.getByRole('button', { name: 'Start focus', exact: true }).click();
        expect(await geometry(page), 'Running focus timer').toEqual([]);
        if (!text) await page.screenshot({ path: resolve(import.meta.dirname, '../evidence/clock-repair', evidenceRun, `focus-${width}x${height}.png`) });
        await reveal(page);
        expect(await geometry(page), 'Running timer with controls').toEqual([]);
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        expect(await geometry(page), 'Paused timer').toEqual([]);
        await page.getByRole('tab', { name: 'Clock', exact: true }).click();
        expect(await geometry(page), 'Clock with active timer status').toEqual([]);
        await page.getByRole('button', { name: 'Appearance', exact: true }).click();
        await page.getByLabel('Clock layout').selectOption('horizontal');
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        expect(await geometry(page), 'Horizontal clock with active timer status').toEqual([]);
      }
    }
  });
}
test('clock focus is deliberate, keyboard controls stay reachable and focus returns to Monitor', async ({ page }) => {
  await openClock(page);
  await expect(page.locator('.clock-header')).toBeHidden();
  await page.getByRole('button', { name: 'Show controls', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Clock', exact: true }).focus();
  await page.waitForTimeout(6200);
  await expect(page.getByRole('tab', { name: 'Clock', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Timer', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '25 min', exact: true }).click();
  await expect(page.locator('.timer-big-digits')).toHaveText('25:00');
  await page.waitForTimeout(4700);
  await expect(page.locator('.clock-header')).toBeVisible();
  await page.getByRole('button', { name: 'Start focus' }).click();
  await expect(page.locator('.clock-header')).toBeHidden();
  const before = await page.locator('.timer-big-digits').boundingBox();
  await page.locator('.timer-display-card').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.clock-header')).toBeVisible();
  expect(await page.locator('.timer-big-digits').boundingBox()).toEqual(before);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Close clock' }).click();
  await expect(page.getByRole('button', { name: 'Open clock, timers, and alarms' })).toBeFocused();
  await expect(page.locator('.dock-timer-pill')).toContainText('Paused');
});
test('appearance sheet preserves clean readout and traps focus', async ({ page }) => {
  await openClock(page, 320, 800);
  await reveal(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByLabel('Clock theme').selectOption('amber');
  await page.getByLabel('Clock layout').selectOption('horizontal');
  await page.getByLabel('Show seconds').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('.clock-view')).toHaveClass(/clock-theme-amber/);
  await expect(page.locator('.wallpaper-horizontal-digits')).toBeVisible();
  expect(await geometry(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.clock-view')).toBeHidden();
});
test('timer completion is visible on Monitor and dismiss restores focus', async ({ page }) => {
  await openClock(page);
  await reveal(page);
  await page.getByRole('tab', { name: 'Timer', exact: true }).click();
  await page.getByLabel('Minutes', { exact: true }).fill('0');
  await page.getByLabel('Seconds', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Start focus' }).click();
  await reveal(page);
  await page.getByRole('button', { name: 'Close clock' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Timer complete', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open clock, timers, and alarms' })).toBeFocused();
});

test('timer actions retain keyboard focus through idle hiding timeout', async ({ page }) => {
  await openClock(page);
  await reveal(page);
  await page.getByRole('tab', { name: 'Timer', exact: true }).click();
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await reveal(page);
  await page.getByRole('button', { name: '+1 Min', exact: true }).focus();
  await page.waitForTimeout(6200);
  await expect(page.getByRole('button', { name: '+1 Min', exact: true })).toBeFocused();
  await expect(page.locator('.clock-header')).toBeVisible();
});
test('completion overlays Appearance and restores the live focused control', async ({ page }) => {
  await openClock(page);
  await reveal(page);
  await page.getByRole('tab', { name: 'Timer', exact: true }).click();
  await page.getByLabel('Minutes', { exact: true }).fill('0');
  await page.getByLabel('Seconds', { exact: true }).fill('5');
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await reveal(page);
  await page.getByRole('tab', { name: 'Clock', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const done = page.getByRole('button', { name: 'Done', exact: true });
  await done.focus();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(done).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.clock-appearance')).toBeHidden();
  await expect(page.locator('.clock-view')).toBeVisible();
});


test('minute rollover folds only changed cards and settles without decorative motion', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-24T10:59:58Z') });
  await page.clock.pauseAt(new Date('2026-10-24T10:59:59Z'));
  await openClock(page);
  await expect(page.locator('.flip-card')).toHaveCount(2);
  await expect(page.locator('.is-flipping')).toHaveCount(0);
  await page.clock.runFor(1000);
  await expect(page.locator('.digit-minutes')).toHaveClass(/is-flipping/);
  const moving = await page.locator('.digit-minutes .flip-fold-top').evaluate(el => {
    const animation = el.getAnimations()[0];
    if (!animation) return null;
    animation.pause(); animation.currentTime = 150;
    return { name: getComputedStyle(el).animationName, transform: getComputedStyle(el).transform };
  });
  expect(moving?.name).toBe('clock-fold-top');
  expect(moving?.transform).not.toBe('none');
  await page.screenshot({ path: resolve(import.meta.dirname, '../evidence/flip-clock', evidenceRun, 'rollover-fold.png') });
  await page.clock.runFor(700);
  await expect(page.locator('.is-flipping')).toHaveCount(0);
  const stable = await page.locator('.wallpaper-digits-box').boundingBox();
  await page.clock.runFor(1000);
  await expect(page.locator('.is-flipping')).toHaveCount(0);
  expect(await page.locator('.wallpaper-digits-box').boundingBox()).toEqual(stable);
  await page.clock.runFor(58300);
  await expect(page.locator('.digit-minutes')).toHaveClass(/is-flipping/);
  await expect(page.locator('.digit-hours')).not.toHaveClass(/is-flipping/);
  await reveal(page);
  await page.getByRole('tab', { name: 'Timer', exact: true }).click();
  await page.clock.runFor(700);
  await page.getByRole('tab', { name: 'Clock', exact: true }).click();
  await expect(page.locator('.is-flipping')).toHaveCount(0);
});

test('reduced motion updates split cards directly and cancels an active fold', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-24T10:59:58Z') });
  await page.clock.pauseAt(new Date('2026-10-24T10:59:59Z'));
  await openClock(page);
  await page.clock.runFor(1000);
  await expect(page.locator('.digit-minutes')).toHaveClass(/is-flipping/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.is-flipping')).toHaveCount(0);
  await page.clock.runFor(60000);
  await expect(page.locator('.digit-minutes .flip-card-value')).toHaveText('01');
  await expect(page.locator('.is-flipping')).toHaveCount(0);
  expect(await page.locator('.flip-card').evaluateAll(cards => cards.flatMap(c => c.getAnimations({ subtree: true })).length)).toBe(0);
});


test('circular timer visibly encloses countdown and preserves elapsed progress when paused', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-24T10:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-24T10:00:01Z'));
  await openClock(page);
  await reveal(page);
  await page.getByRole('tab', { name: 'Timer', exact: true }).click();
  await page.getByRole('button', { name: '1 min', exact: true }).click();
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await page.clock.runFor(30000);
  await expect(page.locator('.timer-big-digits')).toHaveText('00:30');
  expect(await geometry(page)).toEqual([]);
  const ring = await page.locator('.timer-progress').evaluate(el => ({
    circumference: (el as SVGCircleElement).getTotalLength(),
    offset: getComputedStyle(el).strokeDashoffset,
    stroke: getComputedStyle(el).stroke,
  }));
  expect(ring.circumference).toBeGreaterThan(580);
  expect(parseFloat(ring.offset)).toBeCloseTo(50, 1);
  expect(ring.stroke).not.toBe('none');
  const before = await page.locator('.timer-svg').boundingBox();
  await reveal(page);
  expect(await page.locator('.timer-svg').boundingBox()).toEqual(before);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.clock.runFor(30000);
  await expect(page.locator('.timer-big-digits')).toHaveText('00:30');
  expect(parseFloat(await page.locator('.timer-progress').evaluate(el => getComputedStyle(el).strokeDashoffset))).toBeCloseTo(50, 1);
});


test('hidden document drops an active fold and does not replay elapsed transitions on return', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-24T10:59:58Z') });
  await page.clock.pauseAt(new Date('2026-10-24T10:59:59Z'));
  await openClock(page);
  await page.clock.runFor(1000);
  await expect(page.locator('.digit-minutes')).toHaveClass(/is-flipping/);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.is-flipping')).toHaveCount(0);
  await page.clock.runFor(60000);
  await expect(page.locator('.digit-minutes .flip-card-value')).toHaveText('01');
  await expect(page.locator('.is-flipping')).toHaveCount(0);
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.is-flipping')).toHaveCount(0);
});
