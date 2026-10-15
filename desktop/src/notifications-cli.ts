import { allowNotificationApp, listNotificationApps, removeNotificationApp, replaceNotificationApps } from './config.js';
import { discoverSelectedNotificationApps } from './notification-sources.js';

const USAGE = 'Usage: notifications allow APP_LABEL | notifications remove APP_LABEL | notifications list | notifications configure-selected | notifications clear';
// Returns a process exit code; every message is fixed text (labels are the user's own input).
export async function runNotificationsCommand(argv: readonly string[], configDir: string, out: (line: string) => void = console.log,applicationDirectories?:readonly string[]): Promise<number> {
  const args = argv[0] === 'notifications' ? argv.slice(1) : argv;
  const [command, label, ...extra] = args;
  const usage = (): number => { out(USAGE); return 2; };
  try {
    if(command==='configure-selected'||command==='clear'){
      if(label!==undefined)return usage();
      await replaceNotificationApps(configDir,command==='clear'?[]:discoverSelectedNotificationApps(applicationDirectories));
      out(command==='clear'?'Notification capture is off.':'Selected sources configured: Claude, Codex and WhatsApp only. Installed WhatsApp PWA identities are included; other browser notifications are excluded.');
      return 0;
    }
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
