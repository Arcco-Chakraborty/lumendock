import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { CalendarEvent, CalendarPage, CalendarSource } from "@phone-monitor/protocol";
import {
  applyTextZoom,
  controlProblems,
  expect,
  overlapProblems,
  test,
} from "./harness.js";
import {
  bridgeLog,
  installSyntheticNativeBridge,
  setBridgeSlot,
  type BridgeOptions,
} from "./bridge.js";

const calendarDir = resolve(import.meta.dirname, "..", "evidence", "calendar");
mkdirSync(calendarDir, { recursive: true });
const calendarEvidence = (name: string) => resolve(calendarDir, `${name}.png`);

const BASE_NOW = 1772953200000; // 2026-03-08T07:00:00.000Z (02:00 EST -> 03:00 EDT in America/New_York)

const SOURCES: CalendarSource[] = [
  {
    sourceId: "synthetic_work",
    name: "Synthetic Work",
    color: "#22D3EE",
    selected: true,
    capability: "read",
    state: "available",
    lastSuccessAtEpochMs: BASE_NOW,
    errorCode: null,
  },
  {
    sourceId: "synthetic_personal",
    name: "Synthetic Personal",
    color: "#44CC77",
    selected: true,
    capability: "read",
    state: "available",
    lastSuccessAtEpochMs: BASE_NOW,
    errorCode: null,
  },
];

const EVENTS: CalendarEvent[] = [
  {
    id: "synthetic_all_day",
    sourceId: "synthetic_work",
    title: "Synthetic release milestone",
    start: { kind: "date", date: "2026-03-08" },
    end: { kind: "date", date: "2026-03-10" },
    calendarName: "Synthetic Work",
    calendarColor: "#22D3EE",
    label: { name: "Planning", color: "#A3B7FA" },
    eventType: "default",
    status: "confirmed",
    selfResponseStatus: "accepted",
    reminderMinutes: null,
  },
  {
    id: "synthetic_ongoing",
    sourceId: "synthetic_work",
    title: "Synthetic DST review",
    start: {
      kind: "time",
      epochMs: BASE_NOW - 15 * 60_000,
      timeZone: "America/New_York",
    },
    end: {
      kind: "time",
      epochMs: BASE_NOW + 30 * 60_000,
      timeZone: "America/New_York",
    },
    calendarName: "Synthetic Work",
    calendarColor: "#22D3EE",
    label: { name: "Synthetic focus", color: "#0088FF" },
    eventType: "default",
    status: "confirmed",
    selfResponseStatus: "accepted",
    reminderMinutes: 10,
  },
  {
    id: "synthetic_declined",
    sourceId: "synthetic_work",
    title: "Synthetic optional sync",
    start: {
      kind: "time",
      epochMs: BASE_NOW - 5 * 60_000,
      timeZone: "America/New_York",
    },
    end: {
      kind: "time",
      epochMs: BASE_NOW + 20 * 60_000,
      timeZone: "America/New_York",
    },
    calendarName: "Synthetic Work",
    calendarColor: "#22D3EE",
    label: null,
    eventType: "default",
    status: "confirmed",
    selfResponseStatus: "declined",
    reminderMinutes: null,
  },
  {
    id: "synthetic_unnamed_label",
    sourceId: "synthetic_personal",
    title: "Synthetic evening workout",
    start: {
      kind: "time",
      epochMs: BASE_NOW + 4 * 3600_000,
      timeZone: "America/New_York",
    },
    end: {
      kind: "time",
      epochMs: BASE_NOW + 5 * 3600_000,
      timeZone: "America/New_York",
    },
    calendarName: "Synthetic Personal",
    calendarColor: "#44CC77",
    label: { name: null, color: "#F2C084" },
    eventType: "default",
    status: "tentative",
    selfResponseStatus: "tentative",
    reminderMinutes: 30,
  },
];

async function openAgenda(
  page: Page,
  width = 800,
  height = 360,
  options: BridgeOptions = {},
) {
  await page.setViewportSize({ width, height });
  const data = await installSyntheticNativeBridge(page, {
    ...options,
    edit: (f) => {
      const cal = f.calendar.data!;
      cal.serverNowEpochMs = BASE_NOW;
      cal.lastSuccessAtEpochMs = BASE_NOW;
      cal.sourceCount = 2;
      cal.sources = structuredClone(SOURCES);
      cal.items = structuredClone(EVENTS);
      cal.nextEvent = structuredClone(EVENTS[1]!);
      f.calendarSources.data!.serverNowEpochMs = BASE_NOW;
      f.calendarSources.data!.sources = structuredClone(SOURCES);
      options.edit?.(f);
    },
  });
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
  await page.getByRole("tab", { name: "Agenda", exact: true }).click();
  await expect(page.locator("#agenda-panel")).toBeVisible();
  return data;
}

