import { AdbConnection, AdbError, maskSerial, type AdbEvent } from './adb.js';
import { formatDoctorText, runDoctor, type DoctorInput } from './doctor.js';
import { SERVICE_NAME, ServiceError, installHubService, renderUnit, uninstallHubService, type SystemctlRunner } from './service.js';

// Testable cores of scripts/{doctor,connect,install-hub,uninstall-hub}.mjs. The scripts only
// wire real I/O (processes, signals, filesystem defaults) into these functions.

export interface Io { out(line: string): void; err(line: string): void }
type OptionKind = 'flag' | 'value';

export function parseOptions(argv: readonly string[], spec: Record<string, OptionKind>): { flags: Set<string>; values: Map<string, string> } | string {
  const flags = new Set<string>(); const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!;
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (!kind) return `Unknown argument. Allowed: ${Object.keys(spec).join(' ')}`;
    if (flags.has(name) || values.has(name)) return `Duplicate ${name}.`;
    if (kind === 'flag') { flags.add(name); continue; }
    const value = argv[++i];
    if (value === undefined || value === '' || value.startsWith('--')) return `${name} needs a value.`;
    values.set(name, value);
  }
  return { flags, values };
}

export interface DoctorCommandDeps { io: Io; collect: (options: Pick<DoctorInput, 'adbPath' | 'showSerial' | 'selectedSerial'>) => Promise<DoctorInput> }
export async function runDoctorCommand(argv: readonly string[], deps: DoctorCommandDeps): Promise<number> {
  const parsed = parseOptions(argv, { '--json': 'flag', '--show-serial': 'flag', '--serial': 'value', '--adb': 'value' });
  if (typeof parsed === 'string') { deps.io.err(`${parsed} Usage: doctor [--json] [--show-serial] [--serial SERIAL] [--adb PATH]`); return 2; }
  const adbPath = parsed.values.get('--adb'); const selectedSerial = parsed.values.get('--serial');
  const input = await deps.collect({ showSerial: parsed.flags.has('--show-serial'), ...(adbPath ? { adbPath } : {}), ...(selectedSerial ? { selectedSerial } : {}) });
  const report = await runDoctor(input);
  deps.io.out(parsed.flags.has('--json') ? JSON.stringify(report, null, 2) : formatDoctorText(report));
  return report.ok ? 0 : 1;
}

export interface ConnectDeps { io: Io; createAdb: (adbPath: string | undefined) => AdbConnection; signal: AbortSignal }
export async function runConnectCommand(argv: readonly string[], deps: ConnectDeps): Promise<number> {
  const usage = 'Usage: connect --serial SERIAL [--once] [--show-serial] [--adb PATH]';
  const parsed = parseOptions(argv, { '--serial': 'value', '--once': 'flag', '--show-serial': 'flag', '--adb': 'value' });
  if (typeof parsed === 'string') { deps.io.err(`${parsed} ${usage}`); return 2; }
  const serial = parsed.values.get('--serial');
  if (!serial) { deps.io.err(`A phone must be selected explicitly; none is chosen automatically. Run \`npm run doctor\` to list authorized USB devices. ${usage}`); return 2; }
  const label = parsed.flags.has('--show-serial') ? serial : maskSerial(serial);
  const adb = deps.createAdb(parsed.values.get('--adb'));
  if (parsed.flags.has('--once')) {
    try {
      const result = await adb.ensureReverse(serial, deps.signal);
      deps.io.out(`Reverse tcp:${result.port} -> tcp:${result.port} is active for ${label}${result.model ? ` (${result.model})` : ''}.`);
      return 0;
    } catch (error) { deps.io.err(error instanceof AdbError ? error.message : 'Connection failed.'); return 1; }
  }
  const report = (event: AdbEvent) => {
    if (event.state === 'connected') deps.io.out(`Connected: reverse tcp:${event.port} -> tcp:${event.port} active for ${label}.`);
    else deps.io.out(`Waiting (${event.code}): ${event.message}`);
  };
  try { await adb.start(serial, report); }
  catch (error) { deps.io.err(error instanceof AdbError ? error.message : 'Connection failed.'); return 1; }
  deps.io.out('Watching the USB connection and restoring the reverse mapping after replug. Press Ctrl-C to stop.');
  if (!deps.signal.aborted) await new Promise<void>(resolve => deps.signal.addEventListener('abort', () => resolve(), { once: true }));
  await adb.stop();
  deps.io.out('Stopped.');
  return 0;
}

