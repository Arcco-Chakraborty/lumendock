# Google Calendar Agenda Setup (`docs/CALENDAR.md`)

LumenDock includes an opt-in, read-only **Agenda** section that displays your upcoming Google Calendar events and event labels on the phone over the existing authenticated USB connection while the phone remains connected to the offline ESP32 Wi-Fi access point.

## Scope and Privacy Guarantees

- **Opt-in and read-only:** Calendar sync is disabled until you explicitly connect an account from the laptop CLI and apply your calendar selection in the phone's **Agenda** tab.
- **Exact OAuth scopes requested:**
  - `https://www.googleapis.com/auth/calendar.events.readonly`
  - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
  - `https://www.googleapis.com/auth/calendar.calendars.readonly` (required to read calendar metadata containing named event label definitions)
- **No Google writes, Tasks, or background alarms:** This integration never creates, edits, or deletes calendars or events. Google Tasks items (which use the separate Tasks API) and phone-side background alarm scheduling or lamp triggers are not part of this feature.
- **No shared credentials:** LumenDock uses your own Desktop OAuth client and stores tokens only in its private configuration directory (`~/.config/phone-monitor/calendar/` on Linux or `%USERPROFILE%\.config\phone-monitor\calendar\` on Windows, protected with `0700`/`0600` modes on POSIX and a verified current-user DACL on Windows). It never reads unrelated Google or AI provider credentials.
- **Minimal normalized wire data:** Event descriptions, conference links/passwords, locations, and attendee email addresses are stripped on the laptop before data is served to the phone. Only opaque source/event identifiers, titles, times/dates, calendar badge names/colors, resolved label names/colors, event status, your own invitation response (`selfResponseStatus`), and reminder minutes are forwarded.

---

## 1. Create a User-Owned Google Cloud Desktop OAuth Client

Because no shared OAuth client secret is shipped in the repository, create a personal Desktop OAuth client in your own Google Cloud project:

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create or select a personal project.
2. Navigate to **APIs & Services > Library**, search for **Google Calendar API**, and click **Enable**.
3. Navigate to **APIs & Services > OAuth consent screen**:
   - Choose **External** (or **Internal** if using a Google Workspace organization account).
   - Fill in the required app name (for example, `LumenDock Local`) and your contact email.
   - Under **Scopes**, add the three read-only Calendar scopes:
     - `.../auth/calendar.events.readonly`
     - `.../auth/calendar.calendarlist.readonly`
     - `.../auth/calendar.calendars.readonly`
   - If the project is External and in **Testing** publishing status, add your own Google account under **Test users**.
4. Navigate to **APIs & Services > Credentials**:
   - Click **Create Credentials > OAuth client ID**.
   - Select application type **Desktop app**.
   - Download the resulting JSON file to a private path on your laptop, such as `/path/to/synthetic-google-desktop-client.json` (restrict its permissions with `chmod 600 /path/to/synthetic-google-desktop-client.json`).

### 7-Day Testing Token Limit vs. Production Publishing

- **External projects in Testing status:** Google enforces a **7-day expiration** on refresh tokens for External OAuth projects whose publishing status is **Testing** when sensitive scopes such as Google Calendar are requested. When the grant expires after 7 days, Agenda displays a reconnect prompt (`CALENDAR_AUTH_REQUIRED`) and you can re-run `calendar connect`.
- **Longer-lived refresh tokens:**
  - If you use a Google Workspace account and set the OAuth consent screen to **Internal**, the 7-day Testing expiration does not apply.
  - For a personal `@gmail.com` account on an **External** project, moving the consent screen to **In production** removes the 7-day Testing cap, though Google will display an "unverified app" warning screen during your own local sign-in unless you complete sensitive-scope verification. Do not enable billing or third-party distribution unless you want to.

---

## 2. Laptop CLI Commands

Build the desktop package first if `desktop/dist/main.js` is not yet compiled:

```bash
npm --workspace @phone-monitor/desktop run build
```

All calendar commands run through `desktop/dist/main.js` and coordinate safely with a running hub without requiring a hub restart:

### Connect or Reconnect an Account

Connect separately on Ubuntu and Windows; a phone pairing or a Google connection in another application does not authorize this hub. Use the original downloaded **Desktop app** client JSON on each computer, and complete browser consent there. Do not copy `tokens.json` between computers.


```bash
node desktop/dist/main.js calendar connect --client /path/to/synthetic-google-desktop-client.json
```

What happens during `calendar connect`:
1. Starts an ephemeral `127.0.0.1` loopback HTTP callback listener with PKCE (`S256`) and a random `state` token.
2. Opens your normal system browser to Google's consent page requesting offline access and the three read-only Calendar scopes.
3. Saves the OAuth client configuration and tokens in private app-owned files under a new connection generation.
4. Places the connection into **`setup_required`** state and enumerates your calendar list and label metadata only. **No event requests are made until you review and apply your calendar selection in the phone's Agenda tab.**

### Check Connection Status

```bash
node desktop/dist/main.js calendar status
```

Reports whether Google Calendar is disconnected, waiting for initial calendar selection in Agenda (`setup_required`), connected with a count of selected calendars, or requiring reconnection (`auth_required`).

### Disconnect and Clear Credentials

```bash
node desktop/dist/main.js calendar disconnect
```

Atomically installs a fresh disconnected generation, deletes saved OAuth client and token files plus local calendar selection, cancels any in-flight sync jobs, and clears the laptop's in-memory calendar cache.

### Show CLI Help

```bash
node desktop/dist/main.js calendar help
```

---

## 3. Completing Setup in the Phone Agenda Tab

1. After `calendar connect` succeeds on the laptop, open the **Agenda** tab on the phone.
2. When the connection is in `setup_required` state, Agenda opens the calendar inclusion list:
   - All readable subscribed calendars (including hidden calendars) are listed and defaulted **on** for initial review.
   - Free/busy-only or unavailable calendars are shown explicitly with their capability and defaulted **off**.
   - Deselect any calendars you do not want imported, then tap **Apply**.
3. Event collection begins only after you apply your selection. Any newly created or subscribed calendars discovered later default to **off** until you explicitly include them.

---

## 4. Named Event Labels and Fallback Behavior

- **Calendar badges vs. event labels:** Every event keeps its owning calendar's display name and color separate from its per-event label.
- **Named labels (`labelProperties` / `eventLabelId`):** The collector reads `Calendars.labelProperties.eventLabels[]` from calendar metadata and opts in to `eventLabelVersion=1` on event reads.
- **Discovery and fallback note:** Google's Calendar guide documents `eventLabelVersion=1` and `eventLabelId`, while some discovery documents and account tiers omit or reject `eventLabelVersion=1`. If Google rejects the parameter or if label metadata is unavailable or unnamed:
  - The collector automatically falls back to standard event reads and legacy event palette colors (`colorId`) without hiding any event or fabricating category names.
  - Real-account label parity should be verified against your own synthetic labelled events during acceptance testing.

---

## 5. Refresh Cadence, Capacity Bounds, and Disconnect Limits

- **Refresh cadence:**
  - Events refresh every **2 minutes** while the phone is actively polling the hub, and every **15 minutes** while idle.
  - Calendar list and label metadata refresh at startup, every **15 minutes**, and on manual refresh (coalesced to at most once every 15 seconds, honoring upstream `Retry-After` backoff).
  - Each calendar's cached window is replaced atomically only after all pages for that calendar succeed; if one calendar fails during a refresh, its previous complete events remain visible with a `partial` status and its prior `lastSuccessAtEpochMs` timestamp.
- **Capacity limits:**
  - Source discovery supports up to **100 calendars** (`CALENDAR_CAPACITY` if exceeded, never silently truncated).
  - Range requests span **1–31 days** (default 7 days), paged at up to **50 events** and **128 KiB** per page with a 10-minute cursor lifetime.
  - The laptop caches at most **3 ranges / 16 MiB** in memory, with a per-range cap of **10,000 event occurrences / 16 MiB staging** and **2 MiB** per upstream Google response. Breaching a capacity limit fails that update explicitly while preserving the previous complete range.
- **Disconnect and offline phone behavior:**
  - Running `calendar disconnect` immediately clears laptop credentials and cache; the next authenticated poll from the phone clears the phone's Agenda state.
  - If the phone is physically unplugged from USB when you run `calendar disconnect` on the laptop, the phone cannot receive the remote clear notification until it reconnects or its foreground app session ends.

## 6. Recovering “Setup needed” or “Disconnected”

Run `npm run calendar -- status` from the LumenDock folder. If it reports disconnected or expired authorization, reconnect with the Desktop app client JSON you downloaded previously:

```bash
npm run calendar -- connect --client "/absolute/path/to/client_secret.json"
```

On Windows, use a quoted Windows path, for example `"C:\Users\YOUR_USER\Downloads\client_secret.json"`. Then open **Agenda → Calendars** on the phone and tap **Apply**. A running hub notices the new connection without a restart.

By default, Calendar files are under `~/.config/phone-monitor/calendar/` on Ubuntu and `%USERPROFILE%\.config\phone-monitor\calendar\` on Windows. An explicit `XDG_CONFIG_HOME` changes the base directory on both platforms. The downloaded JSON is separate from the app's saved files. Disconnect or an invalidated grant removes saved credentials, so retain your original download privately. If it is missing, download a Desktop app client again from your existing Google Cloud project's **APIs & Services → Credentials** page; a new Cloud project is unnecessary.

If Windows reports that private storage could not be verified, update to this source and rebuild. The Calendar storage helper now passes directory paths to PowerShell as literal data, including paths containing spaces or apostrophes. Do not weaken directory permissions to work around this error.
