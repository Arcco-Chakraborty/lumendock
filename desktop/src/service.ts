import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProcessResult, ProcessRunner } from './adb.js';
import { atomicWrite, ensurePrivateDirectory, readOwnedFile, readPrivateJson, withLock } from './private-files.js';

// Optional, reversible systemd --user service for the hub. Nothing here runs at hub
// startup; the install/uninstall scripts call it only on explicit user request.
// systemctl is always injected, so tests never touch a real user manager.

export const SERVICE_NAME = 'phone-monitor-hub.service';
export type SystemctlRunner = (args: readonly string[]) => Promise<ProcessResult>;
export const systemctlUser = (runner: ProcessRunner): SystemctlRunner => args => runner.exec('systemctl', ['--user', ...args], { timeoutMs: 20_000 });

export function defaultUnitDirectory(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
}

export class ServiceError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ServiceError'; }
}

export interface UnitSpec { nodePath: string; hubPath: string; configDir: string; pathEnv?: string }
const hasControl = (value: string) => /[\u0000-\u001f\u007f]/.test(value);
function checkPath(path: string): void {
  if (!isAbsolute(path)) throw new ServiceError('ABSOLUTE_PATH_REQUIRED');
  if (hasControl(path)) throw new ServiceError('UNSAFE_PATH');
}
// systemd expands %specifiers everywhere and $VARIABLES in command lines.
const quoteBase = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
const quoteExec = (value: string) => `"${quoteBase(value).replaceAll('$', '$$$$')}"`;
const quoteEnv = (value: string) => `"${quoteBase(value)}"`;

