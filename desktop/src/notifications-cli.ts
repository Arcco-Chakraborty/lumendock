import { allowNotificationApp, listNotificationApps, removeNotificationApp } from './config.js';

const USAGE = 'Usage: notifications allow APP_LABEL | notifications remove APP_LABEL | notifications list';
// Returns a process exit code; every message is fixed text (labels are the user's own input).
export async function runNotificationsCommand(argv: readonly string[], configDir: string, out: (line: string) => void = console.log): Promise<number> {
  const args = argv[0] === 'notifications' ? argv.slice(1) : argv;
  const [command, label, ...extra] = args;
  const usage = (): number => { out(USAGE); return 2; };
  try {
    if (command === 'list') {
      if (label !== undefined) return usage();
      const labels = listNotificationApps(configDir);
      out(labels.length ? labels.join('\n') : 'No notification apps are allowed. The notification feed is off.');
      return 0;
    }
    if ((command !== 'allow' && command !== 'remove') || label === undefined || extra.length) return usage();
    const labels = await (command === 'allow' ? allowNotificationApp : removeNotificationApp)(configDir,label);
    out(`${command === 'allow' ? 'Allowed' : 'Removed'} notification app "${label}". ${labels.length} app(s) allowed.`);
    return 0;
  } catch (error) {
    const code = (error as Error).message;
    out(code === 'BAD_APP_LABEL' ? 'That is not a valid app label: use 1-80 letters, digits, spaces or _ . : - with no leading or trailing space.'
      : code === 'ALLOWLIST_FULL' ? 'At most 10 notification apps can be allowed. Remove one first.'
      : code === 'BAD_CONFIG' ? 'The private config file is unreadable; fix or remove it. It was not changed.'
      : 'The notification setting could not be saved.');
    return 1;
  }
}
