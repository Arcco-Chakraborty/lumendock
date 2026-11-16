import { test, expect } from './harness.js';
import { installSyntheticNativeBridge } from './bridge.js';

async function open(page: import('@playwright/test').Page) {
  await page.setViewportSize({width:800,height:360});
  await installSyntheticNativeBridge(page);
  await page.addInitScript(() => { Object.defineProperty(window, 'AudioContext', {value:undefined}); });
  await page.goto('/');
  await page.getByRole('button',{name:'Open clock, timers, and alarms'}).click();
  await page.getByRole('button',{name:'Show controls',exact:true}).click();
}
test('alarm creation, toggle, delete and persistence',async({page})=>{
  await open(page);
  await page.getByRole('tab',{name:'Alarms',exact:true}).click();
  await page.getByRole('button',{name:'Add alarm',exact:true}).click();
  await page.locator('#alarm-time-input').fill('07:45');
  await page.locator('#alarm-label-input').fill('Synthetic morning');
  await page.getByRole('button',{name:'Save alarm',exact:true}).click();
  const toggle=page.getByRole('checkbox',{name:'Toggle alarm Synthetic morning'});
  await expect(toggle).toBeChecked();await toggle.uncheck();
  await page.reload();
  await page.getByRole('button',{name:'Open clock, timers, and alarms'}).click();
  await page.getByRole('button',{name:'Show controls',exact:true}).click();
  await page.getByRole('tab',{name:'Alarms',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:'Toggle alarm Synthetic morning'})).not.toBeChecked();
  await page.getByRole('button',{name:'Delete alarm Synthetic morning'}).click();
  await expect(page.getByText('No alarms yet')).toBeVisible();
});
test('stopwatch captures real elapsed split laps and resets',async({page})=>{
  await open(page);await page.getByRole('tab',{name:'Stopwatch',exact:true}).click();
  await page.getByRole('button',{name:'Start',exact:true}).click();
  await expect(page.locator('.stopwatch-readout')).not.toHaveText('00:00.00');
  await page.getByRole('button',{name:'Lap',exact:true}).click();
  await expect(page.getByText('Lap 1',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.getByRole('button',{name:'Reset',exact:true}).click();
  await expect(page.locator('.stopwatch-readout')).toHaveText('00:00.00');
});