export function defaultServicePath(nodePath: string): string {
  return [...new Set([dirname(nodePath), join(homedir(), '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
}

/** The hub reads its config directory from XDG_CONFIG_HOME/phone-monitor (it has no --config-dir flag). */
export function renderUnit(spec: UnitSpec): string {
  for (const path of [spec.nodePath, spec.hubPath, spec.configDir]) checkPath(path);
  if (spec.pathEnv !== undefined && hasControl(spec.pathEnv)) throw new ServiceError('UNSAFE_PATH');
  if (basename(spec.configDir) !== 'phone-monitor') throw new ServiceError('CONFIG_DIRECTORY_NAME_UNSUPPORTED');
  return [
    '# Managed by Phone Monitor (optional service). Uninstall: npm run uninstall-hub',
    '# Editing this file makes uninstall refuse to remove it, so your changes are never lost.',
    '[Unit]',
    'Description=Phone Monitor hub (loopback 127.0.0.1:8765 only)',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quoteExec(spec.nodePath)} ${quoteExec(spec.hubPath)}`,
    `Environment=${quoteEnv(`XDG_CONFIG_HOME=${dirname(spec.configDir)}`)}`,
    `Environment=${quoteEnv(`PATH=${spec.pathEnv ?? defaultServicePath(spec.nodePath)}`)}`,
    'Restart=on-failure',
    'RestartSec=5',
    'NoNewPrivileges=yes',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}

interface ServiceRecord {
  v: 1; phase: 'install_pending' | 'installed' | 'uninstall_pending'; unitPath: string; unitSha256: string;
  previousSha256: string | null; nodePath: string; hubPath: string; configDir: string; enabled: boolean;
}
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const recordPath = (configDir: string) => join(configDir, 'hub-service.json');
function readRecord(configDir: string): ServiceRecord | null {
  const raw = readPrivateJson(recordPath(configDir)) as Partial<ServiceRecord> | null;
  if (raw === null) return null;
  if (raw.v !== 1 || typeof raw.unitPath !== 'string' || typeof raw.unitSha256 !== 'string' || typeof raw.enabled !== 'boolean'
    || !['install_pending', 'installed', 'uninstall_pending'].includes(String(raw.phase))
    || !(raw.previousSha256 === null || typeof raw.previousSha256 === 'string')) throw new ServiceError('BAD_SERVICE_RECORD');
  return raw as ServiceRecord;
}
const saveRecord = (record: ServiceRecord) => atomicWrite(recordPath(record.configDir), JSON.stringify(record));
function readUnit(unitPath: string): Buffer | null {
  if (!existsSync(unitPath) && !isLink(unitPath)) return null;
  if (isLink(unitPath)) throw new ServiceError('UNIT_UNSAFE');
  try { return readOwnedFile(unitPath, 64 * 1024); } catch { throw new ServiceError('UNIT_UNSAFE'); }
}
function isLink(path: string): boolean { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }
const owned = (record: ServiceRecord, digest: string) => digest === record.unitSha256 || (record.phase !== 'installed' && digest === record.previousSha256);

export interface InstallHubOptions extends UnitSpec { unitDir: string; systemctl: SystemctlRunner; enable?: boolean }
export interface InstallHubResult { changed: boolean; enabled: boolean; unitPath: string; warnings: string[] }

export async function installHubService(options: InstallHubOptions): Promise<InstallHubResult> {
  const unit = renderUnit(options);
  checkPath(options.unitDir);
  accessSync(options.nodePath, constants.X_OK);
  try { if (!lstatSync(options.hubPath).isFile()) throw new Error(); accessSync(options.hubPath, constants.R_OK); } catch { throw new ServiceError('HUB_BUILD_MISSING'); }
  const configDir = resolve(options.configDir);
  const unitPath = join(resolve(options.unitDir), SERVICE_NAME);
  ensurePrivateDirectory(configDir);
  mkdirSync(dirname(unitPath), { recursive: true });
  return withLock(join(configDir, 'hub-service.lock'), async () => {
    const warnings: string[] = [];
    const bytes = readUnit(unitPath);
    const digest = sha(unit);
    let record = readRecord(configDir);
    let changed = false;
    if (record === null) {
      if (bytes) throw new ServiceError('UNIT_EXISTS_NOT_OWNED');
    } else {
      if (record.unitPath !== unitPath) throw new ServiceError('SERVICE_OWNERSHIP_CONFLICT');
      if (bytes && !owned(record, sha(bytes))) throw new ServiceError('UNIT_MODIFIED');
    }
    const current = bytes ? sha(bytes) : null;
    if (!(record?.phase === 'installed' && current === digest)) {
      // The pending record is durable before the unit changes, so an interrupted install is recoverable.
      record = { v: 1, phase: 'install_pending', unitPath, unitSha256: digest, previousSha256: current, nodePath: options.nodePath, hubPath: options.hubPath, configDir, enabled: record?.enabled ?? false };
      saveRecord(record);
      atomicWrite(unitPath, unit, 0o644);
      chmodSync(unitPath, 0o644);
      record = { ...record, phase: 'installed', previousSha256: null };
      saveRecord(record);
      changed = true;
      const reload = await options.systemctl(['daemon-reload']);
      if (reload.code !== 0) warnings.push('systemctl --user daemon-reload failed; run it manually before enabling the service.');
    }
    let enabled = record!.enabled;
    if (options.enable) {
      record = { ...record!, enabled: true };
      saveRecord(record); // recorded first so uninstall always attempts the matching disable
      const result = await options.systemctl(['enable', '--now', SERVICE_NAME]);
      if (result.code !== 0) throw new ServiceError('SERVICE_ENABLE_FAILED');
      enabled = true;
    }
    return { changed, enabled, unitPath, warnings };
  });
}

export interface UninstallHubOptions { unitDir: string; configDir: string; systemctl: SystemctlRunner }
export async function uninstallHubService(options: UninstallHubOptions): Promise<{ changed: boolean; warnings: string[] }> {
  const configDir = resolve(options.configDir);
  if (!existsSync(recordPath(configDir))) return { changed: false, warnings: [] };
  ensurePrivateDirectory(configDir);
  return withLock(join(configDir, 'hub-service.lock'), async () => {
    const record = readRecord(configDir);
    if (record === null) return { changed: false, warnings: [] };
    const unitPath = join(resolve(options.unitDir), SERVICE_NAME);
    if (record.unitPath !== unitPath) throw new ServiceError('SERVICE_OWNERSHIP_CONFLICT');
    const bytes = readUnit(unitPath);
    // A modified unit is the user's file now: touch neither it nor the service state.
    if (bytes && !owned(record, sha(bytes))) throw new ServiceError('UNIT_MODIFIED');
    const warnings: string[] = [];
    saveRecord({ ...record, phase: 'uninstall_pending' });
    if (record.enabled) {
      const disabled = await options.systemctl(['disable', '--now', SERVICE_NAME]);
      if (disabled.code !== 0) throw new ServiceError('SERVICE_DISABLE_FAILED');
    }
    if (bytes) unlinkSync(unitPath);
    const reload = await options.systemctl(['daemon-reload']);
    if (reload.code !== 0) warnings.push('systemctl --user daemon-reload failed; run it manually.');
    unlinkSync(recordPath(configDir));
    return { changed: true, warnings };
  });
}