test.describe("Agenda layout and responsiveness", () => {
  for (const [width, height] of [
    [800, 360],
    [740, 320],
    [360, 800],
  ] as const) {
    test(`renders split landscape or stacked portrait Agenda at ${width}x${height} and 130% text`, async ({
      page,
    }) => {
      await openAgenda(page, width, height);
      await expect(page.getByRole("heading", { name: "Agenda" })).toBeVisible();
      await expect(page.getByText("Synthetic DST review").first()).toBeVisible();
      await expect(page.getByText("Synthetic focus").first()).toBeVisible();
      await expect(page.getByText("Labelled").first()).toBeVisible();
      await expect(page.getByText("Declined").first()).toBeVisible();

      const layout = await page.evaluate(() => {
        const next = document
          .querySelector(".agenda-next")!
          .getBoundingClientRect();
        const list = document
          .querySelector(".agenda-list-panel")!
          .getBoundingClientRect();
        return {
          nextRight: next.right,
          nextBottom: next.bottom,
          listLeft: list.left,
          listTop: list.top,
          overflowX: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(layout.overflowX, "no horizontal overflow").toBe(false);
      if (width > height) {
        expect(layout.nextRight).toBeLessThanOrEqual(layout.listLeft + 1);
      } else {
        expect(layout.nextBottom).toBeLessThanOrEqual(layout.listTop + 1);
      }

      expect(
        await controlProblems(page, "body", { allowVerticalScroll: true }),
      ).toEqual([]);
      expect(await overlapProblems(page)).toEqual([]);
      // Hide dock to verify controls across the whole panel and capture clean evidence.
      await page.getByRole("button", { name: "Hide bar" }).click();
      expect(
        await controlProblems(page, "body", { allowVerticalScroll: true }),
      ).toEqual([]);
      expect(
        await page
          .locator("[style]")
          .evaluateAll((els) =>
            els.map((e) => e.getAttribute("style")).filter((s) => s?.trim()),
          ),
      ).toEqual([]);

      const smallText = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll(
            "#agenda-panel :is(p, span, h2, h3, small, button, select, code)",
          ),
        )
          .filter((e) => (e as HTMLElement).innerText?.trim())
          .filter((e) => !e.closest("[aria-hidden=true]"))
          .map((e) => ({
            text: (e as HTMLElement).innerText.trim().slice(0, 24),
            size: parseFloat(getComputedStyle(e).fontSize),
          }))
          .filter((entry) => entry.size < 14),
      );
      expect(smallText, "no Agenda text below 14px").toEqual([]);

      await page.screenshot({
        animations: "disabled",
        path: calendarEvidence(`${width}x${height}-agenda-ready`),
        fullPage: height > width,
      });

      await page.getByRole("button", { name: "Open menu / status" }).click();
      await applyTextZoom(page, 1.3);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        "no horizontal overflow at 130% text",
      ).toBe(false);
      expect(
        await controlProblems(page, "body", { allowVerticalScroll: true }),
      ).toEqual([]);
      await page.getByRole("button", { name: "Hide bar" }).click();
      await page.screenshot({
        animations: "disabled",
        path: calendarEvidence(`${width}x${height}-agenda-text130`),
        fullPage: true,
      });
    });
  }
});

