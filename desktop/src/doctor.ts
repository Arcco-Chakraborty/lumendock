import { AdbError, ensureAdbServer, maskSerial, parseAdbDevices, selectDevice, nodeRunner, type ProcessRunner } from './adb.js';
import { CODEX_COMPATIBLE_VERSION } from './collectors/codex.js';

// Read-only environment report. Shareable output never contains device serials
// (masked unless showSerial), account identities, tokens or filesystem paths.

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface DoctorCheck { id: string; label: string; status: CheckStatus; version?: string; detail?: string }
export interface DoctorDevice { index: number; serialMasked: string; serial?: string; model?: string }
export interface DoctorDeviceDetails { model: string | null; androidRelease: string | null; apiLevel: string | null; miuiVersion: string | null }
export interface DoctorReport {
  v: 1; ok: boolean; checks: DoctorCheck[];
  devices: { authorizedUsb: DoctorDevice[]; unauthorized: number; offline: number; wirelessIgnored: number; otherIgnored: number; selected?: DoctorDeviceDetails };
  notes: string[];
}
export interface DoctorInput {
  nodeVersion: string; env: Record<string, string | undefined>; toolchain?: { jdk?: string; sdk?: string };
  artifacts: { hub: boolean; apk: boolean }; fileExists: (path: string) => boolean; listDir: (path: string) => string[];
  runner?: ProcessRunner; adbPath?: string; showSerial?: boolean; selectedSerial?: string; codexPath?: string;
}

const REQUIRED_JDK = 17;
const REQUIRED_PLATFORM = 'android-36';

