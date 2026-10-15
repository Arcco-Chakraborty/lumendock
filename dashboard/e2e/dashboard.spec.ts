import type { Page } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  bridgeCall,
  bridgeLog,
  installSyntheticNativeBridge,
  setBridgeSlot,
  type BridgeOptions,
  type BridgeLogEntry,
} from "./bridge.js";
import {
  applyTextZoom,
  clippingProblems,
  controlBoxes,
  controlProblems,
  evidence,
  overlapProblems,
  expect,
  test,
} from "./harness.js";

const power = (page: Page) => page.getByRole("button", { name: /^power (on|off)$/i });

async function openDashboard(
  page: Page,
  viewport: { width: number; height: number },
  options: BridgeOptions = {},
) {
  await page.setViewportSize(viewport);
  const data = await installSyntheticNativeBridge(page, options);
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
  return data;
}
const link = (
  page: Page,
  name: "Laptop" | "Controller",
  status: "connected" | "disconnected" = "connected",
) =>
  page.locator(".link-status", {
    hasText: new RegExp(`${name} ${status}$`),
  });
async function connected(page: Page) {
  await expect(link(page, "Laptop")).toBeVisible();
  await expect(link(page, "Controller")).toBeVisible();
  await expect(power(page)).toBeEnabled();
}
const writes = (log: BridgeLogEntry[]) => log.filter((e) => e.op === "esp.set");

const dist = join(import.meta.dirname, "..", "dist");
const distFiles = (dir = dist): string[] =>
  readdirSync(dir).flatMap((name) =>
    statSync(join(dir, name)).isDirectory()
      ? distFiles(join(dir, name))
      : [join(dir, name)],
  );

const LANDSCAPE = [
  { name: "800x360", width: 800, height: 360 },
  { name: "740x320", width: 740, height: 320 },
];

