import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CalendarEvent, CalendarSource } from "@phone-monitor/protocol";
import { elapsedLabel } from "../lib/time.js";
import type { CalendarStore } from "../calendar/store.js";
import {
  addDays,
  dateInZone,
  eventDetailWhen,
  eventRowTime,
  eventSpanDays,
  eventTime,
  formatDayHeading,
  formatRangeHeading,
  formatReminder,
  formatTimeInZone,
  formatTimePartsInZone,
  isToday,
  nextSummary,
  sourceDisplayName,
} from "../calendar/time.js";

export interface AgendaViewProps {
  store: CalendarStore;
  laptopConnected: boolean;
  unpaired?: boolean;
}

const RANGE_DAY_OPTIONS = [1, 3, 7, 14, 31] as const;
const CLI_CONNECT_COMMAND =
  "node desktop/dist/main.js calendar connect --client <path-to-client-secret.json>";

export function ColorDot({
  color,
  className = "agenda-color-dot",
}: {
  color: string | null;
  className?: string;
}) {
  if (!color) return null;
  return (
    <svg
      className={className}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
    >
      <circle cx="5" cy="5" r="4" fill={color} />
    </svg>
  );
}

function responseLabel(
  event: CalendarEvent,
): { text: string; declined: boolean } | null {
  if (event.selfResponseStatus === "declined") {
    return { text: "Declined", declined: true };
  }
  if (event.selfResponseStatus === "needsAction") {
    return { text: "Needs reply", declined: false };
  }
  if (
    event.selfResponseStatus === "tentative" ||
    event.status === "tentative"
  ) {
    return { text: "Tentative", declined: false };
  }
  return null;
}

function detailStatusText(event: CalendarEvent): string {
  const status = event.status === "tentative" ? "Tentative" : "Confirmed";
  if (!event.selfResponseStatus) return status;
  const response =
    event.selfResponseStatus === "declined"
      ? "Declined by you"
      : event.selfResponseStatus === "needsAction"
        ? "Needs your response"
        : event.selfResponseStatus === "tentative"
          ? "Tentatively accepted"
          : "Accepted";
  return `${status} · ${response}`;
}

function sourceCapabilityText(source: CalendarSource): string {
  if (source.capability === "busy") {
    return "Free/busy only · event titles unavailable";
  }
  if (source.capability === "unavailable") {
    return "Unavailable · cannot read calendar";
  }
  if (
    source.state === "partial" &&
    source.errorCode === "CALENDAR_UNSUPPORTED"
  ) {
    return "Readable · labels unavailable";
  }
  if (source.state === "error" || source.errorCode) {
    return `Sync failed (${source.errorCode ?? "error"})`;
  }
  return "Readable · events";
}

