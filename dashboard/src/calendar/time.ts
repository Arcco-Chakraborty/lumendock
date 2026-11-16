import type { CalendarEvent, CalendarSource } from "@phone-monitor/protocol";

export function defaultTimeZone(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved && !/^[+-]/.test(resolved) && resolved.length <= 80) {
      new Intl.DateTimeFormat("en", { timeZone: resolved });
      return resolved;
    }
  } catch {
    // Fall back to UTC if the runtime zone is missing or invalid.
  }
  return "UTC";
}

function parseYmd(dateStr: string): [number, number, number] {
  return [
    Number(dateStr.slice(0, 4)),
    Number(dateStr.slice(5, 7)),
    Number(dateStr.slice(8, 10)),
  ];
}

export function addDays(dateStr: string, deltaDays: number): string {
  const [year, month, day] = parseYmd(dateStr);
  const utc = new Date(Date.UTC(year, month - 1, day + deltaDays));
  const y = String(utc.getUTCFullYear()).padStart(4, "0");
  const m = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function dateInZone(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function formatTimeInZone(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(epochMs));
}

export function formatTimePartsInZone(
  epochMs: number,
  timeZone: string,
): { main: string; ampm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(epochMs));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "12";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const dayPeriod = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  return { main: `${hour}:${minute}`, ampm: dayPeriod };
}

export function eventDates(event: CalendarEvent, timeZone: string): string[] {
  if (event.start.kind === "date" && event.end.kind === "date") {
    const last = addDays(event.end.date, -1);
    return last <= event.start.date ? [event.start.date] : [event.start.date, last];
  }
  if (event.start.kind === "time" && event.end.kind === "time") {
    const first = dateInZone(event.start.epochMs, timeZone);
    const lastInstant = Math.max(event.start.epochMs, event.end.epochMs - 1);
    const last = dateInZone(lastInstant, timeZone);
    return last <= first ? [first] : [first, last];
  }
  return [];
}

export function eventSpanDays(
  event: CalendarEvent,
  rangeStartDate: string,
  rangeDays: number,
  timeZone: string,
): string[] {
  const endpoints = eventDates(event, timeZone);
  if (endpoints.length === 0) return [rangeStartDate];
  const first = endpoints[0]!;
  const last = endpoints[endpoints.length - 1]!;
  const rangeEnd = addDays(rangeStartDate, Math.max(0, rangeDays - 1));
  const start = first < rangeStartDate ? rangeStartDate : first;
  const end = last > rangeEnd ? rangeEnd : last;
  if (start > end) return [first];
  const days: string[] = [];
  let cursor = start;
  for (let i = 0; i < 31 && cursor <= end; i += 1) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days.length > 0 ? days : [first];
}

export function isToday(
  event: CalendarEvent,
  todayDate: string,
  timeZone: string,
): boolean {
  const dates = eventDates(event, timeZone);
  if (dates.length === 0) return false;
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;
  return first <= todayDate && todayDate <= last;
}

export function eventTime(event: CalendarEvent, timeZone: string): string {
  if (event.start.kind === "date") return "All day";
  if (event.start.kind === "time" && event.end.kind === "time") {
    return `${formatTimeInZone(event.start.epochMs, timeZone)} to ${formatTimeInZone(event.end.epochMs, timeZone)}`;
  }
  return "";
}

export function eventRowTime(
  event: CalendarEvent,
  timeZone: string,
): { primary: string; secondary: string | null } {
  if (event.start.kind === "date" && event.end.kind === "date") {
    const dates = eventDates(event, timeZone);
    if (dates.length > 1) {
      return {
        primary: "All day",
        secondary: `${formatShortDate(dates[0]!)} to ${formatShortDate(dates[1]!)}`,
      };
    }
    return { primary: "All day", secondary: null };
  }
  if (event.start.kind === "time" && event.end.kind === "time") {
    return {
      primary: formatTimeInZone(event.start.epochMs, timeZone),
      secondary: formatTimeInZone(event.end.epochMs, timeZone),
    };
  }
  return { primary: "", secondary: null };
}

export function formatShortDate(dateStr: string): string {
  const [year, month, day] = parseYmd(dateStr);
  const utc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(utc);
}

export function formatDayHeading(dateStr: string, todayDate: string): string {
  const [year, month, day] = parseYmd(dateStr);
  const utc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(utc);
  if (dateStr === todayDate) return `Today · ${formatted}`;
  if (dateStr === addDays(todayDate, 1)) return `Tomorrow · ${formatted}`;
  return formatted;
}

export function formatRangeHeading(startDate: string, days: number): string {
  const first = formatShortDate(startDate);
  if (days <= 1) return first;
  const end = formatShortDate(addDays(startDate, days - 1));
  return `${first} to ${end}`;
}

export function eventDetailWhen(
  event: CalendarEvent,
  timeZone: string,
): string {
  const dates = eventDates(event, timeZone);
  const datePart =
    dates.length > 1
      ? `${formatShortDate(dates[0]!)} to ${formatShortDate(dates[1]!)}`
      : dates.length === 1
        ? formatShortDate(dates[0]!)
        : "";
  if (event.start.kind === "date") {
    return `${datePart} · All day`;
  }
  if (event.start.kind === "time" && event.end.kind === "time") {
    const sourceZone =
      event.start.timeZone !== timeZone
        ? ` (source: ${event.start.timeZone})`
        : "";
    return `${datePart} · ${eventTime(event, timeZone)} · ${timeZone}${sourceZone}`;
  }
  return datePart;
}

export function nextSummary(
  event: CalendarEvent | null | undefined,
  nowEpochMs: number,
  timeZone: string,
): string | null {
  if (!event || event.start.kind !== "time" || event.end.kind !== "time") {
    return null;
  }
  if (event.selfResponseStatus === "declined") {
    return null;
  }
  if (event.end.epochMs <= nowEpochMs) {
    return null;
  }
  if (event.start.epochMs <= nowEpochMs) {
    return `Now · until ${formatTimeInZone(event.end.epochMs, timeZone)}`;
  }
  return `Starts ${formatTimeInZone(event.start.epochMs, timeZone)} · until ${formatTimeInZone(event.end.epochMs, timeZone)}`;
}

export function formatReminder(minutes: number | null): string {
  if (minutes === null) return "No reminder";
  if (minutes === 0) return "Reminder at start";
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `Reminder ${days} ${days === 1 ? "day" : "days"} before`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `Reminder ${hours} ${hours === 1 ? "hr" : "hrs"} before`;
  }
  return `Reminder ${minutes} min before`;
}

export function sourceDisplayName(
  source: CalendarSource,
  allSources: readonly CalendarSource[],
): string {
  const duplicates = allSources.filter((item) => item.name === source.name);
  if (duplicates.length <= 1) return source.name;
  const suffix = source.sourceId.slice(-6);
  return `${source.name} (${suffix})`;
}
