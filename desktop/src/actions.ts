import { exec, spawn } from 'node:child_process';
import { execRunner, type HostRunner } from './collectors/host.js';

export const SUPPORTED_ACTIONS = [
  'open_claude',
  'open_chatgpt',
  'open_chrome',
  'open_whatsapp',
  'open_terminal',
  'media_prev',
  'media_play_pause',
  'media_next',
  'media_mute',
  'volume_down',
  'volume_up',
  'mic_mute',
  'dnd_toggle',
  'lock_screen',
  'screenshot',
] as const;

export type SupportedAction = typeof SUPPORTED_ACTIONS[number];

type Spawner = (command: string, args: string[]) => {
  once(event: 'spawn' | 'error', listener: () => void): unknown;
  unref(): void;
};
const detached: Spawner = (command, args) =>
  spawn(command, args, { detached: true, stdio: 'ignore', cwd: process.env.HOME });

// A terminal stays open, so it is started detached: waiting for it to exit would
// hold the phone's request open. Candidates are tried in order until one starts.
export const TERMINALS: ReadonlyArray<readonly [string, string[]]> = [
  ['ptyxis', ['--new-window']],
  ['gnome-terminal', ['--window']],
  ['kgx', []],
  ['x-terminal-emulator', []],
];

export async function openTerminal(start: Spawner = detached): Promise<{ success: boolean; message: string }> {
  for (const [command, args] of TERMINALS) {
    const started = await new Promise<boolean>((done) => {
      const child = start(command, args);
      child.once('spawn', () => { child.unref(); done(true); });
      child.once('error', () => done(false));
    });
    if (started) return { success: true, message: 'Opening Terminal' };
  }
  return { success: false, message: 'No terminal found' };
}

const SYSTEM_ACTIONS: Record<string, {label: string; run: (run: HostRunner) => Promise<unknown>}> = {
  mic_mute: {label: 'Microphone toggled', run: run => run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SOURCE@', 'toggle'])},
  dnd_toggle: {label: 'Do Not Disturb toggled', run: async run => {
    const banners = (await run('gsettings', ['get', 'org.gnome.desktop.notifications', 'show-banners'])).trim();
    await run('gsettings', ['set', 'org.gnome.desktop.notifications', 'show-banners', banners === 'false' ? 'true' : 'false']);
  }},
  lock_screen: {label: 'Locking screen', run: run => run('loginctl', ['lock-session'])},
  // GNOME only lets its own tools capture silently; the portal opens the system screenshot UI.
  screenshot: {label: 'Opening screenshot', run: run => run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.portal.Desktop',
    '--object-path', '/org/freedesktop/portal/desktop', '--method', 'org.freedesktop.portal.Screenshot.Screenshot', '', "{'interactive': <true>}"])},
};

/** Laptop system keys: fixed commands only, never a shell. */
export async function systemAction(action: string, run: HostRunner = execRunner): Promise<{success: boolean; message: string} | null> {
  const entry = SYSTEM_ACTIONS[action];
  if (!entry) return null;
  try { await entry.run(run); return {success: true, message: entry.label}; }
  catch { return {success: false, message: 'Action failed'}; }
}

export function executeAction(action: string): Promise<{ success: boolean; message?: string }> {
  return new Promise((resolve) => {
    switch (action) {
      case 'open_claude':
        exec('claude-desktop 2>/dev/null || gtk-launch com.anthropic.Claude 2>/dev/null || xdg-open https://claude.ai', (err) => {
          resolve({ success: !err, message: err ? err.message : 'Opening Claude App' });
        });
        break;
      case 'open_chatgpt':
        exec('chatgpt 2>/dev/null || gtk-launch chatgpt 2>/dev/null || xdg-open https://chatgpt.com', (err) => {
          resolve({ success: !err, message: err ? err.message : 'Opening ChatGPT App' });
        });
        break;
      case 'open_chrome':
        exec('google-chrome https://google.com || xdg-open https://google.com', (err) => {
          resolve({ success: !err, message: err ? err.message : 'Opening Chrome' });
        });
        break;
      case 'open_whatsapp':
        exec(
          'gtk-launch chrome-hnpfjngllnobngcgfapefoaidbinmjnm-Default 2>/dev/null || /opt/google/chrome/google-chrome --profile-directory=Default --app-id=hnpfjngllnobngcgfapefoaidbinmjnm 2>/dev/null || xdg-open https://web.whatsapp.com',
          (err) => {
            resolve({ success: !err, message: err ? err.message : 'Opening WhatsApp App' });
          }
        );
        break;
      case 'open_terminal':
        void openTerminal().then(resolve);
        break;
      case 'media_play_pause':
        exec(
          `for dest in $(dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null | grep -o 'org\\.mpris\\.MediaPlayer2[^"]*'); do dbus-send --session --dest=$dest --type=method_call /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player.PlayPause 2>/dev/null || true; done`,
          () => resolve({ success: true, message: 'Play / Pause' })
        );
        break;
      case 'media_next':
        exec(
          `for dest in $(dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null | grep -o 'org\\.mpris\\.MediaPlayer2[^"]*'); do dbus-send --session --dest=$dest --type=method_call /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player.Next 2>/dev/null || true; done`,
          () => resolve({ success: true, message: 'Next track' })
        );
        break;
      case 'media_prev':
        exec(
          `for dest in $(dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null | grep -o 'org\\.mpris\\.MediaPlayer2[^"]*'); do dbus-send --session --dest=$dest --type=method_call /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player.Previous 2>/dev/null || true; done`,
          () => resolve({ success: true, message: 'Previous track' })
        );
        break;
      case 'media_mute':
        exec('wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle 2>/dev/null || amixer set Master toggle', (err) => {
          resolve({ success: !err, message: 'Mute toggled' });
        });
        break;
      case 'volume_up':
        exec('wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%+ 2>/dev/null || amixer set Master 5%+', (err) => {
          resolve({ success: !err, message: 'Volume +5%' });
        });
        break;
      case 'volume_down':
        exec('wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%- 2>/dev/null || amixer set Master 5%-', (err) => {
          resolve({ success: !err, message: 'Volume -5%' });
        });
        break;
      default:
        void systemAction(action).then(result => resolve(result ?? { success: false, message: `Unknown action: ${action}` }));
    }
  });
}
