import { test, expect, evidence, clippingProblems, controlProblems, overlapProblems, applyTextZoom } from "./harness.js";
import { installSyntheticNativeBridge, bridgeLog, bridgeCall, setBridgeSlot } from "./bridge.js";
import type { Page } from "@playwright/test";

async function open(page: Page, width = 800, height = 360, options: Parameters<typeof installSyntheticNativeBridge>[1] = {}) {
  await page.setViewportSize({width, height});
  const data = await installSyntheticNativeBridge(page, options);
  await page.goto("/");
  await expect(page.getByText("Laptop connected")).toBeVisible();
  return data;
}
async function assertReadoutsFit(page: Page) {
  const problems = await page.evaluate(() => {
    const errors: string[] = [];
    for (const card of document.querySelectorAll(".usage-card")) {
      const parent = card.getBoundingClientRect();
      for (const element of card.querySelectorAll(".usage-value, .usage-number, .usage-unit")) {
        const range = document.createRange(); range.selectNodeContents(element);
        for (const rect of range.getClientRects()) if (rect.right > parent.right + .5 || rect.left < parent.left - .5) errors.push(`${element.className} leaves its provider column`);
      }
    }
    const heading = document.querySelector(".climate-card h2")!.getBoundingClientRect();
    const state = document.querySelector(".climate-card .card-heading > span")!.getBoundingClientRect();
    if (state.top < heading.bottom + 1 && state.left < heading.right + 4) errors.push("Room state touches heading");
    return errors;
  });
  expect(problems).toEqual([]);
}
for (const [width, height] of [[800,360],[740,320],[360,800]] as const) {
  test(`both screens and collapsed dock at ${width}x${height}`, async ({page}) => {
    await open(page,width,height);
    await assertReadoutsFit(page);
    expect(await page.locator(".main-grid").evaluate(e => e.scrollHeight <= e.clientHeight + 1), "normal Monitor needs no internal scroll").toBe(true);
    await page.getByRole("button", {name:"Hide bar"}).click();
    await expect(page.getByRole("button", {name:"Open menu / status"})).toBeFocused();
    await page.screenshot({animations:"disabled",path:evidence(`${width}x${height}-monitor-collapsed`)});
    await page.getByRole("button", {name:"Open menu / status"}).click();
    await page.getByRole("tab", {name:"Deck",exact:true}).click();
    expect(await controlProblems(page, "body", {allowVerticalScroll:height > width})).toEqual([]);
    expect(await overlapProblems(page)).toEqual([]);
    if (width > height) {
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
      expect(await page.locator(".deck-container").evaluate(e => e.scrollHeight <= e.clientHeight + 1), "normal Deck needs no internal scroll").toBe(true);
    }
    await page.screenshot({animations:"disabled",path:evidence(`${width}x${height}-deck-open`),fullPage:true});
    await page.getByRole("button", {name:"Hide bar"}).click();
    await page.screenshot({animations:"disabled",path:evidence(`${width}x${height}-deck-collapsed`),fullPage:true});
    await page.getByRole("button", {name:"Light controls"}).click();
    await expect(page.getByLabel("Light mode")).toBeVisible();
    expect(await page.getByLabel("Light mode").locator("option").count()).toBe(9);
    expect(await controlProblems(page,"dialog",{allowVerticalScroll:true})).toEqual([]);
    await page.screenshot({animations:"disabled",path:evidence(`${width}x${height}-lighting`)});
    expect(await page.locator("[style]").evaluateAll(elements => elements.map(e=>e.getAttribute("style")).filter(s=>s?.trim()))).toEqual([]);
  });
  test(`fractional and over-limit readings fit at 130% text ${width}x${height}`, async ({page}) => {
    await open(page,width,height,{edit:f => {
      f.hub.data!.usage.claude.windows[0]!.usedPercent = 120.125;
      f.hub.data!.usage.codex.windows[0]!.usedPercent = 33.333;
    }});
    await applyTextZoom(page,1.3);
    await assertReadoutsFit(page);
    expect(await clippingProblems(page,true)).toEqual([]);
    await page.screenshot({animations:"disabled",path:evidence(`${width}x${height}-monitor-text130`),fullPage:true});
    await page.getByRole("tab",{name:"Deck",exact:true}).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await controlProblems(page,"body",{allowVerticalScroll:true})).toEqual([]);
    await page.screenshot({animations:"disabled",path:evidence(`${width}x${height}-deck-text130`),fullPage:true});
  });
}