test.describe("Agenda interactions, paging and detail sheet", () => {
  test("supports 4-tab Home/End navigation, event detail sheet focus restoration, Today filter, range browsing and pagination", async ({
    page,
  }) => {
    const page2: CalendarPage = {
      v: 1,
      state: "available",
      errorCode: null,
      serverNowEpochMs: BASE_NOW,
      range: { startDate: "2026-03-08", days: 7, timeZone: "America/New_York" },
      revision: "synthetic_range_1",
      selectionRevision: "synthetic_selection_1",
      lastSuccessAtEpochMs: BASE_NOW,
      sourceCount: 2,
      failedSourceCount: 0,
      sources: SOURCES,
      items: [
        {
          id: "synthetic_page2_item",
          sourceId: "synthetic_work",
          title: "Synthetic second-page architecture review",
          start: {
            kind: "time",
            epochMs: BASE_NOW + 26 * 3600_000,
            timeZone: "America/New_York",
          },
          end: {
            kind: "time",
            epochMs: BASE_NOW + 27 * 3600_000,
            timeZone: "America/New_York",
          },
          calendarName: "Synthetic Work",
          calendarColor: "#22D3EE",
          label: { name: "Architecture", color: "#A3B7FA" },
          eventType: "default",
          status: "confirmed",
          selfResponseStatus: "accepted",
          reminderMinutes: 15,
        },
      ],
      nextEvent: EVENTS[1]!,
      nextCursor: null,
    };

    await openAgenda(page, 800, 360, {
      calendarPages: { "synthetic-page.2_abc-123": page2 },
      edit: (f) => {
        f.calendar.data!.nextCursor = "synthetic-page.2_abc-123";
      },
    });

    // Verify Home and End across all 4 tabs.
    const agendaTab = page.getByRole("tab", { name: "Agenda", exact: true });
    await agendaTab.focus();
    await page.keyboard.press("Home");
    await expect(
      page.getByRole("tab", { name: "Monitor", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("End");
    await expect(agendaTab).toBeFocused();
    await expect(page.locator("#agenda-panel")).toBeVisible();

    // Hide dock so the event list has full vertical space.
    await page.getByRole("button", { name: "Hide bar" }).click();

    // Load more appends page 2 without losing page 1 items.
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(
      page.getByText("Synthetic second-page architecture review"),
    ).toBeVisible();
    await expect(page.getByText("Synthetic release milestone")).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: calendarEvidence("800x360-agenda-paged"),
    });

    // Today filter keeps today's items and hides tomorrow's item; Upcoming restores all.
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(
      page.getByText("Synthetic second-page architecture review"),
    ).toHaveCount(0);
    await expect(page.getByText("Synthetic release milestone")).toBeVisible();
    await page.getByRole("button", { name: "Upcoming", exact: true }).click();
    await expect(
      page.getByText("Synthetic second-page architecture review"),
    ).toBeVisible();

    // Open read-only event detail sheet and verify focus moves inside and restores on Escape.
    const eventBtn = page
      .locator(".agenda-event", { hasText: "Synthetic DST review" })
      .first();
    await eventBtn.focus();
    await page.keyboard.press("Enter");
    const dialog = page.locator("dialog.agenda-sheet[open]");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Synthetic DST review");
    await expect(dialog).toContainText("Synthetic Work");
    await expect(dialog).toContainText("Synthetic focus");
    await expect(dialog).toContainText("Confirmed · Accepted");
    await expect(dialog).toContainText("Reminder 10 min before");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest("dialog")),
    ).toBe(true);
    expect(
      await controlProblems(page, "dialog.agenda-sheet", {
        allowVerticalScroll: true,
      }),
    ).toEqual([]);
    await page.screenshot({
      animations: "disabled",
      path: calendarEvidence("800x360-agenda-detail"),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(eventBtn).toBeFocused();

    // Manual Refresh sends refresh: true without cursor.
    await page.getByRole("button", { name: "Refresh agenda" }).click();
    await expect
      .poll(async () =>
        (await bridgeLog(page)).some(
          (e) =>
            e.op === "hub.calendar" &&
            (e.args as { refresh?: boolean }).refresh === true &&
            (e.args as { cursor?: string }).cursor === undefined,
        ),
      )
      .toBe(true);
  });

  test("preserves browsed range across tab remounts, rebases on Today, keeps failed Apply open, and closes details on disconnect while preserving offline details", async ({
    page,
  }) => {
    const data = await openAgenda(page, 800, 360);

    await expect(page.locator(".agenda-subtitle")).toContainText("Mar 8 to Mar 14");

    // Shift to Next week, switch to Monitor and return to Agenda: heading must reflect actual store range.
    await page.getByRole("button", { name: "Later dates" }).click();
    await expect(page.locator(".agenda-subtitle")).toContainText("Mar 15 to Mar 21");
    await page.getByRole("tab", { name: "Monitor", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Claude" })).toBeVisible();
    await page.getByRole("tab", { name: "Agenda", exact: true }).click();
    await expect(page.locator(".agenda-subtitle")).toContainText("Mar 15 to Mar 21");

    // Clicking Today after remount rebases the store range back to today.
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.locator(".agenda-subtitle")).toContainText("Mar 8 to Mar 14");
    await page.getByRole("button", { name: "Upcoming", exact: true }).click();

    // Open Calendars sheet: verify honest capability label and failed Apply keeps sheet open + reconciles checkboxes.
    await page.getByRole("button", { name: "Choose calendars" }).click();
    const sheet = page.locator("dialog.agenda-sheet[open]");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Readable · events");
    await expect(sheet).not.toContainText("Readable · events and labels");

    const personalCheckbox = sheet.getByRole("checkbox", {
      name: "Synthetic Personal",
    });
    await expect(personalCheckbox).toBeChecked();
    await personalCheckbox.uncheck();
    await expect(personalCheckbox).not.toBeChecked();

    // Inject a one-shot CALENDAR_SELECTION_CHANGED failure for the next hub.calendarSelect request.
    await page.evaluate(() => {
      const pm = (
        window as unknown as {
          phoneMonitor: {
            onmessage: null | ((event: { data: string }) => void);
            postMessage(msg: string): void;
          };
        }
      ).phoneMonitor;
      const orig = pm.postMessage.bind(pm);
      let failedOnce = false;
      pm.postMessage = (msg: string) => {
        const req = JSON.parse(msg) as { id: string; op: string };
        if (!failedOnce && req.op === "hub.calendarSelect") {
          failedOnce = true;
          setTimeout(() => {
            pm.onmessage?.({
              data: JSON.stringify({
                v: 1,
                id: req.id,
                ok: false,
                error: { code: "CALENDAR_SELECTION_CHANGED", retryable: false },
              }),
            });
          }, 5);
          return;
        }
        orig(msg);
      };
    });

    await sheet.getByRole("button", { name: "Apply calendars" }).click();
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("CALENDAR_SELECTION_CHANGED");
    await expect(personalCheckbox).toBeChecked();
    await sheet.getByRole("button", { name: "Close calendar sheet" }).click();
    await expect(sheet).toBeHidden();

    // Open event detail sheet: USB-offline preserves it, authenticated disconnect closes and purges it.
    await page.getByRole("button", { name: "Hide bar" }).click();
    await page
      .locator(".agenda-event", { hasText: "Synthetic DST review" })
      .first()
      .click();
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Synthetic DST review");

    await setBridgeSlot(page, "calendar", {
      state: "disconnected",
      ageMs: null,
      stale: true,
      data: null,
      errorCode: "USB_UNAVAILABLE",
    });
    await page.evaluate(() => {
      // Trigger visibility sync to poll while modal is open
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByText(/Offline · last sync/)).toBeVisible();
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Synthetic DST review");

    // Authenticated disconnect clears cached rows and closes the open detail modal.
    data.calendar.state = "connected";
    data.calendar.stale = false;
    data.calendar.ageMs = 0;
    data.calendar.errorCode = null;
    data.calendar.data!.state = "disabled";
    data.calendar.data!.items = [];
    data.calendar.data!.sources = [];
    data.calendar.data!.nextEvent = null;
    await setBridgeSlot(page, "calendar", data.calendar);
    await expect(
      page.getByRole("heading", { name: "Connect Google Calendar on the laptop" }),
    ).toBeVisible();
    await expect(sheet).toBeHidden();
    await expect(page.getByText("Synthetic DST review")).toHaveCount(0);
  });
});

test.describe("Calendar source inclusion and states", () => {
  test("setup_required enumerates all source pages, disambiguates duplicate names, and requires Apply before events render", async ({
    page,
  }) => {
    const dup1: CalendarSource = {
      sourceId: "synthetic_team_alpha",
      name: "Synthetic Team",
      color: "#22D3EE",
      selected: true,
      capability: "read",
      state: "setup_required",
      lastSuccessAtEpochMs: null,
      errorCode: null,
    };
    const dup2: CalendarSource = {
      sourceId: "synthetic_team_bravo",
      name: "Synthetic Team",
      color: "#FFB020",
      selected: true,
      capability: "busy",
      state: "setup_required",
      lastSuccessAtEpochMs: null,
      errorCode: null,
    };

    await openAgenda(page, 800, 360, {
      calendarSourcesPages: {
        "synthetic_sources_page_2": {
          v: 1,
          state: "setup_required",
          errorCode: null,
          serverNowEpochMs: BASE_NOW,
          selectionRevision: "synthetic_selection_1",
          sources: [dup2],
          nextCursor: null,
        },
      },
      edit: (f) => {
        f.calendar.data!.state = "setup_required";
        f.calendar.data!.items = [];
        f.calendar.data!.nextEvent = null;
        f.calendarSources.data!.state = "setup_required";
        f.calendarSources.data!.sources = [SOURCES[0]!, dup1];
        f.calendarSources.data!.nextCursor = "synthetic_sources_page_2";
      },
    });

    await page.getByRole("button", { name: "Hide bar" }).click();
    await expect(
      page.getByRole("heading", { name: "Choose calendars to import" }),
    ).toBeVisible();
    await expect(
      page.getByText("Synthetic Team (_alpha)"),
    ).toBeVisible();
    await expect(
      page.getByText("Synthetic Team (_bravo)"),
    ).toBeVisible();
    await expect(
      page.getByText(/Free\/busy only/),
    ).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: calendarEvidence("800x360-agenda-setup-required"),
    });

    // Apply selection transitions to available and loads events.
    await page.getByRole("button", { name: "Apply calendars" }).click();
    await expect
      .poll(async () =>
        (await bridgeLog(page)).some((e) => e.op === "hub.calendarSelect"),
      )
      .toBe(true);
  });

  test("renders disabled CLI guidance, partial, auth_required, capacity, old-hub unsupported, and USB-offline cached states", async ({
    page,
  }) => {
    const data = await openAgenda(page, 800, 360, {
      edit: (f) => {
        f.calendar.data!.state = "disabled";
        f.calendar.data!.items = [];
        f.calendar.data!.nextEvent = null;
      },
    });
    await page.getByRole("button", { name: "Hide bar" }).click();
    await expect(
      page.getByRole("heading", { name: "Connect Google Calendar on the laptop" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "node desktop/dist/main.js calendar connect --client <path-to-client-secret.json>",
      ),
    ).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: calendarEvidence("800x360-agenda-disabled"),
    });

    // Open local setup guide sheet.
    await page.getByRole("button", { name: "Setup guide" }).click();
    const guideDialog = page.locator("dialog.agenda-sheet[open]");
    await expect(guideDialog).toBeVisible();
    await expect(guideDialog).toContainText("Desktop OAuth client");
    await page.screenshot({
      animations: "disabled",
      path: calendarEvidence("800x360-agenda-guide"),
    });
    await page.getByRole("button", { name: "Close calendar sheet" }).click();

    // Partial sync state with events.
    data.calendar.data!.state = "partial";
    data.calendar.data!.errorCode = "CALENDAR_UNAVAILABLE";
    data.calendar.data!.failedSourceCount = 1;
    data.calendar.data!.sourceCount = 2;
    data.calendar.data!.items = structuredClone(EVENTS);
    data.calendar.data!.nextEvent = structuredClone(EVENTS[1]!);
    await setBridgeSlot(page, "calendar", data.calendar);
    await page.getByRole("button", { name: "Refresh agenda" }).click();
    await expect(page.getByText(/Partial sync: 1 of 2/)).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: calendarEvidence("800x360-agenda-partial"),
    });

    // USB disconnect preserves cached rows and marks Agenda offline.
    await setBridgeSlot(page, "calendar", {
      state: "disconnected",
      ageMs: null,
      stale: true,
      data: null,
      errorCode: "USB_UNAVAILABLE",
    });
    await page.getByRole("button", { name: "Refresh agenda" }).click();
    await expect(page.getByText(/Offline · last sync/)).toBeVisible();
    await expect(page.getByText("Synthetic DST review").first()).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: calendarEvidence("800x360-agenda-offline-cached"),
    });

    // Auth required state when empty.
    data.calendar.state = "connected";
    data.calendar.stale = false;
    data.calendar.ageMs = 0;
    data.calendar.errorCode = null;
    data.calendar.data!.state = "auth_required";
    data.calendar.data!.errorCode = "CALENDAR_AUTH_REQUIRED";
    data.calendar.data!.items = [];
    data.calendar.data!.nextEvent = null;
    await setBridgeSlot(page, "calendar", data.calendar);
    await page.getByRole("button", { name: "Refresh agenda" }).click();
    await expect(
      page.getByRole("heading", { name: "Google authorization required" }),
    ).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: calendarEvidence("800x360-agenda-auth-required"),
    });

    // Capacity state.
    data.calendar.data!.state = "capacity";
    data.calendar.data!.errorCode = "CALENDAR_CAPACITY";
    await setBridgeSlot(page, "calendar", data.calendar);
    await page.getByRole("button", { name: "Refresh agenda" }).click();
    await expect(
      page.getByText(/Range exceeds calendar capacity limits/),
    ).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: calendarEvidence("800x360-agenda-capacity"),
    });

    // Old-hub CALENDAR_UNSUPPORTED leaves other tabs working.
    await setBridgeSlot(page, "calendarError", "CALENDAR_UNSUPPORTED");
    await page.getByRole("button", { name: "Refresh agenda" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Calendar unavailable on this hub version",
      }),
    ).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: calendarEvidence("800x360-agenda-unsupported"),
    });
    await page.getByRole("button", { name: "Open menu / status" }).click();
    await page.getByRole("tab", { name: "Monitor", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Claude" })).toBeVisible();
  });
});