export function AgendaView({
  store,
  laptopConnected,
  unpaired = false,
}: AgendaViewProps) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  const { range, page, items, sources } = snapshot;
  const state = page?.state ?? snapshot.sourcesState ?? "loading";
  const errorCode = snapshot.errorCode ?? page?.errorCode ?? null;
  const hubUnsupported =
    errorCode === "CALENDAR_UNSUPPORTED" && (!page || page.state === "error");
  const labelFallback =
    (page?.state === "partial" && page.errorCode === "CALENDAR_UNSUPPORTED") ||
    sources.some(
      (source) =>
        source.state === "partial" &&
        source.errorCode === "CALENDAR_UNSUPPORTED",
    );
  const todayDate = dateInZone(snapshot.nowEpochMs, range.timeZone);

  const [period, setPeriod] = useState<"upcoming" | "today">("upcoming");
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [modalKind, setModalKind] = useState<"detail" | "sources" | "guide" | null>(
    null,
  );
  const [draftSelected, setDraftSelected] = useState<string[] | null>(null);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const setupEnumeratedRef = useRef(false);

  const isSelectedEventValid =
    selectedEvent !== null &&
    state !== "disabled" &&
    state !== "setup_required" &&
    !hubUnsupported &&
    snapshot.errorCode !== "AUTH_REQUIRED" &&
    (sources.length === 0 ||
      sources.some(
        (source) =>
          source.sourceId === selectedEvent.sourceId && source.selected,
      )) &&
    (snapshot.offline ||
      page === null ||
      page.state === "loading" ||
      items.some(
        (item) =>
          item.id === selectedEvent.id &&
          item.sourceId === selectedEvent.sourceId,
      ) ||
      (page.nextEvent?.id === selectedEvent.id &&
        page.nextEvent?.sourceId === selectedEvent.sourceId));
  const validSelectedEvent = isSelectedEventValid ? selectedEvent : null;

  useEffect(() => {
    if (selectedEvent && !isSelectedEventValid) {
      setSelectedEvent(null);
      if (modalKind === "detail") {
        setModalKind(null);
      }
    }
  }, [isSelectedEventValid, modalKind, selectedEvent]);

  useEffect(() => {
    if (state === "setup_required") {
      if (!setupEnumeratedRef.current) {
        setupEnumeratedRef.current = true;
        void store.loadSources();
      }
    } else {
      setupEnumeratedRef.current = false;
    }
  }, [state, store]);

  useEffect(() => {
    if (modalKind) {
      if (dialogRef.current && !dialogRef.current.open) {
        dialogRef.current.showModal();
        dialogRef.current.querySelector<HTMLButtonElement>(".agenda-sheet-close")?.focus();
      }
    } else if (dialogRef.current?.open) {
      dialogRef.current.close();
      openerRef.current?.focus();
    }
  }, [modalKind]);

  const effectiveSelectedIds =
    draftSelected ??
    sources
      .filter((source) =>
        state === "setup_required"
          ? source.capability === "read"
          : source.selected,
      )
      .map((source) => source.sourceId);

  const toggleDraftSource = (sourceId: string, checked: boolean) => {
    const current = new Set(effectiveSelectedIds);
    if (checked) current.add(sourceId);
    else current.delete(sourceId);
    setDraftSelected([...current]);
  };

  const applySourceSelection = async () => {
    const ids = effectiveSelectedIds;
    const ok = await store.selectSources(ids);
    if (ok) {
      setDraftSelected(null);
      if (modalKind === "sources") {
        setModalKind(null);
      }
      return;
    }
    const reconciled = store.snapshot();
    const reconciledState =
      reconciled.page?.state ?? reconciled.sourcesState ?? "loading";
    setDraftSelected(
      reconciled.sources
        .filter((source) =>
          reconciledState === "setup_required"
            ? source.capability === "read"
            : source.selected,
        )
        .map((source) => source.sourceId),
    );
  };

  const openSourcesModal = (opener: HTMLElement | null) => {
    openerRef.current = opener;
    setDraftSelected(null);
    setModalKind("sources");
    void store.loadSources();
  };

  const openGuideModal = (opener: HTMLElement | null) => {
    openerRef.current = opener;
    setModalKind("guide");
  };

  const openEventDetail = (event: CalendarEvent, opener: HTMLElement | null) => {
    openerRef.current = opener;
    setSelectedEvent(event);
    setModalKind("detail");
  };

  const closeModal = () => {
    setModalKind(null);
    setSelectedEvent(null);
  };

  const shiftDates = (deltaDays: number) => {
    setPeriod("upcoming");
    store.setRange({
      startDate: addDays(range.startDate, deltaDays),
      days: range.days,
      timeZone: range.timeZone,
    });
  };

  const selectToday = () => {
    setPeriod("today");
    store.setToday();
  };

  const syncStatusText = (() => {
    if (hubUnsupported) return "Hub update required";
    if (unpaired) return "Laptop not paired";
    const age =
      snapshot.lastSuccessAtEpochMs !== null
        ? elapsedLabel(snapshot.lastSuccessAtEpochMs, snapshot.nowEpochMs)
        : null;
    if (snapshot.offline || !laptopConnected) {
      return age ? `Offline · last sync ${age}` : "Offline · cached view";
    }
    if (state === "partial" || (page && page.failedSourceCount > 0)) {
      return age ? `Partial sync · ${age}` : "Partial sync";
    }
    if (snapshot.stale && age) {
      return `Stale · ${age}`;
    }
    if (snapshot.loading) {
      return "Syncing...";
    }
    if (age) {
      return `Synced ${age}`;
    }
    return "Ready";
  })();

  const nextEvent = page?.nextEvent ?? null;
  const nextEventSummary = nextSummary(
    nextEvent,
    snapshot.nowEpochMs,
    range.timeZone,
  );
  const eligibleNext = nextEventSummary !== null ? nextEvent : null;

  const visibleItems =
    period === "today"
      ? items.filter((item) => isToday(item, todayDate, range.timeZone))
      : items;

  const groupedDays = (() => {
    const groups = new Map<string, CalendarEvent[]>();
    for (const item of visibleItems) {
      const dayKey =
        period === "today"
          ? todayDate
          : (eventSpanDays(item, range.startDate, range.days, range.timeZone)[0] ??
            range.startDate);
      const list = groups.get(dayKey) ?? [];
      list.push(item);
      groups.set(dayKey, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  })();

  const renderSourceReview = (inline: boolean) => {
    const overCapacity =
      snapshot.sourcesState === "capacity" ||
      snapshot.sourcesErrorCode === "CALENDAR_CAPACITY" ||
      errorCode === "CALENDAR_CAPACITY" ||
      sources.length > 100;
    return (
      <section
        className={inline ? "agenda-state-card" : "agenda-sources-sheet"}
        aria-label="Calendar sources"
      >
        {inline && (
          <>
            <h3>Choose calendars to import</h3>
            <p className="muted">
              Review connected Google calendars and apply your selection before
              events are loaded onto this display.
            </p>
          </>
        )}
        {overCapacity && (
          <p className="warning" role="status">
            Calendar source capacity reached (maximum 100 sources). Deselect
            unused calendars to stay within capacity.
          </p>
        )}
        {snapshot.sourcesErrorCode &&
          snapshot.sourcesErrorCode !== "CALENDAR_CAPACITY" && (
            <p className="warning" role="status">
              Source list notice: {snapshot.sourcesErrorCode}
            </p>
          )}
        {snapshot.loadingSources && sources.length === 0 ? (
          <p className="muted">Loading calendar sources from laptop...</p>
        ) : sources.length === 0 ? (
          <p className="muted">
            No calendars enumerated yet. Refresh sources or check the laptop
            connection.
          </p>
        ) : (
          <div className="agenda-source-list" role="group" aria-label="Calendars">
            {sources.map((source) => {
              const displayName = sourceDisplayName(source, sources);
              const readable = source.capability === "read";
              const checked =
                readable && effectiveSelectedIds.includes(source.sourceId);
              return (
                <label
                  key={source.sourceId}
                  className={`agenda-source-row${readable ? "" : " is-disabled"}`}
                >
                  <span className="agenda-source-info">
                    <span className="agenda-source-title">
                      <ColorDot color={source.color} />
                      <span>{displayName}</span>
                    </span>
                    <span className="agenda-source-capability muted">
                      {sourceCapabilityText(source)}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    aria-label={displayName}
                    checked={checked}
                    disabled={!readable || snapshot.selecting}
                    onChange={(e) =>
                      toggleDraftSource(source.sourceId, e.target.checked)
                    }
                  />
                </label>
              );
            })}
          </div>
        )}
        <div className="agenda-state-actions">
          <button
            type="button"
            className="agenda-primary-button"
            disabled={snapshot.selecting || snapshot.loadingSources}
            onClick={() => void applySourceSelection()}
          >
            {snapshot.selecting ? "Applying..." : "Apply calendars"}
          </button>
          <button
            type="button"
            disabled={snapshot.loadingSources}
            onClick={() => void store.loadSources()}
          >
            Reload sources
          </button>
        </div>
      </section>
    );
  };

  return (
    <div
      className="agenda-container"
      id="agenda-panel" tabIndex={-1}
      role="tabpanel"
      aria-labelledby="agenda-tab"
    >
      <header className="agenda-toolbar">
        <div className="agenda-heading">
          <h2>Agenda</h2>
          <p className="agenda-subtitle">
            <span>{formatRangeHeading(range.startDate, range.days)}</span>
            <span aria-hidden="true"> · </span>
            <span>{range.timeZone}</span>
            <span aria-hidden="true"> · </span>
            <span className={snapshot.stale ? "warning" : "muted"}>
              {syncStatusText}
            </span>
          </p>
        </div>
        <div className="agenda-controls" role="group" aria-label="Agenda controls">
          <button
            type="button"
            className={`agenda-pill${period === "today" ? " is-active" : ""}`}
            aria-pressed={period === "today"}
            onClick={selectToday}
          >
            Today
          </button>
          <button
            type="button"
            className={`agenda-pill${period === "upcoming" ? " is-active" : ""}`}
            aria-pressed={period === "upcoming"}
            onClick={() => setPeriod("upcoming")}
          >
            Upcoming
          </button>
          <button
            type="button"
            aria-label="Earlier dates"
            onClick={() => shiftDates(-range.days)}
          >
            Prev
          </button>
          <button
            type="button"
            aria-label="Later dates"
            onClick={() => shiftDates(range.days)}
          >
            Next
          </button>
          <select
            aria-label="Range length"
            className="agenda-range-select"
            value={range.days}
            onChange={(e) => {
              setPeriod("upcoming");
              store.setRange({
                startDate: range.startDate,
                days: Number(e.target.value),
                timeZone: range.timeZone,
              });
            }}
          >
            {RANGE_DAY_OPTIONS.map((days) => (
              <option key={days} value={days}>
                {days === 1 ? "1 day" : `${days} days`}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label="Choose calendars"
            onClick={(e) => openSourcesModal(e.currentTarget)}
          >
            Calendars
          </button>
          <button
            type="button"
            aria-label="Refresh agenda"
            disabled={snapshot.loading}
            onClick={() => void store.refresh()}
          >
            Refresh
          </button>
        </div>
      </header>

      {labelFallback && (
        <p className="agenda-banner warning" role="status">
          Partial sync: event label metadata is unavailable for some calendars.
          Events and source calendars are still shown.
        </p>
      )}

      {((state === "partial" && !labelFallback) ||
        (page &&
          page.failedSourceCount > 0 &&
          errorCode !== "CALENDAR_UNSUPPORTED")) && (
        <p className="agenda-banner warning" role="status">
          Partial sync: {page?.failedSourceCount ?? 1} of{" "}
          {page?.sourceCount ?? sources.length} calendar source(s) failed to
          update. Showing last complete data for failed calendars.
        </p>
      )}

      {(state === "capacity" || errorCode === "CALENDAR_CAPACITY") && (
        <p className="agenda-banner warning" role="status">
          Range exceeds calendar capacity limits. Narrow the date range or
          deselect busy calendars.
        </p>
      )}

      {hubUnsupported ? (
        <section className="agenda-state-card" role="status" aria-label="Calendar unsupported">
          <h3>Calendar unavailable on this hub version</h3>
          <p className="muted">
            Update the LumenDock desktop hub on the laptop to use Agenda.
            Monitor, Deck and Laptop remain available.
          </p>
        </section>
      ) : state === "disabled" ? (
        <section className="agenda-state-card" role="status" aria-label="Calendar setup">
          <h3>Connect Google Calendar on the laptop</h3>
          <p className="muted">
            Agenda uses a read-only Google Calendar connection on your laptop
            and sends normalized events over USB. Run this command on the
            laptop:
          </p>
          <code className="agenda-cli-code">{CLI_CONNECT_COMMAND}</code>
          <div className="agenda-state-actions">
            <button
              type="button"
              onClick={(e) => openGuideModal(e.currentTarget)}
            >
              Setup guide
            </button>
            <button
              type="button"
              disabled={snapshot.loading}
              onClick={() => void store.refresh()}
            >
              Check connection
            </button>
          </div>
        </section>
      ) : state === "setup_required" ? (
        renderSourceReview(true)
      ) : state === "auth_required" && items.length === 0 ? (
        <section className="agenda-state-card" role="status" aria-label="Calendar authorization">
          <h3>Google authorization required</h3>
          <p className="muted">
            The laptop&apos;s Google Calendar authorization expired or was
            revoked. Reconnect on the laptop:
          </p>
          <code className="agenda-cli-code">{CLI_CONNECT_COMMAND}</code>
          <div className="agenda-state-actions">
            <button
              type="button"
              onClick={(e) => openGuideModal(e.currentTarget)}
            >
              Setup guide
            </button>
            <button
              type="button"
              disabled={snapshot.loading}
              onClick={() => void store.refresh()}
            >
              Retry sync
            </button>
          </div>
        </section>
      ) : (
        <div className="agenda-content">
          <aside className="agenda-next" aria-label="Next up">
            <div className="agenda-next-header">
              <div className="agenda-next-header-left">
                <span className="muted">Next up</span>
                {eligibleNext &&
                  eligibleNext.start.kind === "time" && (
                    <span className="agenda-next-status">
                      {eligibleNext.start.epochMs <= snapshot.nowEpochMs
                        ? "In progress"
                        : "Upcoming"}
                    </span>
                  )}
              </div>
              {eligibleNext && (
                <button
                  type="button"
                  className="text-button agenda-next-details"
                  aria-label={`Details for ${eligibleNext.title}`}
                  onClick={(e) => openEventDetail(eligibleNext, e.currentTarget)}
                >
                  Details
                </button>
              )}
            </div>
            {eligibleNext &&
            eligibleNext.start.kind === "time" &&
            eligibleNext.end.kind === "time" ? (
              <>
                {(() => {
                  const startEpoch = eligibleNext.start.epochMs;
                  const endEpoch = eligibleNext.end.epochMs;
                  const ongoing = startEpoch <= snapshot.nowEpochMs;
                  const parts = formatTimePartsInZone(
                    startEpoch,
                    range.timeZone,
                  );
                  return (
                    <div className="agenda-big-time">
                      {ongoing ? (
                        <>
                          Now
                          <span>
                            until{" "}
                            {formatTimeInZone(
                              endEpoch,
                              range.timeZone,
                            )}
                          </span>
                        </>
                      ) : (
                        <>
                          {parts.main}
                          <span>{parts.ampm}</span>
                        </>
                      )}
                    </div>
                  );
                })()}
                <h3 className="agenda-next-title">{eligibleNext.title}</h3>
                <p className="agenda-next-range muted">
                  {eventTime(eligibleNext, range.timeZone)}
                </p>
                <div className="agenda-badges">
                  <span className="agenda-source-badge">
                    <ColorDot color={eligibleNext.calendarColor} />
                    <span>{eligibleNext.calendarName}</span>
                  </span>
                  {eligibleNext.label && (
                    <span className="agenda-label-badge">
                      <ColorDot color={eligibleNext.label.color} />
                      <span>{eligibleNext.label.name ?? "Labelled"}</span>
                    </span>
                  )}
                  {eligibleNext.reminderMinutes !== null && (
                    <span className="agenda-next-reminder muted">
                      {formatReminder(eligibleNext.reminderMinutes)}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <p className="agenda-next-empty muted">
                No upcoming timed event in this range.
              </p>
            )}
          </aside>

          <section className="agenda-list-panel" aria-label="Scheduled events">
            {state === "auth_required" && (
              <p className="agenda-banner warning" role="status">
                Google authorization expired. Showing cached session events;
                reconnect on the laptop to update.
              </p>
            )}
            {groupedDays.length === 0 ? (
              <div className="agenda-empty" role="status">
                {snapshot.loading || state === "loading" ? (
                  <p className="muted">Loading calendar events from laptop...</p>
                ) : state === "error" ? (
                  <p className="muted">
                    Calendar sync failed ({errorCode ?? "unavailable"}). Try
                    refreshing or check the laptop connection.
                  </p>
                ) : period === "today" ? (
                  <p className="muted">No events scheduled for today.</p>
                ) : (
                  <p className="muted">No events in this date range.</p>
                )}
              </div>
            ) : (
              <div className="agenda-groups">
                {groupedDays.map(([dayKey, dayEvents]) => (
                  <div key={dayKey} className="agenda-day-group">
                    <div className="agenda-day-heading">
                      <span>{formatDayHeading(dayKey, todayDate)}</span>
                      <span>{range.timeZone}</span>
                    </div>
                    {dayEvents.map((item) => {
                      const rowTime = eventRowTime(item, range.timeZone);
                      const resp = responseLabel(item);
                      const isNext = eligibleNext?.id === item.id && eligibleNext?.sourceId === item.sourceId;
                      return (
                        <button
                          key={`${item.sourceId}:${item.id}:${dayKey}`}
                          type="button"
                          className={`agenda-event${isNext ? " is-next" : ""}${resp?.declined ? " is-declined" : ""}`}
                          onClick={(e) => openEventDetail(item, e.currentTarget)}
                        >
                          <span className="agenda-event-time">
                            <span>{rowTime.primary}</span>
                            {rowTime.secondary && (
                              <small>{rowTime.secondary}</small>
                            )}
                          </span>
                          <span className="agenda-event-main">
                            <span className="agenda-event-title">
                              {item.title}
                            </span>
                            <span className="agenda-badges">
                              <span className="agenda-source-badge">
                                <ColorDot color={item.calendarColor} />
                                <span>{item.calendarName}</span>
                              </span>
                              {item.label && (
                                <span className="agenda-label-badge">
                                  <ColorDot color={item.label.color} />
                                  <span>{item.label.name ?? "Labelled"}</span>
                                </span>
                              )}
                              {resp && (
                                <span
                                  className={`agenda-status-badge${resp.declined ? " is-declined" : ""}`}
                                >
                                  {resp.text}
                                </span>
                              )}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
                {snapshot.nextCursor && (
                  <div className="agenda-more-row">
                    <button
                      type="button"
                      disabled={snapshot.loadingMore}
                      onClick={() => void store.loadMore()}
                    >
                      {snapshot.loadingMore ? "Loading more..." : "Load more"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      <dialog
        ref={dialogRef}
        aria-labelledby="agenda-sheet-title"
        className="sheet agenda-sheet"
        onCancel={closeModal}
        onClose={() => {
          if (!dialogRef.current?.open) {
            setModalKind(null);
            setSelectedEvent(null);
          }
        }}
      >
        <div className="sheet-header">
          <span id="agenda-sheet-title">
            {modalKind === "detail"
              ? validSelectedEvent?.title ?? "Event details"
              : modalKind === "sources"
                ? "Included calendars"
                : "Laptop calendar setup"}
          </span>
          <button
            type="button"
            className="agenda-sheet-close"
            aria-label="Close calendar sheet"
            onClick={closeModal}
          >
            Close
          </button>
        </div>
        {modalKind === "detail" && validSelectedEvent ? (
          <dl className="agenda-detail-list">
            <div>
              <dt>When</dt>
              <dd>{eventDetailWhen(validSelectedEvent, range.timeZone)}</dd>
            </div>
            <div>
              <dt>Calendar</dt>
              <dd>
                <span className="agenda-source-badge">
                  <ColorDot color={validSelectedEvent.calendarColor} />
                  <span>{validSelectedEvent.calendarName}</span>
                </span>
              </dd>
            </div>
            <div>
              <dt>Label</dt>
              <dd>
                {validSelectedEvent.label ? (
                  <span className="agenda-label-badge">
                    <ColorDot color={validSelectedEvent.label.color} />
                    <span>{validSelectedEvent.label.name ?? "Labelled"}</span>
                  </span>
                ) : (
                  "None"
                )}
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{detailStatusText(validSelectedEvent)}</dd>
            </div>
            <div>
              <dt>Reminder</dt>
              <dd>{formatReminder(validSelectedEvent.reminderMinutes)}</dd>
            </div>
          </dl>
        ) : modalKind === "sources" ? (
          renderSourceReview(false)
        ) : modalKind === "guide" ? (
          <div className="agenda-guide">
            <p>
              LumenDock connects to Google Calendar on your laptop so the phone
              can stay connected to the room controller over Wi-Fi without
              internet access.
            </p>
            <p className="muted">
              1. Create a Desktop OAuth client in your Google Cloud project with
              the Google Calendar API enabled.
            </p>
            <p className="muted">
              2. On the laptop, connect your account using the CLI:
            </p>
            <code className="agenda-cli-code">{CLI_CONNECT_COMMAND}</code>
            <p className="muted">
              3. Return to Agenda on this display to review and apply which
              calendars to import. Access is strictly read-only. External OAuth
              projects in Testing expire after 7 days and require reconnecting
              on the laptop.
            </p>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
