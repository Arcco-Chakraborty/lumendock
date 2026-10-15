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
  const keys = ["Open Claude","Open ChatGPT","Open Chrome","Open WhatsApp","Open Terminal","Previous track","Play or pause","Next track","Volume down","Toggle mute","Volume up"];
  for (const key of keys) {
    await page.getByRole("button",{name:key,exact:true}).click();
    await expect(page.getByRole("status")).toContainText("request sent");
  }
  expect((await bridgeLog(page)).filter(x=>x.op === "hub.action").map(x=>x.args)).toEqual([
    "open_claude","open_chatgpt","open_chrome","open_whatsapp","open_terminal","media_prev","media_play_pause","media_next","volume_down","media_mute","volume_up"
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

test("enlarged content scrolls above the dock and keeps alerts clickable", async ({page}) => {
  await open(page,360,800);
  await applyTextZoom(page,1.3);
  const details = page.getByRole("button",{name:"Details (1)",exact:true});
  await details.scrollIntoViewIfNeeded();
  const a = await details.boundingBox();
  const b = await page.locator(".bottom-dock").boundingBox();
  expect(a!.y+a!.height).toBeLessThan(b!.y);
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