const SERVICE_MESSAGES: Record<string, string> = {
  ABSOLUTE_PATH_REQUIRED: 'Paths must be absolute.',
  UNSAFE_PATH: 'A path contains control characters.',
  CONFIG_DIRECTORY_NAME_UNSUPPORTED: 'The service needs the configuration directory to be named "phone-monitor" (the hub reads XDG_CONFIG_HOME/phone-monitor).',
  HUB_BUILD_MISSING: 'The compiled hub (desktop/dist/main.js) is missing. Run: npm ci && npm run build',
  UNIT_EXISTS_NOT_OWNED: 'A unit file with this name already exists and was not created by LumenDock; it was left untouched.',
  UNIT_MODIFIED: 'The unit file was modified after installation, so it was left untouched (and so was the service state). Restore or remove it yourself, then rerun.',
  UNIT_UNSAFE: 'The unit path is a symlink or not owned by you; refusing to touch it.',
  SERVICE_OWNERSHIP_CONFLICT: 'The recorded service belongs to a different unit directory; pass the same --unit-dir used at install.',
  SERVICE_ENABLE_FAILED: 'systemctl --user enable failed. The unit is installed; check `systemctl --user status`.',
  SERVICE_DISABLE_FAILED: 'systemctl --user disable failed; nothing was removed. Disable it manually or retry.',
  BAD_SERVICE_RECORD: 'The service ownership record is invalid; remove only that record file after checking the unit.',
  CONFIG_BUSY: 'Another install/uninstall is running; retry shortly.',
  UNSAFE_CONFIG_DIRECTORY: 'The configuration directory is not private to your user.'
};
const describeServiceError = (error: unknown): string => {
  const code = error instanceof ServiceError ? error.code : error instanceof Error ? error.message : '';
  return SERVICE_MESSAGES[code] ?? 'The operation failed; no changes were made beyond what is described above.';
};

export interface ServiceCommandDeps {
  io: Io; systemctl: SystemctlRunner; nodePath: string; hubPath: string; configDir: string; unitDir: string; nodeMajor: number; pathEnv?: string;
}
export async function runInstallHubCommand(argv: readonly string[], deps: ServiceCommandDeps): Promise<number> {
  const usage = 'Usage: install-hub [--enable] [--print] [--node PATH] [--config-dir DIR] [--unit-dir DIR]';
  const parsed = parseOptions(argv, { '--enable': 'flag', '--print': 'flag', '--node': 'value', '--config-dir': 'value', '--unit-dir': 'value' });
  if (typeof parsed === 'string') { deps.io.err(`${parsed} ${usage}`); return 2; }
  if (deps.nodeMajor !== 24 && !parsed.values.has('--node')) { deps.io.err('Run this through the Node 24 toolchain or pass --node PATH to a Node 24 executable.'); return 1; }
  const spec = { nodePath: parsed.values.get('--node') ?? deps.nodePath, hubPath: deps.hubPath, configDir: parsed.values.get('--config-dir') ?? deps.configDir, ...(deps.pathEnv ? { pathEnv: deps.pathEnv } : {}) };
  try {
    if (parsed.flags.has('--print')) { deps.io.out(renderUnit(spec)); return 0; }
    const result = await installHubService({ ...spec, unitDir: parsed.values.get('--unit-dir') ?? deps.unitDir, systemctl: deps.systemctl, enable: parsed.flags.has('--enable') });
    deps.io.out(result.changed ? 'Installed the optional user service unit.' : 'The service unit is already installed and unchanged.');
    for (const warning of result.warnings) deps.io.out(`Warning: ${warning}`);
    deps.io.out(result.enabled
      ? `Service enabled and started (systemctl --user status ${SERVICE_NAME}).`
      : `Not enabled or started. To run it at login: systemctl --user enable --now ${SERVICE_NAME}. Or rerun with --enable.`);
    deps.io.out('Pair a phone with the hub in the foreground (`npm run start --workspace @phone-monitor/desktop -- --pair`) before relying on the service.');
    return 0;
  } catch (error) { deps.io.err(describeServiceError(error)); return 1; }
}

export async function runUninstallHubCommand(argv: readonly string[], deps: Pick<ServiceCommandDeps, 'io' | 'systemctl' | 'configDir' | 'unitDir'>): Promise<number> {
  const parsed = parseOptions(argv, { '--config-dir': 'value', '--unit-dir': 'value' });
  if (typeof parsed === 'string') { deps.io.err(`${parsed} Usage: uninstall-hub [--config-dir DIR] [--unit-dir DIR]`); return 2; }
  try {
    const result = await uninstallHubService({ configDir: parsed.values.get('--config-dir') ?? deps.configDir, unitDir: parsed.values.get('--unit-dir') ?? deps.unitDir, systemctl: deps.systemctl });
    deps.io.out(result.changed ? 'Removed the service unit created by LumenDock. Pairing token and other configuration were kept.' : 'No LumenDock service installation was recorded; nothing was changed.');
    for (const warning of result.warnings) deps.io.out(`Warning: ${warning}`);
    return 0;
  } catch (error) { deps.io.err(describeServiceError(error)); return 1; }
}
