import { test, expect } from './harness.js';
import { installSyntheticNativeBridge } from './bridge.js';
import { resolve } from 'node:path';

test.use({ timezoneId: 'UTC' });
const run = `space-${Date.now()}`;

async function containment(page: import('@playwright/test').Page, selector: string) {
  return page.locator(selector).evaluateAll(elements => elements.flatMap(el => {
    const b = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (!b.width || !b.height || s.visibility === 'hidden' || s.display === 'none') return [];
    const issues: string[] = [];
    const label = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 24) || el.tagName;
    if (b.left < -1 || b.top < -1 || b.right > innerWidth + 1 || b.bottom > innerHeight + 1) issues.push(`${label}: outside viewport`);
    for (let p = el.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p), a = p.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (b.top < a.top - 1 || b.bottom > a.bottom + 1)) issues.push(`${label}: clipped vertically by ${p.className}`);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (b.left < a.left - 1 || b.right > a.right + 1)) issues.push(`${label}: clipped horizontally by ${p.className}`);
    }
    if (el.matches('button,input,select')) {
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      if (hit !== el && !el.contains(hit)) issues.push(`${label}: cannot be reached`);
    }
    return issues;
  }));
}

for (const [width, height] of [[740,320],[800,360],[320,800],[360,800]] as const) {
  test(`desk clock uses the screen at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await installSyntheticNativeBridge(page);
    await page.addInitScript(() => Object.defineProperty(window, 'AudioContext', { value: undefined }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Open clock, timers, and alarms' }).click();
    const box = (await page.locator('.wallpaper-digits-box').boundingBox())!;
    const cards = await page.locator('.flip-card').evaluateAll(es => es.map(e => { const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; }));
    const usedWidth = Math.max(...cards.map(c=>c.x+c.w))-Math.min(...cards.map(c=>c.x));
    const usedHeight = Math.max(...cards.map(c=>c.y+c.h))-Math.min(...cards.map(c=>c.y));
    expect(usedWidth / width).toBeGreaterThan(width > height ? .70 : .75);
    expect(usedHeight / height).toBeGreaterThan(.60);
    expect(await containment(page, '.flip-card,.wallpaper-date-row,.flip-card-corner')).toEqual([]);
    await page.getByRole('button', { name: 'Show controls', exact:true }).click();
    expect(await page.locator('.wallpaper-digits-box').boundingBox()).toEqual(box);
    expect(await containment(page, '.flip-card,.clock-header button,.clock-bottom button')).toEqual([]);
    await page.screenshot({ path: resolve(import.meta.dirname, '../evidence/clock-space', run, `clock-${width}x${height}.png`) });
  });
}

for (const [width,height] of [[600,360],[601,360],[649,360],[650,360],[740,320],[800,360],[320,800],[360,800]] as const) {
  for (const zoom of [false,true]) test(`timer setup and ring fit ${width}x${height}${zoom?' text130':''}`, async ({page}) => {
    await page.setViewportSize({width,height});
    await installSyntheticNativeBridge(page);
    await page.addInitScript(() => Object.defineProperty(window,'AudioContext',{value:undefined}));
    await page.goto('/');
    if(zoom) await page.evaluate(()=>document.documentElement.style.fontSize='19.5px');
    await page.getByRole('button',{name:'Open clock, timers, and alarms'}).click();
    await page.getByRole('button',{name:'Show controls',exact:true}).click();
    await page.getByRole('tab',{name:'Timer',exact:true}).click();
    expect(await containment(page,'.timer-config-panel input,.timer-config-panel button,.timer-actions-row button,.timer-big-digits')).toEqual([]);
    if(!zoom) await page.screenshot({path:resolve(import.meta.dirname,'../evidence/clock-space',run,`setup-${width}x${height}.png`)});
    await page.getByLabel('Minutes',{exact:true}).fill('61');
    await page.getByRole('button',{name:'Start focus',exact:true}).click();
    expect(await containment(page,'.timer-svg,.timer-readout > *,.timer-actions-row button')).toEqual([]);
    expect(await page.locator('.timer-dial').evaluate(dial => {
      const b=dial.getBoundingClientRect(), digits=dial.querySelector('.timer-big-digits')!;
      const range=document.createRange(); range.selectNodeContents(digits); const t=range.getBoundingClientRect();
      return [[t.left,t.top],[t.right,t.top],[t.left,t.bottom],[t.right,t.bottom]].every(([x,y])=>Math.hypot(x!-b.x-b.width/2,y!-b.y-b.height/2) < b.width*.46);
    }), 'countdown glyphs stay inside the circular stroke').toBe(true);
    const before=await page.locator('.timer-svg').boundingBox();
    await page.getByRole('button',{name:'Show controls',exact:true}).click();
    expect(await page.locator('.timer-svg').boundingBox()).toEqual(before);
    expect(await containment(page,'.timer-svg,.timer-readout > *,.timer-actions-row button')).toEqual([]);
    await page.getByRole('button',{name:'Pause',exact:true}).click();
    if(!zoom) await page.screenshot({path:resolve(import.meta.dirname,'../evidence/clock-space',run,`timer-${width}x${height}.png`)});
    await page.getByRole('tab',{name:'Alarms',exact:true}).click();
    await page.getByRole('button',{name:'Add alarm',exact:true}).click();
    expect(await containment(page,'.add-alarm-card input,.add-alarm-card select,.add-alarm-card button')).toEqual([]);
  });
}
