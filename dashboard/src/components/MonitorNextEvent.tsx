import { useId, useSyncExternalStore } from "react";
import type { CalendarStore } from "../calendar/store.js";
import { addDays, dateInZone, formatShortDate, formatTimeInZone, nextSummary } from "../calendar/time.js";
import { ColorDot } from "./AgendaView.js";

export interface MonitorNextEventProps {
  store: CalendarStore;
  laptopConnected: boolean;
  unpaired?: boolean;
  onOpenAgenda: () => void;
}

/** One whole-range server summary; never derive the next event from a paged list. */
export function MonitorNextEvent({ store, laptopConnected, unpaired = false, onOpenAgenda }: MonitorNextEventProps) {
  const descriptionId = useId();
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const { page, range, nowEpochMs } = snapshot;
  const state = page?.state;
  const authRequired = unpaired || snapshot.errorCode === "AUTH_REQUIRED" || state === "auth_required";
  const eligibleState = !authRequired && (state === "available" || state === "partial");
  const candidate = eligibleState ? page?.nextEvent : null;
  const summary = nextSummary(candidate, nowEpochMs, range.timeZone);
  const event = summary !== null ? candidate : null;
  const offline = !laptopConnected || snapshot.offline;
  const notice = [offline ? "Offline" : snapshot.stale ? "Stale" : null, state === "partial" ? "Partial" : null].filter(Boolean).join(" · ");
  let empty = "Loading calendar…";
  if (unpaired || snapshot.errorCode === "AUTH_REQUIRED") empty = "Pair laptop to see calendar";
  else if (authRequired) empty = "Reconnect Google Calendar";
  else if (state === "disabled") empty = "Connect Google Calendar";
  else if (state === "setup_required") empty = "Choose calendars in Agenda";
  else if (snapshot.errorCode === "CALENDAR_UNSUPPORTED" && state !== "partial") empty = "Update desktop for Calendar";
  else if (state === "capacity") empty = "Calendar capacity reached";
  else if (offline) empty = "Connect laptop for calendar";
  else if (state === "error") empty = "Calendar unavailable";
  else if (state === "partial") empty = "Some calendars unavailable";
  else if (snapshot.stale) empty = "Stale calendar · check Agenda";
  else if (state === "available") empty = "No upcoming timed events in the next 7 days";

  let when = "";
  if (event?.start.kind === "time" && event.end.kind === "time") {
    const today = dateInZone(nowEpochMs, range.timeZone);
    const eventDate = dateInZone(event.start.epochMs, range.timeZone);
    const day = eventDate === today ? "" : eventDate === addDays(today, 1) ? "Tomorrow · " : `${formatShortDate(eventDate)} · `;
    when = event.start.epochMs <= nowEpochMs ? summary! : `${day}${formatTimeInZone(event.start.epochMs, range.timeZone)}`;
    when += ` ${range.timeZone}`;
  }
  return (
    <button type="button" className="monitor-next" aria-label="Next up, open Agenda" aria-describedby={descriptionId} onClick={onOpenAgenda}>
      <span className="monitor-next-heading">Next up</span>
      <span className="monitor-next-description" id={descriptionId}>{event ? `${event.title}. ${when}. ${event.label?.name ?? (event.label ? "Labelled" : "")}. ${event.calendarName}. ${notice}` : `${empty}. ${notice}`}</span>
      <strong className="monitor-next-title">{event?.title ?? empty}</strong>
      <span className="monitor-next-link">Agenda <span aria-hidden="true">›</span></span>
      {event ? <span className="monitor-next-meta">
        <span className="monitor-next-time">{when}</span>
        {event.label && <span className="agenda-label-badge"><ColorDot color={event.label.color} />{event.label.name ?? "Labelled"}</span>}
        <span className="agenda-source-badge"><ColorDot color={event.calendarColor} /><span className="monitor-next-source-name">{event.calendarName}</span></span>
        {notice && <span className="monitor-next-notice">{notice}</span>}
      </span> : notice && <span className="monitor-next-meta monitor-next-notice">{notice}</span>}
    </button>
  );
}
