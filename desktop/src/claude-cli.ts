import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installClaudeStatusLine, readClaudeInstallation, uninstallClaudeStatusLine, type ClaudeCompatibility } from './claude/install.js';
import { parseOptions, type Io } from './setup-cli.js';

// Testable core of scripts/claude-install.mjs and claude-uninstall.mjs. It delegates every write to the reviewed
// installer and never relaxes its gates: replacing an existing status-line command still needs the declared shell,
// an exact Claude 2.1.x version and explicit shell/cancellation attestations. Nothing here runs Claude or reads provider auth.
export interface ClaudeCliDeps {
  io: Io; settingsPath: string; configDir: string; nodePath: string; wrapperPath: string; overrideSettingsPaths?: readonly string[];
  /** True when the wrapper module (and the compiled shared protocol it imports) loads under nodePath. */
  checkWrapper?: (nodePath: string, wrapperPath: string) => boolean;
}
// Importing the wrapper does not run it (its entry point only runs as the main module).
export function wrapperLoads(nodePath: string, wrapperPath: string): boolean {
  if (!existsSync(wrapperPath)) return false;
  const result = spawnSync(nodePath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(wrapperPath).href)})`], { stdio: 'ignore', timeout: 15000 });
  return result.status === 0;
}
const INSTALL_USAGE = 'Usage: claude-install [--dry-run] [--settings PATH] [--previous-shell PATH --claude-version 2.1.N --attest-shell --attest-cancellation]';
const UNINSTALL_USAGE = 'Usage: claude-uninstall [--settings PATH]';
const MESSAGES: Record<string, string> = {
  ABSOLUTE_PATH_REQUIRED: 'All paths must be absolute.',
  WRAPPER_UNAVAILABLE: 'The Claude wrapper is not built or cannot load. Run: npm ci && npm run build',
  SETTINGS_SYMLINK: 'Your settings file is a symbolic link; for safety the installer does not follow links. Pass --settings with the real file path. Nothing was changed.',
  UNSUPPORTED_STATUSLINE: 'Your existing status line is not a plain command. Nothing was changed.',
  PREVIOUS_SHELL_REQUIRED: 'You already have a status-line command. Declare the absolute shell it runs under with --previous-shell PATH. Nothing was changed.',
  CANCELLATION_COMPATIBILITY_REQUIRED: 'Passing through an existing command needs --claude-version 2.1.N and --attest-cancellation, after you have verified cancellation behaviour yourself. Nothing was changed.',
  PREVIOUS_SHELL_UNVERIFIED: 'Passing through an existing command needs --attest-shell for the declared shell. Nothing was changed.',
  STATUSLINE_OWNERSHIP_CONFLICT: 'The status line was changed since installation, so it is not ours to modify. Nothing was changed.',
  SETTINGS_CHANGED: 'Your settings file changed while the command ran. Nothing was changed; run it again.',
  BAD_INSTALLATION_RECORD: 'The installation record is unreadable. Nothing was changed.',
  INVALID_SETTINGS: 'The settings file is not a JSON object. Nothing was changed.',
};
const explain = (error: unknown): string => {
  const e = error as NodeJS.ErrnoException;
  if (e.code === 'ELOOP' || e.message === 'UNSAFE_FILE') return MESSAGES.SETTINGS_SYMLINK!;
  return MESSAGES[e.message] ?? 'The command could not complete. Nothing was changed.';
};
const absolute = (value: string) => isAbsolute(value) && !value.includes('\0');

function inspect(settingsPath: string): 'missing' | 'symlink' | 'no_status_line' | 'has_command' | 'unsupported' | 'unreadable' {
  try { if (lstatSync(settingsPath).isSymbolicLink()) return 'symlink'; } catch { return 'missing'; }
  try {
    const data = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return 'unreadable';
    if (!Object.hasOwn(data, 'statusLine')) return 'no_status_line';
    const line = data.statusLine as Record<string, unknown> | null;
    return line && typeof line === 'object' && line.type === 'command' && typeof line.command === 'string' ? 'has_command' : 'unsupported';
  } catch { return 'unreadable'; }
}

export async function runClaudeInstallCommand(argv: readonly string[], deps: ClaudeCliDeps): Promise<number> {
  const { io } = deps;
  const parsed = parseOptions(argv, { '--dry-run': 'flag', '--settings': 'value', '--previous-shell': 'value', '--claude-version': 'value', '--attest-shell': 'flag', '--attest-cancellation': 'flag' });
  if (typeof parsed === 'string') { io.err(`${parsed} ${INSTALL_USAGE}`); return 2; }
  const settingsPath = parsed.values.get('--settings') ?? deps.settingsPath;
  const previousShell = parsed.values.get('--previous-shell'); const claudeVersion = parsed.values.get('--claude-version');
  if (!absolute(settingsPath) || (previousShell !== undefined && !absolute(previousShell))) { io.err('Paths must be absolute. ' + INSTALL_USAGE); return 2; }
  let compatibility: ClaudeCompatibility | undefined;
  if (previousShell !== undefined || claudeVersion !== undefined || parsed.flags.has('--attest-shell') || parsed.flags.has('--attest-cancellation')) {
    // Attestations are the user's own statement; the installer still validates version format and shell match.
    compatibility = { claudeVersion: claudeVersion ?? '', shellPath: previousShell ?? '', shellVerified: parsed.flags.has('--attest-shell'), cancellationVerified: parsed.flags.has('--attest-cancellation') };
  }
  const options = { settingsPath, wrapperPath: deps.wrapperPath, configDir: deps.configDir, nodePath: deps.nodePath, ...(previousShell !== undefined ? { previousShell } : {}), ...(compatibility ? { compatibility } : {}), overrideSettingsPaths: deps.overrideSettingsPaths ?? [] };
  if (parsed.flags.has('--dry-run')) {
    const state = inspect(settingsPath); let recorded = false;
    try { recorded = readClaudeInstallation(deps.configDir) !== null; } catch { /* reported below */ }
    io.out('Dry run: nothing is written.');
    io.out(`Settings file: ${state === 'missing' ? 'not present (it would be created)' : state}`);
    const loads = (deps.checkWrapper ?? wrapperLoads)(deps.nodePath, deps.wrapperPath);
    io.out(`Wrapper built and loadable: ${loads ? 'yes' : 'NO (run npm ci && npm run build first)'}`);
    io.out(`Already installed by this product: ${recorded ? 'yes' : 'no'}`);
    io.out(state === 'has_command'
      ? 'You have an existing status-line command. It is kept only if you pass --previous-shell, --claude-version, --attest-shell and --attest-cancellation after verifying them; otherwise install refuses and changes nothing.'
      : state === 'symlink' ? MESSAGES.SETTINGS_SYMLINK!
      : state === 'unreadable' || state === 'unsupported' ? 'Install would refuse and change nothing.' : 'Install would add the wrapper status line and back up your settings first.');
    return state === 'unreadable' || state === 'unsupported' || state === 'symlink' || !loads ? 1 : 0;
  }
  if (!(deps.checkWrapper ?? wrapperLoads)(deps.nodePath, deps.wrapperPath)) { io.err(MESSAGES.WRAPPER_UNAVAILABLE!); return 1; }
  try {
    // A first-time Claude user may not have ~/.claude yet; the dry run promised it would be created.
    if (!existsSync(dirname(settingsPath))) mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
    const result = await installClaudeStatusLine(options);
    io.out(result.changed ? 'Claude status-line wrapper installed. Settings were backed up in the private config directory.' : 'Already installed; nothing changed.');
    for (const line of result.diagnostics) io.out(line);
    io.out('Live behaviour with your Claude version is UNVERIFIED until you observe quota data after your next Claude session.');
    return 0;
  } catch (error) { io.err(explain(error)); return 1; }
}

export async function runClaudeUninstallCommand(argv: readonly string[], deps: ClaudeCliDeps): Promise<number> {
  const { io } = deps;
  const parsed = parseOptions(argv, { '--settings': 'value' });
  if (typeof parsed === 'string') { io.err(`${parsed} ${UNINSTALL_USAGE}`); return 2; }
  const settingsPath = parsed.values.get('--settings') ?? deps.settingsPath;
  if (!absolute(settingsPath)) { io.err('Paths must be absolute. ' + UNINSTALL_USAGE); return 2; }
  try {
    const result = await uninstallClaudeStatusLine({ settingsPath, configDir: deps.configDir });
    io.out(result.changed ? 'Claude status-line wrapper removed; only the field this product owns was restored.' : 'Nothing to remove.');
    return 0;
  } catch (error) { io.err(explain(error)); return 1; }
}
