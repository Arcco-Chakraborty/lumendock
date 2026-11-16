import { test, expect } from './harness.js';
import { installSyntheticNativeBridge } from './bridge.js';
import { resolve } from 'node:path';

const run = `menu-${Date.now()}`;
test.use({ timezoneId: 'UTC' });

for (const [width,height] of [[740,320],[800,360],[320,800],[360,800]] as const) {
  for (const zoom of [false,true]) for (const stacked of [false,true]) test(`clock stays centered with the date below and one menu ${width}x${height}${zoom?' text130':''}${stacked?' saved-stacked':''}`, async ({page})=>{
    await page.setViewportSize({width,height});
    await installSyntheticNativeBridge(page);
    await page.addInitScript(()=>Object.defineProperty(window,'AudioContext',{value:undefined}));
    await page.goto('/');
    if(zoom) await page.evaluate(()=>document.documentElement.style.fontSize='19.5px');
    await page.getByRole('button',{name:'Open clock, timers, and alarms'}).click();
    await page.evaluate(()=>document.fonts.ready);
    if(stacked) {
      await page.getByRole('button',{name:'Show controls',exact:true}).click();
      await page.getByRole('button',{name:'Appearance',exact:true}).click();
      await page.getByLabel('Clock layout').selectOption('stacked');
      await page.getByRole('button',{name:'Done',exact:true}).click();
      await page.getByRole('button',{name:'Hide clock controls',exact:true}).click();
    }
    const centered = async()=>{
      const r=await page.locator('.flip-card').evaluateAll(es=>{
        const a=es.map(e=>e.getBoundingClientRect());
        return {left:Math.min(...a.map(b=>b.left)),right:Math.max(...a.map(b=>b.right)),top:Math.min(...a.map(b=>b.top)),bottom:Math.max(...a.map(b=>b.bottom))};
      });
      expect(Math.abs((r.left+r.right)/2-width/2)).toBeLessThan(1);
      expect(Math.abs((r.top+r.bottom)/2-height/2)).toBeLessThan(1);
      const date=(await page.locator('.wallpaper-date-row').boundingBox())!;
      expect(date.y).toBeGreaterThan(r.bottom);
      expect(Math.abs(date.x+date.width/2-width/2)).toBeLessThan(1);
      expect(date.y+date.height).toBeLessThanOrEqual(height);
      expect(date.height).toBeLessThanOrEqual(await page.locator('.wallpaper-date-row').evaluate(e=>parseFloat(getComputedStyle(e).lineHeight)+1));
      return r;
    };
    const before=await centered();
    const reveal=page.getByRole('button',{name:'Show controls',exact:true});
    await expect(reveal).toHaveAttribute('aria-expanded','false');
    if(!zoom) await page.screenshot({path:resolve(import.meta.dirname,'../evidence/clock-menu',run,`quiet-${width}x${height}${stacked?"-stacked":""}.png`)});
    await reveal.click();
    await expect(page.getByRole('button',{name:'Hide clock controls',exact:true})).toHaveAttribute('aria-expanded','true');
    await expect(page.locator('.clock-header').getByRole('button',{name:'Appearance',exact:true})).toBeVisible();
    await expect(page.locator('.clock-header').getByRole('button',{name:'Close clock',exact:true})).toBeVisible();
    expect(await centered()).toEqual(before);
    if(!zoom) await page.screenshot({path:resolve(import.meta.dirname,'../evidence/clock-menu',run,`menu-${width}x${height}${stacked?"-stacked":""}.png`)});
    await page.getByRole('tab',{name:'Timer',exact:true}).click();
    await page.getByRole('button',{name:'25 min',exact:true}).click();
    await page.getByRole('button',{name:'Start focus',exact:true}).click();
    await page.getByRole('button',{name:'Show controls',exact:true}).click();
    await page.getByRole('button',{name:'Pause',exact:true}).click();
    await page.getByRole('tab',{name:'Clock',exact:true}).click();
    await centered();
    const status=(await page.locator('.wallpaper-timer-pill').boundingBox())!;
    expect(status.y).toBeGreaterThanOrEqual(0);
    expect(status.y+status.height).toBeLessThanOrEqual(height);
    expect(await page.locator('.wallpaper-timer-pill').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
  });
}
