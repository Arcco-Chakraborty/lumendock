import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sharedHostHelper, type HelperCommand, type WindowsHostHelper } from './host-helper.js';

// Windows Deck keys. Apps are started through their Start-menu identity (shell:AppsFolder), a
// fixed executable, or a fixed URL; nothing from the phone reaches a command line or a shell.
export interface WindowsActionDeps {
  helper?: WindowsHostHelper;
  /** Starts a fixed program detached; resolves false when it could not be started. */
  launch?: (file: string, args: string[]) => Promise<boolean>;
  exists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
}
type Result = { success: boolean; message?: string };

const launchDetached = (file: string, args: string[]) => new Promise<boolean>(resolve => {
  try {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, cwd: homedir() });
    child.once('spawn', () => { child.unref(); resolve(true); });
    child.once('error', () => resolve(false));
  } catch { resolve(false); }
});

// Store/MSIX apps by package family (stable across machines) and app id, in order of preference.
interface App { label: string; packages: Array<[family: string, appId: string]>; squirrel?: [folder: string, aumid: string]; url: string }
const APPS: Record<string, App> = {
  open_claude: { label: 'Claude', packages: [], squirrel: ['AnthropicClaude', 'com.squirrel.AnthropicClaude.claude'], url: 'https://claude.ai' },
  // The current ChatGPT desktop app ships in the OpenAI.Codex package; the older one is "ChatGPT Classic".
  open_chatgpt: { label: 'ChatGPT', packages: [['OpenAI.Codex_2p2nqsd0c76g0', 'App'], ['OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0', 'ChatGPT']], url: 'https://chatgpt.com' },
  open_whatsapp: { label: 'WhatsApp', packages: [['5319275A.WhatsAppDesktop_cv1g1gvanyjgm', 'App']], url: 'https://web.whatsapp.com' },
};

async function openApp(app: App, deps: Required<Omit<WindowsActionDeps, 'helper'>>): Promise<Result> {
  const local = deps.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  for (const [family, appId] of app.packages) {
    if (deps.exists(join(local, 'Packages', family)) && await deps.launch('explorer.exe', [`shell:AppsFolder\\${family}!${appId}`])) return { success: true, message: `Opening ${app.label}` };
  }
  if (app.squirrel && deps.exists(join(local, app.squirrel[0])) && await deps.launch('explorer.exe', [`shell:AppsFolder\\${app.squirrel[1]}`])) return { success: true, message: `Opening ${app.label}` };
  return await deps.launch('explorer.exe', [app.url]) ? { success: true, message: `Opening ${app.label} on the web` } : { success: false, message: `Could not open ${app.label}` };
}

function chromePath(deps: Required<Omit<WindowsActionDeps, 'helper'>>): string | null {
  const candidates = [deps.env.ProgramFiles, deps.env['ProgramFiles(x86)'], deps.env.LOCALAPPDATA]
    .filter((dir): dir is string => !!dir).map(dir => join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return candidates.find(path => deps.exists(path)) ?? null;
}

const HELPER_KEYS: Partial<Record<string, [HelperCommand, string]>> = {
  media_play_pause: ['media_play_pause', 'Play / Pause'], media_next: ['media_next', 'Next track'], media_prev: ['media_prev', 'Previous track'],
  media_mute: ['media_mute', 'Mute toggled'], volume_up: ['volume_up', 'Volume +5%'], volume_down: ['volume_down', 'Volume -5%'],
  mic_mute: ['mic_mute', 'Microphone toggled'],
};

export async function executeWindowsAction(action: string, options: WindowsActionDeps = {}): Promise<Result> {
  const deps = { launch: options.launch ?? launchDetached, exists: options.exists ?? existsSync, env: options.env ?? process.env };
  const app = APPS[action];
  if (app) return openApp(app, deps);
  const key = HELPER_KEYS[action];
  if (key) {
    try { const reply = await (options.helper ?? sharedHostHelper()).request(key[0]); return reply.ok ? { success: true, message: key[1] } : { success: false, message: 'Action failed' }; }
    catch { return { success: false, message: 'Action failed' }; }
  }
  const started = (ok: boolean, message: string): Result => ok ? { success: true, message } : { success: false, message: 'Action failed' };
  switch (action) {
    case 'open_chrome': {
      const chrome = chromePath(deps);
      return started(chrome ? await deps.launch(chrome, ['https://google.com']) : await deps.launch('explorer.exe', ['https://google.com']), 'Opening Chrome');
    }
    case 'open_terminal':
      // Windows Terminal's app alias, else a plain PowerShell console.
      if (await deps.launch('wt.exe', [])) return { success: true, message: 'Opening Terminal' };
      return started(await deps.launch('powershell.exe', ['-NoExit']), 'Opening Terminal');
    case 'lock_screen':
      return started(await deps.launch('rundll32.exe', ['user32.dll,LockWorkStation']), 'Locking screen');
    case 'screenshot':
      return started(await deps.launch('explorer.exe', ['ms-screenclip:']), 'Opening screenshot');
    case 'dnd_toggle':
      // Windows offers no supported way to switch Do Not Disturb from another program; its
      // notification center holds the switch, one click away.
      return started(await deps.launch('explorer.exe', ['ms-actioncenter:']), 'Notification center opened');
    default:
      return { success: false, message: `Unknown action: ${action}` };
  }
}