test.describe("production bundle (A13/A14)", () => {
  test("served bundle has no mock/demo code and no remote URLs", async ({ page }) => {
    const files = distFiles();
    expect(files.length).toBeGreaterThan(2);
    const allowed = [
      /^https?:\/\/www\.w3\.org\//,
      /^https?:\/\/json-schema\.org\//,
      /^https:\/\/react\.dev\/errors\/?$/,
      /^http:\/\/\[\$\{/,
    ];
    for (const file of files.filter((f) => /\.(js|css|html|svg)$/.test(f))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(
        /createMockAdapter|mocks\/(device|scenarios)|synthetic|diagnostic|\.has\(["']demo["']\)/i,
      );
      const remote = (text.match(/https?:\/\/[^\s"'`)<>\\]+/g) ?? []).filter(
        (url) => !allowed.some((pattern) => pattern.test(url)),
      );
      expect(remote, file).toEqual([]);
    }
    // The development demo switch is dead code in production: ?demo shows no fixture UI.
    await page.setViewportSize({ width: 800, height: 360 });
    await page.goto("/?demo=over-limit");
    await expect(page.getByText(/Open the Phone Monitor app/)).toBeVisible();
    await expect(page.getByText(/Synthetic/)).toHaveCount(0);
    await expect(page.getByText(/% used/)).toHaveCount(0);
    expect(await page.evaluate(() => "__bridge" in window || "phoneMonitor" in window)).toBe(false);
  });

  for (const viewport of LANDSCAPE) {
    test(`primary dashboard fits ${viewport.name} landscape`, async ({ page }) => {
      await openDashboard(page, viewport);
      await connected(page);
      await expect(page.getByRole("heading", { name: "Claude" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Codex" })).toBeVisible();
      await expect(page.getByText("24.5").first()).toBeVisible();
      await expect(page.getByText("55%").first()).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        "no horizontal overflow",
      ).toBe(false);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollHeight > innerHeight,
        ),
        "no vertical scroll needed at landscape",
      ).toBe(false);
      expect(await clippingProblems(page)).toEqual([]);
      expect(await controlProblems(page)).toEqual([]);
      expect(await overlapProblems(page), "controls must not cover text").toEqual([]);
      // The named primary controls exist and are individually inside the viewport.
      for (const name of [
        /open settings/i,
        /all claude windows/i,
        /all codex windows/i,
        /room history/i,
        /^power (on|off)$/i,
        /light controls/i,
        /^details/i,
      ]) {
        const box = await page.getByRole("button", { name }).boundingBox();
        expect(box, String(name)).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      // Normal text >= 14 CSS px; primary numbers >= 32 CSS px.
      const sizes = await page.evaluate(() => {
        const px = (selector: string) =>
          Array.from(document.querySelectorAll(selector)).map((e) =>
            parseFloat(getComputedStyle(e).fontSize),
          );
        return {
          text: Array.from(
            document.querySelectorAll(
              ".dashboard :is(p, span, h2, strong, button, time)",
            ),
          )
            .filter((e) => (e as HTMLElement).innerText?.trim())
            .filter((e) => !e.closest("[aria-hidden=true]"))
            .filter((e) => getComputedStyle(e).fontSize !== "0px")
            .map((e) => ({
              name: `${e.tagName}.${e.className}:${(e as HTMLElement).innerText.trim().slice(0, 20)}`,
              size: parseFloat(getComputedStyle(e).fontSize),
            })),
          numbers: [...px(".usage-value"), ...px(".temperature"), ...px(".power-button")],
        };
      });
      expect(
        sizes.text.filter((entry) => entry.size < 14),
        "text below 14 CSS px",
      ).toEqual([]);
      expect(Math.min(...sizes.numbers)).toBeGreaterThanOrEqual(32);
      await page.screenshot({ path: evidence(`${viewport.name}-ready`) });
    });
  }

  test("360x800 portrait is readable and operable", async ({ page }) => {
    await openDashboard(page, { width: 360, height: 800 });
    await connected(page);
    expect(await clippingProblems(page, true)).toEqual([]);
    expect(await controlProblems(page, "body", { allowVerticalScroll: true })).toEqual([]);
    expect(await overlapProblems(page)).toEqual([]);
    await page.screenshot({ path: evidence("360x800-portrait"), fullPage: true });
    await page.getByRole("button", { name: /open settings/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await controlProblems(page, "dialog", { allowVerticalScroll: true })).toEqual([]);
    await page.screenshot({ path: evidence("360x800-settings") });
  });

  for (const [name, viewport] of [
    ["360x800", { width: 360, height: 800 }],
    ["800x360", { width: 800, height: 360 }],
  ] as const) {
    test(`increased text size (130%) stays operable at ${name}`, async ({ page }) => {
      await openDashboard(page, viewport);
      await connected(page);
      await applyTextZoom(page, 1.3);
      // No horizontal clipping and every control stays a >= 44 px tap target; vertical
      // scrolling is acceptable when text grows, but every control must be reachable.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      for (const box of await controlBoxes(page)) {
        expect(box.width, box.label).toBeGreaterThanOrEqual(43.5);
        expect(box.height, box.label).toBeGreaterThanOrEqual(43.5);
        expect(box.x, box.label).toBeGreaterThanOrEqual(-0.5);
        expect(box.x + box.width, box.label).toBeLessThanOrEqual(viewport.width + 0.5);
      }
      await power(page).scrollIntoViewIfNeeded();
      await expect(power(page)).toBeInViewport();
      await page.getByRole("button", { name: /open settings/i }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      const close = page.getByRole("button", { name: /close sheet/i });
      await close.scrollIntoViewIfNeeded();
      await expect(close).toBeInViewport();
      await page.screenshot({ path: evidence(`${name}-text130-settings`) });
    });
  }

  test("reduced motion removes animation and transitions", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openDashboard(page, { width: 800, height: 360 });
    await connected(page);
    const moving = await page.evaluate(() =>
      Array.from(document.querySelectorAll("*"))
        .filter((e) => {
          const s = getComputedStyle(e);
          const nonzero = (list: string) =>
            list.split(",").some((v) => parseFloat(v) > 0);
          return nonzero(s.animationDuration) || nonzero(s.transitionDuration);
        })
        .map((e) => e.tagName + "." + e.className),
    );
    expect(moving).toEqual([]);
    expect(
      await page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);
  });

  test("keyboard order and focus restoration for the settings and detail dialogs", async ({
    page,
  }) => {
    await openDashboard(page, { width: 800, height: 360 });
    await connected(page);
    const focused = () =>
      page.evaluate(() => {
        const e = document.activeElement as HTMLElement | null;
        return e
          ? e.getAttribute("aria-label") || e.innerText.trim() || e.tagName
          : "none";
      });
    // Document order of the primary controls.
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    const order: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      await page.keyboard.press("Tab");
      order.push(await focused());
    }
    expect(order).toEqual([
      "Open settings",
      "All Claude windows",
      "All Codex windows",
      "Room history",
      "Power off",
      "Light controls",
      "Details (1)",
    ]);
    // Settings: Enter opens, focus moves inside, Tab stays inside, Escape restores focus.
    const openers: Array<[RegExp, RegExp]> = [
      [/open settings/i, /^Settings$/],
      [/all claude windows/i, /^Usage windows$/],
      [/room history/i, /^Room history$/],
      [/light controls/i, /^Lighting$/],
      [/^details/i, /^Notifications$/],
    ];
    for (const [button, title] of openers) {
      const opener = page.getByRole("button", { name: button }).first();
      await opener.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(title).first()).toBeVisible();
      expect(
        await page.evaluate(() => !!document.activeElement?.closest("dialog")),
        "focus moved into the dialog",
      ).toBe(true);
      for (let i = 0; i < 14; i += 1) {
        await page.keyboard.press("Tab");
        // Focus may wrap through the (absent) browser chrome as <body>, but it must
        // never land on the inert dashboard behind the modal.
        expect(
          await page.evaluate(() => {
            const active = document.activeElement;
            return (
              active === document.body || !!active?.closest("dialog")
            );
          }),
          "Tab does not reach the page behind the modal dialog",
        ).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
    }
    // The Close button also restores focus.
    const settings = page.getByRole("button", { name: /open settings/i });
    await settings.click();
    await page.getByRole("button", { name: /close sheet/i }).click();
    await expect(settings).toBeFocused();
    await page.screenshot({ path: evidence("focus-ring-800x360") });
  });

  test("data refresh does not move focus or close an open sheet", async ({ page }) => {
    await openDashboard(page, { width: 800, height: 360 });
    await connected(page);
    await page.getByRole("button", { name: /open settings/i }).click();
    const slider = page.getByRole("slider", { name: "Display brightness" });
    await slider.focus();
    const polls = (await bridgeLog(page)).filter((e) => e.op === "hub.snapshot").length;
    await expect
      .poll(async () => (await bridgeLog(page)).filter((e) => e.op === "hub.snapshot").length, {
        timeout: 8000,
      })
      .toBeGreaterThan(polls + 1);
    await expect(slider).toBeFocused();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("offline shell renders from local assets and keeps working without a network", async ({
    page,
    context,
    watch,
  }) => {
    await openDashboard(page, { width: 800, height: 360 });
    await connected(page);
    await context.setOffline(true);
    // Everything after this point must run from the already loaded local bundle.
    await page.getByRole("button", { name: /open settings/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: /close sheet/i }).click();
    await power(page).click();
    await expect(page.getByRole("button", { name: "Power on" })).toBeVisible();
    await context.setOffline(false);
    // The shell never requested anything beyond its own origin (also asserted at teardown).
    expect(watch.requests.some((p) => /\.(js|css)$/.test(p))).toBe(true);
    expect(watch.remote).toEqual([]);
  });

  test("without the native bridge the shell still renders setup guidance", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 360 });
    await page.goto("/");
    await expect(page.getByText(/Open the Phone Monitor app/)).toBeVisible();
    await expect(link(page, "Laptop", "disconnected")).toBeVisible();
    await expect(link(page, "Controller", "disconnected")).toBeVisible();
    await expect(page.getByText(/Synthetic demo/)).toHaveCount(0);
    await page.screenshot({ path: evidence("800x360-no-bridge") });
  });
});

test.describe("independent link loss", () => {
  test("USB failure leaves room controls available", async ({ page }) => {
    await openDashboard(page, { width: 740, height: 320 }, { hub: "disconnected" });
    await expect(link(page, "Laptop", "disconnected")).toBeVisible();
    await expect(link(page, "Controller", "connected")).toBeVisible();
    await expect(power(page)).toBeEnabled();
    await expect(page.getByText("24.5").first()).toBeVisible();
    await page.screenshot({ path: evidence("740x320-usb-down") });
    // The light really works while the laptop path is down.
    await power(page).click();
    await expect(page.getByRole("button", { name: "Power on" })).toBeVisible();
    expect(writes(await bridgeLog(page))).toHaveLength(1);
  });

  test("ESP failure leaves laptop quotas visible", async ({ page }) => {
    await openDashboard(page, { width: 740, height: 320 }, { esp: "disconnected" });
    await expect(link(page, "Controller", "disconnected")).toBeVisible();
    await expect(link(page, "Laptop", "connected")).toBeVisible();
    await expect(page.getByText("17.25% used").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /all claude windows/i })).toBeEnabled();
    await expect(power(page)).toBeDisabled();
    await page.screenshot({ path: evidence("740x320-esp-down") });
  });

  test("a link that drops later is marked down while the other path keeps updating", async ({
    page,
  }) => {
    const data = await openDashboard(page, { width: 800, height: 360 });
    await connected(page);
    await setBridgeSlot(page, "hub", {
      state: "disconnected",
      ageMs: null,
      stale: true,
      data: null,
      errorCode: "USB_UNAVAILABLE",
    });
    await expect(link(page, "Laptop", "disconnected")).toBeVisible({ timeout: 6000 });
    await expect(link(page, "Controller", "connected")).toBeVisible();
    await expect(power(page)).toBeEnabled();
    // The last quota is retained with its own report age instead of being blanked.
    await expect(page.getByText("17.25% used").first()).toBeVisible();
    await expect(page.getByText(/\d+[smh] ago/).first()).toBeVisible();
    await page.screenshot({ path: evidence("800x360-usb-dropped") });
    // Now the controller drops; laptop path recovers.
    await setBridgeSlot(page, "hub", data.hub);
    await setBridgeSlot(page, "esp", {
      state: "disconnected",
      ageMs: null,
      stale: true,
      data: null,
      errorCode: "WIFI_UNAVAILABLE",
      commands: { state: null, timer: null },
    });
    await expect(link(page, "Laptop", "connected")).toBeVisible({ timeout: 6000 });
    await expect(link(page, "Controller", "disconnected")).toBeVisible({ timeout: 8000 });
    await expect(page.getByText("17.25% used").first()).toBeVisible();
  });
});

test.describe("content rules", () => {
  test("notification markup is rendered as plain text", async ({ page }) => {
    await openDashboard(
      page,
      { width: 800, height: 360 },
      {
        edit: ({ hub }) => {
          const item = hub.data!.notifications.items[0]!;
          item.title = "<b>Synthetic markup</b>";
          item.body = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
          item.appId = "<i>Synthetic app</i>";
        },
      },
    );
    await connected(page);
    await expect(page.locator(".notification-preview")).toContainText("<b>Synthetic markup</b>");
    await expect(page.locator(".notification-preview")).toContainText("onerror");
    await page.getByRole("button", { name: /^details/i }).click();
    const list = page.locator(".notification-list");
    await expect(list).toContainText("<b>Synthetic markup</b>");
    await expect(list).toContainText('<img src=x onerror="window.__xss=1">');
    expect(await page.locator("main img, main script, main b, main i").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await page.screenshot({ path: evidence("800x360-notification-markup") });
  });

  test("usage above 100% and nonstandard Codex bucket durations stay visible", async ({
    page,
  }) => {
    await openDashboard(
      page,
      { width: 800, height: 360 },
      {
        edit: ({ hub }) => {
          const codex = hub.data!.usage.codex;
          const base = codex.windows[0]!;
          codex.windows = [
            { ...base, usedPercent: 120, label: "Synthetic custom bucket", windowDurationMins: 45, bucketId: "synthetic-a", windowId: "synthetic-a-45" },
            { ...base, usedPercent: 0, label: "Synthetic weekly", windowDurationMins: 10080, bucketId: "synthetic-b", windowId: "synthetic-b-week" },
            { ...base, usedPercent: 33.333, label: "Synthetic unknown span", windowDurationMins: null, bucketId: "synthetic-c", windowId: "synthetic-c-unknown" },
          ];
        },
      },
    );
    await connected(page);
    // Primary card shows the first bucket honestly: over 100%, not clamped or hidden.
    await expect(page.getByText("120% used")).toBeVisible();
    expect(await clippingProblems(page)).toEqual([]);
    await page.screenshot({ path: evidence("800x360-over-limit") });
    await page.getByRole("button", { name: /all codex windows/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("45 minutes")).toBeVisible();
    await expect(dialog.getByText("10080 minutes")).toBeVisible();
    await expect(dialog.getByText("Duration unknown")).toBeVisible();
    await expect(dialog.getByText("0% used", { exact: true })).toBeVisible();
    await expect(dialog.getByText("33.333% used")).toBeVisible();
    await expect(dialog.getByText("Synthetic custom bucket")).toBeVisible();
    await page.screenshot({ path: evidence("800x360-codex-windows") });
  });
});

test.describe("light control writes (bridge log)", () => {
  test("keeps one esp.set in flight and merges later changes", async ({ page }) => {
    await openDashboard(page, { width: 800, height: 360 }, { holdSets: true });
    await connected(page);
    await page.getByRole("button", { name: /light controls/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Red" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Red" }).click();
    await expect.poll(async () => writes(await bridgeLog(page)).length).toBe(1);
    // While the first write is unanswered, further changes must not reach the bridge.
    await dialog.getByRole("button", { name: "Blue" }).click();
    await dialog.getByLabel("Light mode").selectOption("2");
    await dialog.getByRole("button", { name: "Violet" }).click();
    await page.waitForTimeout(600);
    expect(writes(await bridgeLog(page)), "only the first write is on the wire").toHaveLength(1);
    expect(await bridgeCall<number>(page, "heldCount")).toBe(1);
    await page.screenshot({ path: evidence("800x360-light-pending") });
    await bridgeCall(page, "holdSets", false);
    await expect.poll(async () => writes(await bridgeLog(page)).length).toBe(2);
    await page.waitForTimeout(400);
    const sent = writes(await bridgeLog(page));
    expect(sent).toHaveLength(2);
    expect(sent.every((entry) => entry.concurrent === 0)).toBe(true);
    expect(await bridgeCall<number>(page, "maxOutstanding")).toBe(1);
    const merged = (sent[1]!.args as { patch: Record<string, unknown> }).patch;
    expect(merged).toMatchObject({ hex: "#BB55FF", mode: 2 });
    const first = (sent[0]!.args as { generation: number; patch: unknown });
    const second = (sent[1]!.args as { generation: number });
    expect(first.patch).toEqual({ hex: "#FF4040" });
    expect(second.generation).toBeGreaterThan(first.generation);
  });

  test("a timer is a separate command and is never repeated on its own", async ({
    page,
  }) => {
    await openDashboard(page, { width: 800, height: 360 });
    await connected(page);
    await page.getByRole("button", { name: /light controls/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/sleep timer/i).fill("45");
    await dialog.getByRole("button", { name: "Set timer" }).click();
    await expect.poll(async () => writes(await bridgeLog(page)).length).toBe(1);
    await page.waitForTimeout(800);
    const sent = writes(await bridgeLog(page));
    expect(sent).toHaveLength(1);
    expect((sent[0]!.args as { patch: unknown }).patch).toEqual({ timerMinutes: 45 });
    await expect(dialog.getByText(/45 minutes/)).toBeVisible();
  });
});

test.describe("final-review fixes", () => {
  for (const viewport of LANDSCAPE) {
    test(`unpaired layout fits ${viewport.name} without clipping`, async ({ page }) => {
      await openDashboard(page, viewport, {
        edit: (f) => {
          f.app.paired = false;
          f.hub = { state: "error", ageMs: null, stale: true, data: null, errorCode: "AUTH_REQUIRED" };
        },
      });
      await expect(page.locator(".pair-card")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      expect(await clippingProblems(page)).toEqual([]);
      expect(await controlProblems(page)).toEqual([]);
      expect(await overlapProblems(page), "controls must not cover text").toEqual([]);
      await page.screenshot({ path: evidence(`${viewport.name}-unpaired`) });
    });
  }
  test("an unpaired phone says so and offers pairing on the main screen", async ({ page }) => {
    await openDashboard(page, { width: 740, height: 320 }, {
      edit: (f) => {
        f.app.paired = false;
        f.hub = { state: "error", ageMs: null, stale: true, data: null, errorCode: "AUTH_REQUIRED" };
      },
    });
    await expect(page.locator(".link-status", { hasText: /Laptop not paired$/ })).toBeVisible();
    await expect(page.getByText("This phone is not paired with the laptop yet.")).toBeVisible();
    const pair = page.locator(".pair-card").getByRole("button", { name: "Pair laptop" });
    const box = await pair.boundingBox();
    expect(box && box.height >= 44 && box.y + box.height <= 320).toBe(true);
    await pair.click();
    await expect.poll(async () => (await bridgeLog(page)).some((e) => e.op === "app.setupHub")).toBe(true);
  });
  test("a revoked token asks to pair again", async ({ page }) => {
    await openDashboard(page, { width: 800, height: 360 }, {
      edit: (f) => {
        f.hub = { state: "error", ageMs: null, stale: true, data: null, errorCode: "AUTH_REQUIRED" };
      },
    });
    await expect(page.getByText("The laptop no longer accepts this phone. Pair again.")).toBeVisible();
  });
  test("a paired phone shows no pairing banner", async ({ page }) => {
    await openDashboard(page, { width: 800, height: 360 });
    await connected(page);
    await expect(page.locator(".pair-card")).toHaveCount(0);
  });
  test("brightness slider keeps focus and sends the final value while replies are slow", async ({ page }) => {
    await openDashboard(page, { width: 800, height: 360 }, { latencyMs: 300 });
    await connected(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    const slider = page.getByRole("slider", { name: "Display brightness" });
    await slider.focus();
    const start = Number(await slider.inputValue());
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
    await expect(slider).toBeFocused();
    await expect(slider).toBeEnabled();
    await expect(slider).toHaveValue(String(start - 5));
    await expect
      .poll(async () => {
        const sent = (await bridgeLog(page)).filter((e) => e.op === "app.setBrightness");
        return (sent.at(-1)?.args as { value?: number } | undefined)?.value;
      }, { timeout: 5000 })
      .toBeCloseTo((start - 5) / 100, 5);
    const sent = (await bridgeLog(page)).filter((e) => e.op === "app.setBrightness");
    expect(sent.length).toBeLessThan(5); // latest-wins, not one write per keypress
    await expect(slider).toHaveValue(String(start - 5));
  });
});
