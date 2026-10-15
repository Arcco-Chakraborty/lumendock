import { test as base, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

export { expect };
export const evidence = (name: string) =>
  resolve(import.meta.dirname, "..", "evidence", `astra-redesign/${name}.png`);

/**
 * Every test gets a page that records uncaught errors, console errors and every
 * network request. The production dashboard must not touch anything but the
 * local preview origin, so tests assert both lists at teardown.
 */
export const test = base.extend<{
  watch: { errors: string[]; remote: string[]; requests: string[] };
}>({
  watch: [
    async ({ page }, use) => {
      const watch = {
        errors: [] as string[],
        remote: [] as string[],
        requests: [] as string[],
      };
      page.on("pageerror", (error) => watch.errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") watch.errors.push(message.text());
      });
      page.on("request", (request) => {
        const url = new URL(request.url());
        watch.requests.push(url.pathname);
        if (url.origin !== "http://127.0.0.1:4173" && url.protocol !== "data:")
          watch.remote.push(request.url());
      });
      await use(watch);
      expect(watch.errors, "no uncaught or console errors").toEqual([]);
      expect(watch.remote, "no remote requests").toEqual([]);
    },
    { auto: true },
  ],
});

export interface Box {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
const PRIMARY =
  "button, input, select, textarea, a[href], [role=button], summary";

/** Bounding boxes of every visible interactive control in the live DOM. */
export function controlBoxes(
  page: Page,
  scope = "body",
): Promise<Box[]> {
  return page.evaluate(
    ([selector, within]) => {
      const root = document.querySelector(within as string) ?? document.body;
      return Array.from(root.querySelectorAll(selector as string))
        .filter((element) => {
          const style = getComputedStyle(element);
          return (
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            element.getClientRects().length > 0
          );
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const label =
            element.getAttribute("aria-label") ||
            (element as HTMLElement).innerText?.trim() ||
            element.tagName.toLowerCase();
          return {
            label: `${element.tagName.toLowerCase()}:${label}`.slice(0, 60),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        });
    },
    [PRIMARY, scope] as const,
  );
}

/** Controls whose rectangle leaves the viewport, or whose tap target is < 44 CSS px. */
export async function controlProblems(
  page: Page,
  scope = "body",
  options: { allowVerticalScroll?: boolean } = {},
): Promise<string[]> {
  const viewport = page.viewportSize()!;
  const problems: string[] = [];
  for (const box of await controlBoxes(page, scope)) {
    const tolerance = 0.5;
    if (
      box.x < -tolerance ||
      (!options.allowVerticalScroll && box.y < -tolerance) ||
      box.x + box.width > viewport.width + tolerance ||
      (!options.allowVerticalScroll &&
        box.y + box.height > viewport.height + tolerance)
    )
      problems.push(
        `${box.label} outside ${viewport.width}x${viewport.height}: ${JSON.stringify(box)}`,
      );
    if (box.width < 44 - tolerance || box.height < 44 - tolerance)
      problems.push(
        `${box.label} tap target ${box.width.toFixed(1)}x${box.height.toFixed(1)} < 44`,
      );
  }
  return problems;
}

/** Page-level overflow plus text/content clipped inside cards and key readouts. */
export function clippingProblems(
  page: Page,
  allowVerticalScroll = false,
): Promise<string[]> {
  return page.evaluate((scrolls) => {
    const problems: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > innerWidth)
      problems.push(`horizontal overflow ${root.scrollWidth}>${innerWidth}`);
    const cards = document.querySelectorAll(
      ".usage-card, .climate-card, .lighting-card, .topbar, .notification-strip",
    );
    for (const card of cards) {
      const element = card as HTMLElement;
      if (element.scrollHeight > element.clientHeight + 1)
        problems.push(
          `${element.className} content taller than box ${element.scrollHeight}>${element.clientHeight}`,
        );
      if (element.scrollWidth > element.clientWidth + 1)
        problems.push(
          `${element.className} content wider than box ${element.scrollWidth}>${element.clientWidth}`,
        );
    }
    const readouts = document.querySelectorAll(
      ".usage-value, .temperature, .humidity strong, .power-button, .clock, .link-status, .card-heading h2",
    );
    for (const readout of readouts) {
      const element = readout as HTMLElement;
      if (element.scrollWidth > element.clientWidth + 1)
        problems.push(
          `${element.className || element.tagName} text clipped ${element.scrollWidth}>${element.clientWidth}`,
        );
      const rect = element.getBoundingClientRect();
      if (
        rect.right > innerWidth + 0.5 ||
        (!scrolls && rect.bottom > innerHeight + 0.5)
      )
        problems.push(
          `${element.className || element.tagName} outside viewport`,
        );
    }
    // Sibling regions must not overlap each other.
    const regions = Array.from(
      document.querySelectorAll(
        ".topbar, .usage-card, .climate-card, .lighting-card, .notification-strip",
      ),
    ).map((element) => ({
      name: element.className,
      rect: element.getBoundingClientRect(),
    }));
    for (let i = 0; i < regions.length; i += 1)
      for (let j = i + 1; j < regions.length; j += 1) {
        const a = regions[i]!.rect,
          b = regions[j]!.rect;
        if (
          a.left < b.right - 1 &&
          b.left < a.right - 1 &&
          a.top < b.bottom - 1 &&
          b.top < a.bottom - 1
        )
          problems.push(`${regions[i]!.name} overlaps ${regions[j]!.name}`);
      }
    return problems;
  }, allowVerticalScroll);
}

/** Interactive controls must not sit on top of someone else's rendered text. */
export function overlapProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        element.getClientRects().length > 0
      );
    };
    const controls = Array.from(
      document.querySelectorAll("button, input, select, a[href]"),
    ).filter(visible);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const texts: Array<{ node: Text; rects: DOMRect[] }> = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      const parent = text.parentElement;
      if (!parent || !text.data.trim() || !visible(parent)) continue;
      if (parent.closest("[aria-hidden=true], script, style")) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      texts.push({ node: text, rects: Array.from(range.getClientRects()) });
    }
    for (const control of controls) {
      const box = control.getBoundingClientRect();
      for (const { node, rects } of texts) {
        if (control.contains(node)) continue;
        // Text inside a closed/hidden dialog is not visible; skipped by `visible`.
        for (const rect of rects) {
          const w = Math.min(box.right, rect.right) - Math.max(box.left, rect.left);
          const h = Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top);
          if (w > 2 && h > 2)
            problems.push(
              `${control.getAttribute("aria-label") ?? control.tagName} covers text "${node.data.trim().slice(0, 24)}"`,
            );
        }
      }
    }
    return Array.from(new Set(problems));
  });
}

/**
 * Emulates Android WebView textZoom: scales every authored px font-size by `factor`
 * (text only; layout units are untouched), including rules inside media queries.
 */
export function applyTextZoom(page: Page, factor: number): Promise<void> {
  return page.evaluate((scale) => {
    const visit = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules)
          visit((rule as CSSGroupingRule).cssRules);
        const style = (rule as CSSStyleRule).style;
        const size = style?.getPropertyValue("font-size");
        if (size && size.endsWith("px") && parseFloat(size) > 0)
          style.setProperty(
            "font-size",
            `${parseFloat(size) * scale}px`,
            style.getPropertyPriority("font-size"),
          );
      }
    };
    for (const sheet of Array.from(document.styleSheets)) visit(sheet.cssRules);
  }, factor);
}
