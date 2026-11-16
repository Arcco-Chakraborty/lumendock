import { CalendarConnectionStore, type CalendarClient, type CalendarTokens } from './connection.js';
import { authorizeCalendarClient, readCalendarClientFile } from './oauth.js';

export const CALENDAR_USAGE =
  'Usage: calendar connect --client FILE | calendar disconnect | calendar status | calendar help';

export interface CalendarCliDeps {
  out?: (line: string) => void;
  store?: CalendarConnectionStore;
  readClient?: (path: string) => CalendarClient;
  authorize?: (client: CalendarClient) => Promise<CalendarTokens>;
}

const HELP_TEXT = [
  CALENDAR_USAGE,
  '',
  'Commands:',
  '  calendar connect --client FILE  Sign in to Google Calendar in your browser (read-only).',
  '  calendar disconnect             Remove saved Google Calendar credentials and selection.',
  '  calendar status                 Show current Google Calendar connection and selection status.',
  '  calendar help                   Show this help text.',
].join('\n');

export async function runCalendarCommand(
  argv: readonly string[],
  directory: string,
  deps: CalendarCliDeps = {},
): Promise<number> {
  const out = deps.out ?? console.log;
  const args = argv[0] === 'calendar' ? argv.slice(1) : argv;
  const [subcommand, ...rest] = args;

  if (!subcommand) {
    out(CALENDAR_USAGE);
    return 2;
  }

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    if (rest.length > 0) {
      out(CALENDAR_USAGE);
      return 2;
    }
    out(HELP_TEXT);
    return 0;
  }

  const store = deps.store ?? new CalendarConnectionStore(directory);

  try {
    if (subcommand === 'status') {
      if (rest.length > 0) {
        out(CALENDAR_USAGE);
        return 2;
      }
      const state = store.read();
      if (!state.connected) {
        if (state.authRequired) {
          out('Google Calendar authorization expired or was revoked. Run `calendar connect --client FILE` to reconnect.');
        } else {
          out('Google Calendar is disconnected. Agenda sync is off.');
        }
        return 0;
      }
      if (!state.applied) {
        out('Google Calendar is connected (setup required). Open Agenda on your phone to review and apply which calendars to include before events are read.');
        return 0;
      }
      out(`Google Calendar is connected. ${state.selectedIds.length} calendar(s) selected for read-only Agenda sync.`);
      return 0;
    }

    if (subcommand === 'disconnect') {
      if (rest.length > 0) {
        out(CALENDAR_USAGE);
        return 2;
      }
      await store.disconnect();
      out('Google Calendar disconnected. Saved credentials and calendar selection were removed; a running hub clears its cache within a few seconds.');
      return 0;
    }

    if (subcommand === 'connect') {
      if (rest.length !== 2 || rest[0] !== '--client' || !rest[1] || rest[1].startsWith('--')) {
        out(CALENDAR_USAGE);
        return 2;
      }
      const clientPath = rest[1];
      const readClient = deps.readClient ?? readCalendarClientFile;
      const authorize = deps.authorize ?? ((client: CalendarClient) => authorizeCalendarClient({ client }));

      const client = readClient(clientPath);
      const generation = await store.beginConnect();
      out('Opening your system browser for read-only Google Calendar authorization...');
      const tokens = await authorize(client);
      const finished = await store.finishConnect(generation, client, tokens);
      if (!finished) {
        out('Google Calendar connection was superseded by another command. No credentials were saved.');
        return 1;
      }
      out('Google Calendar account connected (read-only).');
      out('Next step: open the Agenda tab on your phone, review the discovered calendars, and tap Apply before any events are loaded.');
      return 0;
    }

    out(CALENDAR_USAGE);
    return 2;
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    switch (code) {
      case 'CALENDAR_CLIENT_INVALID':
        out('The OAuth client JSON file is missing, not owned by your user, or is not a valid Desktop OAuth client.');
        break;
      case 'CALENDAR_PRIVATE_STORAGE':
        out('Private calendar storage could not be verified for your user account (check directory ownership or Windows ACLs). No credentials were saved.');
        break;
      case 'CALENDAR_PARTIAL_GRANT':
        out('All three read-only Google Calendar permissions (events, calendarlist, calendars) must be granted. No credentials were saved.');
        break;
      case 'CALENDAR_OAUTH_CANCELLED':
        out('Google Calendar authorization was cancelled. No credentials were saved.');
        break;
      case 'CALENDAR_OAUTH_TIMEOUT':
        out('Google Calendar authorization timed out before the browser callback completed. No credentials were saved.');
        break;
      case 'CALENDAR_OAUTH_STATE_MISMATCH':
        out('Google Calendar callback state check failed. No credentials were saved.');
        break;
      case 'CALENDAR_BROWSER_FAILED':
        out('Could not launch the system browser for Google Calendar sign-in.');
        break;
      case 'CONFIG_BUSY':
        out('Another calendar configuration operation is in progress; retry shortly.');
        break;
      default:
        out('Google Calendar command failed. No credentials or private details were logged.');
        break;
    }
    return 1;
  }
}
