import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { DeviceAdapter } from "./device.js";
import type { DashboardStore, DashboardSnapshot } from "./store.js";
import { UsageCard } from "./components/UsageCard.js";
import { ClimateCard } from "./components/ClimateCard.js";
import { LightCard } from "./components/LightCard.js";
import { NotificationStrip } from "./components/NotificationStrip.js";
import { SettingsSheet } from "./components/SettingsSheet.js";
import { DeckView } from "./components/DeckView.js";
import { LightIntentController } from "./lib/lightIntent.js";
import { LampSignaller, SignalDetector, inQuietHours, loadSignalPrefs, saveSignalPrefs, type SignalPrefs } from "./lib/lampSignals.js";

export interface AppProps {
  store: DashboardStore;
  nativeAvailable: boolean;
  adapter?: DeviceAdapter;
  demo?: boolean;
  usageSlot?: ReactNode;
  climateSlot?: ReactNode;
  lightingSlot?: ReactNode;
  notificationSlot?: ReactNode;
  settingsSlot?: ReactNode;
}
function LinkStatus({
  name,
  link,
  unpaired = false,
}: {
  name: string;
  link: DashboardSnapshot["hub"] | DashboardSnapshot["esp"];
  unpaired?: boolean;
}) {
  const connected = link.state === "connected" && !link.stale && !unpaired;
  const label = unpaired
    ? "not paired"
    : link.state === "connecting"
      ? "connecting"
      : connected
        ? "connected"
        : link.state === "connected"
          ? "stale"
          : "disconnected";
  return (
    <span
      className={`link-status ${connected ? "is-connected" : "is-offline"}`}
    >
      <span className="lamp" aria-hidden="true" /> {name} {label}
    </span>
  );
}
export function App({
  store,
  nativeAvailable,
  adapter,
  demo = false,
  usageSlot,
  climateSlot,
  lightingSlot,
  notificationSlot,
  settingsSlot,
}: AppProps) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  // Native reports a missing/revoked laptop token as AUTH_REQUIRED and stops polling until pairing.
  const unpaired =
    snapshot.hub.errorCode === "AUTH_REQUIRED" || snapshot.app?.paired === false;
  const [pairStarting, setPairBusy] = useState(false);
  const pairBusy = pairStarting || snapshot.app?.setup.hub.state === "in_progress";
  const [dismissed, setDismissed] = useState<string[]>([]);
  const dismiss = (id: string) =>
    setDismissed((previous) => [...previous.slice(-99), id]);
  const [sheet, setSheet] = useState<
    | "settings"
    | "notifications"
    | "lights"
    | "claude"
    | "codex"
    | "history"
    | null
  >(null);
  const [view, setView] = useState<"monitor" | "deck">("monitor");
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [dockOpen, setDockOpen] = useState(true);
  const dockRef = useRef<HTMLElement>(null);
  const dockPointerInside = useRef(false);
  const focusHandle = useRef(false);
  const focusDock = useRef(false);
  const autoDropTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetAutoDropTimer = useCallback(() => {
    if (autoDropTimerRef.current) clearTimeout(autoDropTimerRef.current);
    autoDropTimerRef.current = setTimeout(() => {
      // Keyboard focus and modal return targets remain available. A completed
      // touch interaction may time out, transferring its focus to the handle.
      const dockHasFocus = dockRef.current?.contains(document.activeElement);
      if (dockPointerInside.current || (dockHasFocus && document.activeElement?.matches(":focus-visible")) || document.querySelector("dialog[open]")) {
        resetAutoDropTimer();
        return;
      }
      focusHandle.current = Boolean(dockHasFocus);
      setDockOpen(false);
    }, 8000);
  }, []);

  useEffect(() => {
    if (dockOpen) {
      resetAutoDropTimer();
    } else if (autoDropTimerRef.current) {
      clearTimeout(autoDropTimerRef.current);
    }
    return () => {
      if (autoDropTimerRef.current) clearTimeout(autoDropTimerRef.current);
    };
  }, [dockOpen, resetAutoDropTimer]);

  useEffect(() => {
    if (!dockOpen && focusHandle.current) {
      document.querySelector<HTMLButtonElement>(".dock-trigger-pill")?.focus();
      focusHandle.current = false;
    } else if (dockOpen && focusDock.current) {
      dockRef.current?.querySelector<HTMLButtonElement>("[aria-selected=true]")?.focus();
      focusDock.current = false;
    }
  }, [dockOpen]);

  const prevHubState = useRef(`${snapshot.hub.state}:${snapshot.hub.errorCode}:${snapshot.hub.stale}:${unpaired}`);
  const prevEspState = useRef(`${snapshot.esp.state}:${snapshot.esp.errorCode}:${snapshot.esp.stale}`);
  useEffect(() => {
    const hubKey = `${snapshot.hub.state}:${snapshot.hub.errorCode}:${snapshot.hub.stale}:${unpaired}`;
    const espKey = `${snapshot.esp.state}:${snapshot.esp.errorCode}:${snapshot.esp.stale}`;
    if (prevHubState.current !== hubKey || prevEspState.current !== espKey) {
      prevHubState.current = hubKey;
      prevEspState.current = espKey;
      setDockOpen(true);
      resetAutoDropTimer();
    }
  }, [
    snapshot.hub.state,
    snapshot.hub.errorCode,
    snapshot.hub.stale,
    unpaired,
    snapshot.esp.state,
    snapshot.esp.errorCode,
    snapshot.esp.stale,
    resetAutoDropTimer,
  ]);

  // Key feedback does not wake the bar: an open bar would cover the bottom key row
  // being pressed. While the bar is hidden, feedback shows in the bottom edge strip.
  const controller = useMemo(
    () =>
      adapter
        ? new LightIntentController((patch, generation) =>
            adapter.request("esp.set", { patch, generation }),
          )
        : null,
    [adapter],
  );
  useEffect(() => () => controller?.dispose(), [controller]);
  // Lamp signals: new Claude/Codex/WhatsApp alerts and quota resets pulse the lamp.
  const [signalPrefs, setSignalPrefs] = useState<SignalPrefs>(loadSignalPrefs);
  const changeSignalPrefs = useCallback((next: SignalPrefs) => {
    setSignalPrefs(next);
    saveSignalPrefs(next);
  }, []);
  const signaller = useMemo(() => (controller ? new LampSignaller(controller) : null), [controller]);
  const detector = useRef(new SignalDetector());
  const hubData = snapshot.hub.data;
  useEffect(() => {
    const kinds = detector.current.observe(hubData).filter((kind) => signalPrefs[kind]);
    if (!kinds.length || (signalPrefs.quietHours && inQuietHours(new Date()))) return;
    void signaller?.fire(kinds[0]!);
  }, [hubData, signaller, signalPrefs]);
  useEffect(() => {
    if (snapshot.app?.webViewSupported !== false && snapshot.app)
      controller?.initialize(snapshot.app.nextCommandGeneration);
    controller?.applySnapshot(snapshot.esp);
  }, [controller, snapshot.app, snapshot.esp]);
  useEffect(() => {
    store.setHistoryOpen(sheet === "history");
    return () => store.setHistoryOpen(false);
  }, [store, sheet]);
  const dialog = useRef<HTMLDialogElement>(null),
    opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (sheet) {
      opener.current = document.activeElement as HTMLElement;
      dialog.current?.showModal();
    } else if (dialog.current?.open) {
      dialog.current.close();
      opener.current?.focus();
    }
  }, [sheet]);
  // The room clock uses the phone's local wall time, independently of USB.
  // Quotas and notification expiry continue to use the store's sampled laptop time.
  const [localNow, setLocalNow] = useState(() => new Date());
  useEffect(() => {
    const update = () => setLocalNow(new Date());
    const timer = window.setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const rawHours = localNow.getHours();
  const hours = rawHours % 12 || 12;
  const minutes = localNow.getMinutes().toString().padStart(2, "0");
  const ampm = rawHours >= 12 ? "PM" : "AM";
  const clock = `${hours}:${minutes}`;
  const date = localNow.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const notifications = snapshot.hub.data?.notifications;
  return (
    <main className="dashboard">
      <footer
        className={`bottom-dock ${dockOpen ? "is-open" : "is-collapsed"}`}
        ref={dockRef}
        aria-label="Navigation and status"
        onPointerEnter={(event) => { if (event.pointerType === "mouse") dockPointerInside.current = true; }}
        onPointerLeave={() => { dockPointerInside.current = false; resetAutoDropTimer(); }}
        onPointerDown={resetAutoDropTimer}
        onFocus={resetAutoDropTimer}
        onBlur={resetAutoDropTimer}
      >
        <div className="connections">
          <LinkStatus name="Laptop" link={snapshot.hub} unpaired={unpaired} />
          <LinkStatus name="Controller" link={snapshot.esp} />
          {actionFeedback && dockOpen && (
            <span className="deck-feedback" role="status" aria-live="polite">
              <span className="deck-feedback-dot" aria-hidden="true" />
              <span>{actionFeedback}</span>
            </span>
          )}
        </div>
        <div className="view-switcher" role="tablist" aria-label="Views"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "monitor" : event.key === "End" ? "deck" : view === "monitor" ? "deck" : "monitor";
            setView(next);
            dockRef.current?.querySelector<HTMLButtonElement>(`#${next}-tab`)?.focus();
            resetAutoDropTimer();
          }}>
          <button
            type="button"
            role="tab"
            id="monitor-tab"
            aria-controls="monitor-panel"
            aria-selected={view === "monitor"}
            className={`view-tab${view === "monitor" ? " is-active" : ""}`}
            onClick={() => {
              setView("monitor");
              resetAutoDropTimer();
            }}
            tabIndex={view === "monitor" ? 0 : -1}
          >
            Monitor
          </button>
          <button
            type="button"
            role="tab"
            id="deck-tab"
            aria-controls="deck-panel"
            aria-selected={view === "deck"}
            className={`view-tab${view === "deck" ? " is-active" : ""}`}
            onClick={() => {
              setView("deck");
              resetAutoDropTimer();
            }}
            tabIndex={view === "deck" ? 0 : -1}
          >
            Deck
          </button>
        </div>
        <div className="dock-actions">
          <button
            className="settings-button"
            aria-label="Open settings"
            onClick={() => setSheet("settings")}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 7h16M4 17h16M9 3v8M15 13v8"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="dock-collapse-button"
            aria-label="Hide bar"
            onClick={() => {
              focusHandle.current = true;
              dockPointerInside.current = false;
              setDockOpen(false);
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
            </svg>
          </button>
        </div>
      </footer>
      {!dockOpen && (
        <button
          type="button"
          className="dock-trigger-pill"
          aria-label="Open menu / status"
          onClick={() => { focusDock.current = true; setDockOpen(true); }}
        >
          {actionFeedback ? (
            <span className="dock-trigger-feedback" role="status" aria-live="polite">{actionFeedback}</span>
          ) : (
            <span className="dock-trigger-handle" aria-hidden="true" />
          )}
        </button>
      )}
      {snapshot.app?.webViewSupported === false && (
        <p className="setup-banner">
          Update Android System WebView to connect this display.
        </p>
      )}
      {!nativeAvailable && !demo && (
        <p className="setup-banner">
          Open the LumenDock app to connect your laptop and room controller.
        </p>
      )}
      {import.meta.env.DEV && demo && <span className="demo-label">Synthetic demo</span>}
      {view === "monitor" ? (
        <>
          <div className="main-grid" id="monitor-panel" role="tabpanel" aria-labelledby="monitor-tab">
            <div className="clock-room">
              <section className="local-clock" aria-label="Clock and date">
                <time className="clock" aria-label="Local time" dateTime={localNow.toISOString()}>
                  {clock}<span className="clock-ampm">{ampm}</span>
                </time>
                <p className="local-date">{date}</p>
              </section>
              {climateSlot ?? <ClimateCard snapshot={snapshot.esp} onHistory={() => setSheet("history")} />}
            </div>
            <div className="usage-alerts">
              <div className="usage-stack">
                {usageSlot ?? (nativeAvailable && unpaired ? (
                  <section className="card pair-card" role="status" aria-label="Laptop pairing">
                    <h2>Laptop</h2>
                    <p>
                      {snapshot.hub.errorCode === "AUTH_REQUIRED" && snapshot.app?.paired !== false
                        ? "The laptop no longer accepts this phone. Pair again."
                        : "This phone is not paired with the laptop yet."}
                    </p>
                    <button
                      disabled={pairBusy}
                      onClick={() => {
                        setPairBusy(true);
                        store
                          .setup("app.setupHub")
                          .catch(() => undefined)
                          .finally(() => setPairBusy(false));
                      }}
                    >
                      Pair laptop
                    </button>
                  </section>
                ) : (
                  <>
                    <UsageCard
                      name="Claude"
                      source={snapshot.hub.data?.usage.claude}
                      laptopNowEpochMs={snapshot.laptopNowEpochMs}
                      onDetails={() => setSheet("claude")}
                    />
                    <UsageCard
                      name="Codex"
                      source={snapshot.hub.data?.usage.codex}
                      laptopNowEpochMs={snapshot.laptopNowEpochMs}
                      onDetails={() => setSheet("codex")}
                    />
                  </>
                ))}
              </div>
              <section className="notification-strip" aria-label="Recent alerts">
                <h2>Recent alerts</h2>
                {notificationSlot ?? <NotificationStrip
                  dismissed={dismissed}
                  onDismiss={dismiss}
                  items={notifications?.items ?? []}
                  laptopNowEpochMs={snapshot.laptopNowEpochMs}
                  state={notifications?.state ?? "disabled"}
                  onDetails={() => setSheet("notifications")}
                />}
              </section>
            </div>
          </div>
          {lightingSlot && (
            <footer className="lighting-dock">
              {lightingSlot}
            </footer>
          )}
        </>
      ) : (
        <DeckView
          store={store}
          laptopConnected={snapshot.hub.state === "connected" && !snapshot.hub.stale && !unpaired}
          host={snapshot.hub.data?.host}
          esp={snapshot.esp}
          controller={controller}
          onOpenLights={() => setSheet("lights")}
          onFeedback={setActionFeedback}
        />
      )}
      <dialog
        ref={dialog}
        aria-labelledby="sheet-title"
        className="sheet"
        onCancel={() => setSheet(null)}
        onClose={() => {
          // The close event is queued and can arrive after the user already moved
          // focus or opened another sheet; it must neither undo that sheet nor pull
          // focus back. The effect above restores focus when a sheet closes.
          if (!dialog.current?.open) setSheet(null);
        }}
      >
        <div className="sheet-header">
          <span id="sheet-title">
            {sheet === "settings"
              ? "Settings"
              : sheet === "lights"
                ? "Lighting"
                : sheet === "history"
                  ? "Room history"
                  : sheet === "claude" || sheet === "codex"
                    ? "Usage windows"
                    : "Notifications"}
          </span>
          <button aria-label="Close sheet" onClick={() => setSheet(null)}>
            Close
          </button>
        </div>
        {sheet === "settings" ? (
          <>
            <SettingsSheet
              store={store}
              adapter={adapter}
              signals={{
                prefs: signalPrefs,
                onChange: changeSignalPrefs,
                onTest: signaller ? () => void signaller.fire("agent", true) : undefined,
              }}
              nativeAvailable={
                (nativeAvailable || demo) &&
                snapshot.app?.webViewSupported !== false
              }
            />
            {settingsSlot}
          </>
        ) : sheet === "lights" ? (
          <LightCard snapshot={snapshot.esp} controller={controller} expanded />
        ) : sheet === "claude" || sheet === "codex" ? (
          <UsageCard
            name={sheet === "claude" ? "Claude" : "Codex"}
            source={snapshot.hub.data?.usage[sheet]}
            laptopNowEpochMs={snapshot.laptopNowEpochMs}
            expanded
          />
        ) : sheet === "history" ? (
          <>
            <ClimateCard
              snapshot={snapshot.esp}
              history={snapshot.history?.data}
            />
            <p className="muted">
              {snapshot.history?.stale
                ? "Last history; readings may be old."
                : "Recent temperature trend. Missing readings leave gaps."}
            </p>
            {snapshot.history?.errorCode && (
              <p role="status">
                Room history unavailable. Lighting remains independent.
              </p>
            )}
          </>
        ) : (
          <>
            <h2>Selected notifications</h2>
            <p>
              Selected sources: Claude, Codex and WhatsApp. Enable these sources
              in laptop notification setup. Notifications expire after 30 minutes.
              Hiding an item affects only this display.
            </p>
            <NotificationStrip
              dismissed={dismissed}
              onDismiss={dismiss}
              items={notifications?.items ?? []}
              laptopNowEpochMs={snapshot.laptopNowEpochMs}
              state={notifications?.state ?? "disabled"}
              expanded
            />
          </>
        )}
      </dialog>
    </main>
  );
}