async function probe(runner: ProcessRunner, file: string, args: string[]): Promise<string | null> {
  try {
    const result = await runner.exec(file, args, { timeoutMs: 10_000 });
    return result.code === 0 ? `${result.stdout}\n${result.stderr}` : null;
  } catch { return null; }
}
const firstMatch = (text: string | null, pattern: RegExp): string | null => text?.match(pattern)?.[1] ?? null;

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const runner = input.runner ?? nodeRunner;
  const adbPath = input.adbPath ?? 'adb';
  const checks: DoctorCheck[] = [];
  const notes: string[] = [];

  const nodeMajor = Number(input.nodeVersion.split('.')[0]);
  checks.push({ id: 'node', label: 'Node.js', status: nodeMajor === 24 ? 'ok' : 'fail', version: input.nodeVersion, ...(nodeMajor === 24 ? {} : { detail: 'Node 24 is required (see .nvmrc); system defaults are never changed.' }) });

  const javaHome = input.env.JAVA_HOME || input.toolchain?.jdk;
  const javaOutput = await probe(runner, javaHome ? `${javaHome}/bin/java` : 'java', ['-version']);
  const javaRaw = firstMatch(javaOutput, /version "([^"]+)"/);
  const javaMajor = javaRaw ? Number(javaRaw.startsWith('1.') ? javaRaw.split('.')[1] : javaRaw.split(/[.+_-]/)[0]) : null;
  const hasJavac = javaHome ? input.fileExists(`${javaHome}/bin/javac`) : true;
  checks.push({
    id: 'jdk', label: 'JDK (Android build only)', status: javaMajor === REQUIRED_JDK && hasJavac ? 'ok' : 'warn',
    ...(javaRaw ? { version: javaRaw } : {}),
    ...(javaMajor === REQUIRED_JDK && hasJavac ? {} : { detail: `JDK ${REQUIRED_JDK} with javac is needed only to build the Android app; set JAVA_HOME or .superpowers/toolchain.json.` })
  });

  const sdk = input.env.ANDROID_HOME || input.toolchain?.sdk;
  const platform = sdk ? input.fileExists(`${sdk}/platforms/${REQUIRED_PLATFORM}`) : false;
  let buildTools: string | null = null;
  if (sdk) { try { buildTools = input.listDir(`${sdk}/build-tools`).filter(name => /^36\.\d+\.\d+$/.test(name)).sort().at(-1) ?? null; } catch { buildTools = null; } }
  checks.push({
    id: 'android-sdk', label: 'Android SDK (build only)', status: platform && buildTools ? 'ok' : 'warn',
    ...(platform && buildTools ? { version: `${REQUIRED_PLATFORM}, build-tools ${buildTools}` } : { detail: `Android SDK platform ${REQUIRED_PLATFORM} and build-tools 36 are needed only to build the app; set ANDROID_HOME.` })
  });

  const adbOutput = await probe(runner, adbPath, ['version']);
  const adbVersion = firstMatch(adbOutput, /^Version (\S+)/m) ?? firstMatch(adbOutput, /Android Debug Bridge version (\S+)/);
  checks.push({ id: 'adb', label: 'adb', status: adbOutput ? 'ok' : 'fail', ...(adbVersion ? { version: adbVersion } : { detail: 'adb was not found; install Android platform-tools.' }) });

  const claudeVersion = firstMatch(await probe(runner, 'claude', ['--version']), /(\d+\.\d+\.\d+)/);
  checks.push({ id: 'claude', label: 'Claude Code', status: claudeVersion ? 'ok' : 'warn', ...(claudeVersion ? { version: claudeVersion } : { detail: 'Not found; Claude usage will show as unavailable.' }) });
  const codexVersion = firstMatch(await probe(runner, input.codexPath ?? 'codex', ['--version']), /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
  const codexCompatible = codexVersion !== null && CODEX_COMPATIBLE_VERSION.endsWith(codexVersion);
  checks.push({
    id: 'codex', label: 'Codex CLI', status: codexVersion ? 'ok' : 'warn',
    ...(codexVersion ? { version: codexVersion } : { detail: 'Not found on PATH, in config.json codexPath, PHONE_MONITOR_CODEX or the VS Code extension; Codex usage will show as unavailable.' }),
    ...(codexVersion && !codexCompatible ? { detail: 'Differs from the verified version; the collector may report the data source as unsupported.' } : {})
  });
  checks.push({ id: 'hub-build', label: 'Desktop hub build', status: input.artifacts.hub ? 'ok' : 'warn', ...(input.artifacts.hub ? {} : { detail: 'Run npm ci && npm run build.' }) });
  checks.push({ id: 'apk-build', label: 'Android debug APK', status: input.artifacts.apk ? 'ok' : 'warn', ...(input.artifacts.apk ? {} : { detail: 'Not built yet (optional for laptop-only checks).' }) });

  const devices: DoctorReport['devices'] = { authorizedUsb: [], unauthorized: 0, offline: 0, wirelessIgnored: 0, otherIgnored: 0 };
  if (adbOutput) {
    // A real run starts the adb server detached first, so the listing cannot hang on its pipes.
    if (!input.runner) await ensureAdbServer(adbPath);
    const listing = await probe(runner, adbPath, ['devices', '-l']);
    const parsed = listing ? parseAdbDevices(listing) : [];
    for (const device of parsed) {
      if (device.transport === 'wireless') devices.wirelessIgnored++;
      else if (device.transport !== 'usb') devices.otherIgnored++;
      else if (device.state === 'device') {
        devices.authorizedUsb.push({ index: devices.authorizedUsb.length + 1, serialMasked: maskSerial(device.serial), ...(input.showSerial ? { serial: device.serial } : {}), ...(device.model ? { model: device.model } : {}) });
      } else if (device.state === 'unauthorized') devices.unauthorized++;
      else devices.offline++;
    }
    if (input.selectedSerial !== undefined) {
      try {
        const device = selectDevice(parsed, input.selectedSerial);
        const prop = async (name: string) => (await probe(runner, adbPath, ['-s', device.serial, 'shell', 'getprop', name]))?.trim() || null;
        devices.selected = {
          model: await prop('ro.product.model'), androidRelease: await prop('ro.build.version.release'),
          apiLevel: await prop('ro.build.version.sdk'), miuiVersion: await prop('ro.miui.ui.version.name')
        };
      } catch (error) { notes.push(error instanceof AdbError ? error.message : 'The selected device could not be inspected.'); }
    }
    if (devices.authorizedUsb.length === 0) notes.push('No authorized physical USB device is attached; physical-device checks are UNRUN.');
    if (devices.unauthorized > 0) notes.push('A USB device is unauthorized: unlock the phone and tap "Allow USB debugging".');
    if (devices.wirelessIgnored > 0) notes.push('Wireless adb devices are ignored; this product uses a USB cable only.');
  }
  return { v: 1, ok: !checks.some(check => check.status === 'fail'), checks, devices, notes };
}

export function formatDoctorText(report: DoctorReport): string {
  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const;
  const lines = ['LumenDock doctor', ''];
  for (const check of report.checks) lines.push(`[${mark[check.status]}] ${check.label}${check.version ? `: ${check.version}` : ''}${check.detail ? ` - ${check.detail}` : ''}`);
  lines.push('', `USB devices (authorized, physical): ${report.devices.authorizedUsb.length}`);
  for (const device of report.devices.authorizedUsb) lines.push(`  #${device.index} ${device.serial ?? device.serialMasked}${device.model ? ` (${device.model})` : ''}`);
  lines.push(`Other: unauthorized ${report.devices.unauthorized}, offline/not ready ${report.devices.offline}, wireless ignored ${report.devices.wirelessIgnored}, non-USB ignored ${report.devices.otherIgnored}`);
  const selected = report.devices.selected;
  if (selected) lines.push(`Selected device: model ${selected.model ?? 'unknown'}, Android ${selected.androidRelease ?? 'unknown'} (API ${selected.apiLevel ?? 'unknown'}), MIUI ${selected.miuiVersion ?? 'n/a'}`);
  for (const note of report.notes) lines.push(`Note: ${note}`);
  lines.push('', 'Serials are masked unless --show-serial is given; do not share unmasked output.');
  return lines.join('\n');
}