test("dock waits for keyboard focus, hides after idle and wakes without stealing focus", async ({page}) => {
  await page.clock.install();
  const data = await open(page);
  const monitor = page.getByRole("tab",{name:"Monitor",exact:true});
  await monitor.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab",{name:"Deck",exact:true})).toBeFocused();
  await page.mouse.move(1,1);
  await page.clock.runFor(9000);
  await expect(page.getByRole("tab",{name:"Deck",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Open Claude"}).focus();
  await page.clock.runFor(9000);
  await expect(page.getByRole("button",{name:"Open menu / status"})).toBeVisible();
  data.hub = {state:"disconnected",ageMs:null,stale:true,data:null,errorCode:"USB_UNAVAILABLE"};
  await setBridgeSlot(page,"hub",data.hub);
  await page.clock.runFor(2200);
  await expect(page.getByText("Laptop disconnected")).toBeVisible();
  await expect(page.getByRole("button",{name:"Open Claude"})).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Connect laptop to use these keys.");
  expect((await bridgeLog(page)).filter(x=>x.op === "hub.action")).toEqual([]);
});

test("Deck sends only fixed actions and reports safe request feedback", async ({page}) => {
  await open(page,740,320,{actionResult:{success:true,message:"synthetic backend stderr must not appear"}});
  await page.getByRole("tab",{name:"Deck",exact:true}).click();
  const keys = ["Open Claude","Open ChatGPT","Open Chrome","Open WhatsApp","Open Terminal","Previous track","Play or pause","Next track","Volume down","Toggle mute","Volume up","Toggle microphone","Toggle Do Not Disturb","Lock laptop","Open screenshot tool"];
  for (const key of keys) {
    await page.getByRole("button",{name:key,exact:true}).click();
    await expect(page.getByRole("status")).toContainText("request sent");
  }
  expect((await bridgeLog(page)).filter(x=>x.op === "hub.action").map(x=>x.args)).toEqual([
    "open_claude","open_chatgpt","open_chrome","open_whatsapp","open_terminal","media_prev","media_play_pause","media_next","volume_down","media_mute","volume_up","mic_mute","dnd_toggle","lock_screen","screenshot"
  ].map(action=>({action})));
  await expect(page.getByText("synthetic backend stderr must not appear")).toHaveCount(0);
  expect(await overlapProblems(page)).toEqual([]);
  await page.screenshot({animations:"disabled",path:evidence("740x320-deck-feedback")});
});

test("failed actions cannot display backend error payloads", async ({page}) => {
  await open(page,800,360,{actionResult:{success:false,message:"synthetic private path /not-a-real-home"}});
  await page.getByRole("tab",{name:"Deck",exact:true}).click();
  await page.getByRole("button",{name:"Open Claude"}).click();
  await expect(page.getByRole("status")).toHaveText("Claude: action failed. Try again.");
  await expect(page.getByText(/synthetic private path/)).toHaveCount(0);
});

test("light shortcuts stay pending until acknowledged and survive an unconfirmed reply", async ({page}) => {
  const data = await open(page,800,360,{holdSets:true});
  await page.getByRole("tab",{name:"Deck",exact:true}).click();
  // The open bar overlays the bottom Lamp row; hide it as a user would.
  await page.getByRole("button",{name:"Hide bar"}).click();
  await page.getByRole("button",{name:"Warm lamp",exact:true}).click();
  await expect(page.getByRole("status")).toHaveText("Warm light: pending");
  await expect.poll(async () => (await bridgeLog(page)).filter(x=>x.op === "esp.set").length).toBe(1);
  await bridgeCall(page,"releaseOne");
  await expect(page.getByRole("status")).toHaveText("Warm light: confirmed");
  await page.getByRole("button",{name:"White lamp",exact:true}).click();
  await expect.poll(async () => (await bridgeLog(page)).filter(x=>x.op === "esp.set").length).toBe(2);
  data.esp = {state:"disconnected",ageMs:null,stale:true,data:null,errorCode:"WIFI_UNAVAILABLE",commands:{state:null,timer:null}};
  await setBridgeSlot(page,"esp",data.esp);
  await bridgeCall(page,"releaseOne");
  await expect(page.getByRole("status")).toHaveText("White light: unconfirmed; open light controls to retry");
  // The controller dropping out woke the bar again.
  await page.getByRole("button",{name:"Hide bar"}).click();
  await page.getByRole("button",{name:"Light controls"}).click();
  await expect(page.getByRole("button",{name:"Retry light change"})).toBeVisible();
});

test("unknown and stale values keep their own states and full detail access", async ({page}) => {
  await open(page,740,320,{edit:f => {
    f.hub.data!.usage.claude.windows[0]!.usedPercent = null;
    f.hub.data!.usage.codex.stale = true;
    f.hub.data!.usage.codex.lastSuccessAtEpochMs = 0;
    f.hub.data!.usage.codex.windows[0]!.reportedAtEpochMs = 0;
    f.esp.stale = true;
  }});
  await expect(page.getByLabel("Unknown usage")).toBeVisible();
  await expect(page.getByText("Stale",{exact:true})).toBeVisible();
  await expect(page.getByText("Last reading",{exact:true})).toBeVisible();
  expect(await clippingProblems(page)).toEqual([]);
  await page.screenshot({animations:"disabled",path:evidence("740x320-unknown-stale")});
  await page.getByRole("button",{name:"All Codex windows"}).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("a pointer-selected view still auto-hides after eight idle seconds", async ({page}) => {
  await page.clock.install();
  await open(page);
  await page.getByRole("tab",{name:"Deck",exact:true}).click();
  await page.mouse.move(1,1);
  await page.clock.runFor(8100);
  await expect(page.getByRole("button",{name:"Open menu / status"})).toBeVisible();
  await expect(page.getByRole("button",{name:"Open menu / status"})).toBeFocused();
});

test("custom and unknown durations remain visible on Monitor", async ({page}) => {
  await open(page,360,800,{edit:f=> {
    f.hub.data!.usage.claude.windows[0]!.windowDurationMins = 45;
    f.hub.data!.usage.claude.windows[0]!.label = "Custom window";
    f.hub.data!.usage.codex.windows[0]!.windowDurationMins = null;
    f.hub.data!.usage.codex.windows[0]!.label = "Other window";
  }});
  await expect(page.getByLabel("45 minutes",{exact:true})).toHaveText("45m");
  await expect(page.getByText("Duration unknown",{exact:true})).toBeVisible();
  expect(await clippingProblems(page,true)).toEqual([]);
});

test("enlarged content scrolls clear of the hidden bar's edge strip and keeps alerts clickable", async ({page}) => {
  await open(page,360,800);
  await applyTextZoom(page,1.3);
  // The open bar overlays content like an auto-hiding taskbar; once hidden, only
  // the thin edge strip remains and content ends above it.
  await page.getByRole("button",{name:"Hide bar"}).click();
  const details = page.getByRole("button",{name:"Details (1)",exact:true});
  await details.scrollIntoViewIfNeeded();
  const a = await details.boundingBox();
  const b = await page.getByRole("button",{name:"Open menu / status"}).boundingBox();
  expect(a!.y+a!.height).toBeLessThanOrEqual(b!.y + .5);
  await details.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

for (const [width, height, shown] of [[800,360,2],[740,320,2],[360,800,3]] as const) {
  test(`alerts list the newest ${shown} and fit beside compact usage at ${width}x${height}`, async ({page}) => {
    await open(page,width,height,{edit:f => {
      const items = f.hub.data!.notifications.items;
      const base = items[0]!;
      items.splice(0, items.length,
        {...base, id:"synthetic-a", appId:"Codex", title:"Synthetic oldest alert", receivedAtEpochMs: base.receivedAtEpochMs - 120_000, expiresAtEpochMs: base.expiresAtEpochMs - 120_000},
        {...base, id:"synthetic-b", appId:"WhatsApp", title:"Synthetic middle alert with a long title that must truncate cleanly", receivedAtEpochMs: base.receivedAtEpochMs - 60_000, expiresAtEpochMs: base.expiresAtEpochMs - 60_000},
        {...base, id:"synthetic-c", appId:"Claude", title:"Synthetic newest alert"},
      );
    }});
    const titles = page.locator(".notification-preview article:visible strong");
    await expect(titles).toHaveCount(shown);
    await expect(titles.first()).toHaveText("Synthetic newest alert");
    expect(await page.locator(".main-grid").evaluate(e => e.scrollHeight <= e.clientHeight + 1), "Monitor needs no internal scroll").toBe(true);
    expect(await clippingProblems(page)).toEqual([]);
    expect(await overlapProblems(page)).toEqual([]);
    await page.screenshot({animations:"disabled",path:evidence(`${width}x${height}-alerts`)});
  });
}

test("a new WhatsApp alert pulses the lamp green and the setting turns it off", async ({page}) => {
  // Midday, so quiet hours never apply; timers still run normally.
  await page.clock.setFixedTime(new Date(2026, 9, 15, 12, 0));
  const data = await open(page, 800, 360);
  const pulses = async () => (await bridgeLog(page)).filter(x => x.op === "esp.set").map(x => (x.args as {patch: Record<string, unknown>}).patch);
  const base = data.hub.data!.notifications.items[0]!;
  const add = async (id: string, appId: string) => {
    data.hub.data!.notifications.items.push({...base, id, appId, title: "Synthetic signal alert"});
    await setBridgeSlot(page, "hub", data.hub);
  };
  await add("synthetic-wa-1", "WhatsApp");
  await expect.poll(pulses, {timeout: 6000}).toContainEqual({power: true, mode: 1, speed: 85, bright: 100, hex: "#25D366"});
  await expect.poll(async () => (await pulses()).length, {timeout: 9000}).toBe(2);
  expect((await pulses())[1]).toMatchObject({power: true, mode: 0});

  await page.getByRole("button", {name: "Open settings"}).click();
  await page.getByLabel("Pulse green for WhatsApp messages").uncheck();
  expect(await controlProblems(page, "dialog", {allowVerticalScroll: true})).toEqual([]);
  await page.getByRole("dialog").getByText("Lamp signals").scrollIntoViewIfNeeded();
  await page.screenshot({animations: "disabled", path: evidence("800x360-lamp-signal-settings")});
  await page.getByRole("button", {name: "Close sheet"}).click();
  await add("synthetic-wa-2", "WhatsApp");
  await page.waitForTimeout(3000);
  expect(await pulses()).toHaveLength(2);
});

async function panelProblems(page: Page) {
  return page.evaluate(() => {
    const errors: string[] = [];
    for (const panel of document.querySelectorAll<HTMLElement>(".vital-panel")) {
      if (panel.scrollWidth > panel.clientWidth + 1) errors.push(`${panel.className} wider than box ${panel.scrollWidth}>${panel.clientWidth}`);
      if (panel.scrollHeight > panel.clientHeight + 1) errors.push(`${panel.className} taller than box ${panel.scrollHeight}>${panel.clientHeight}`);
    }
    return errors;
  });
}
for (const [width, height] of [[800,360],[740,320],[360,800]] as const) {
  test(`Laptop screen shows CPU, GPU, memory and power at ${width}x${height}`, async ({page}) => {
    const data = await open(page, width, height);
    await page.getByRole("tab", {name: "Laptop", exact: true}).click();
    await expect(page.getByRole("region", {name: "Processor"})).toContainText("Synthetic 6-core CPU");
    // A few reports fill the load sparklines.
    for (let i = 1; i <= 6; i += 1) {
      const vitals = data.hub.data!.host!.vitals!;
      data.hub.data!.serverNowEpochMs += 2000;
      vitals.cpu!.usagePercent = [23.5, 41, 18, 67, 35, 52][i - 1]!;
      vitals.gpu!.usagePercent = [37, 52, 44, 71, 60, 66][i - 1]!;
      await setBridgeSlot(page, "hub", data.hub);
      await expect(page.getByRole("region", {name: "Processor"}).locator(".vital-value").first()).toHaveText(`${Math.round(vitals.cpu!.usagePercent)}%`);
    }
    await expect(page.locator(".vital-spark polyline")).toHaveCount(2);
    await expect(page.getByRole("region", {name: "Graphics"})).toContainText("not reported by driver");
    await expect(page.getByRole("region", {name: "Power"})).toContainText("2 h 41 min left");
    await page.getByRole("button", {name: "Hide bar"}).click();
    expect(await panelProblems(page)).toEqual([]);
    // Portrait scrolls: check the end of the list, where the last panel sits just above the edge strip.
    await page.locator(".laptop-container").evaluate(e => e.scrollTo(0, e.scrollHeight));
    expect(await overlapProblems(page)).toEqual([]);
    expect(await controlProblems(page, "body", {allowVerticalScroll: height > width})).toEqual([]);
    if (width > height) expect(await page.locator(".laptop-container").evaluate(e => e.scrollHeight <= e.clientHeight + 1), "Laptop screen needs no internal scroll").toBe(true);
    await page.screenshot({animations: "disabled", path: evidence(`${width}x${height}-laptop`), fullPage: true});
  });
}

test("Laptop screen shows a sleeping GPU, heat colours and the disconnected state", async ({page}) => {
  const data = await open(page, 800, 360, {edit: f => {
    const vitals = f.hub.data!.host!.vitals!;
    vitals.cpu!.tempC = 91;
    vitals.gpu = {...vitals.gpu!, state: "asleep", usagePercent: null, tempC: null, powerW: null, memoryUsedMb: null, clockMhz: null};
    vitals.power = {source: "ac", batteryPercent: 100, charging: false, watts: null, minutesLeft: null};
    vitals.storageTempC = 78;
  }});
  const monitor = page.getByRole("tab", {name: "Monitor", exact: true});
  await monitor.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", {name: "Laptop", exact: true})).toBeFocused();
  await expect(page.getByRole("tab", {name: "Laptop", exact: true})).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", {name: "Graphics"})).toContainText("Asleep");
  await expect(page.locator(".vital-cpu .vital-readout.is-hot")).toHaveCount(1);
  await expect(page.getByRole("region", {name: "Power"})).toContainText("Battery full");
  await expect(page.locator(".vital-meta .is-warm")).toHaveText("SSD 78°C");
  await page.keyboard.press("ArrowRight");
  await expect(monitor).toBeFocused();
  await page.keyboard.press("End");
  await page.getByRole("button", {name: "Hide bar"}).click();
  expect(await panelProblems(page)).toEqual([]);
  await page.screenshot({animations: "disabled", path: evidence("800x360-laptop-asleep-hot")});
  data.hub = {state: "disconnected", ageMs: null, stale: true, data: null, errorCode: "USB_UNAVAILABLE"};
  await setBridgeSlot(page, "hub", data.hub);
  await expect(page.getByText("Connect the laptop to see its CPU, GPU, memory and power.")).toBeVisible();
});
