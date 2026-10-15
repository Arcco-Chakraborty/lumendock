import { constants, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { atomicWrite, ensurePrivateDirectory, readPrivateJson, withLock } from './private-files.js';

const tokenPattern = /^[a-f0-9]{64}$/;
export function defaultConfigDirectory(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(),'.config'),'phone-monitor');
}
export class TokenStore {
  readonly directory: string;
  private readonly path: string;
  constructor(directory = defaultConfigDirectory()) {
    this.directory = resolve(directory);
    this.path = join(this.directory,'phone-token');
  }
  private ensureDirectory(create: boolean): boolean {
    if (!existsSync(this.directory)) {
      if (!create) return false;
      mkdirSync(this.directory,{recursive:true,mode:0o700});
    }
    const info = lstatSync(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('UNSAFE_CONFIG_DIRECTORY');
    chmodSync(this.directory,0o700);
    return true;
  }
  read(): string | null {
    if (!this.ensureDirectory(false)) return null;
    let fd: number;
    try { fd = openSync(this.path,constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('BAD_TOKEN_FILE'); }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.size > 65) throw new Error('BAD_TOKEN_FILE');
      // A read from a legacy permissive file repairs only this product's file.
      if ((info.mode & 0o777) !== 0o600) chmodSync(this.path,0o600);
      const token = readFileSync(fd,'utf8').trim();
      if (!tokenPattern.test(token)) throw new Error('BAD_TOKEN_FILE');
      return token;
    } finally { closeSync(fd); }
  }
  write(token: string): void {
    if (!tokenPattern.test(token)) throw new Error('BAD_TOKEN_FILE');
    this.ensureDirectory(true);
    const temporary = join(this.directory,`.phone-token-${randomBytes(12).toString('hex')}`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
      writeFileSync(fd,`${token}\n`,'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      // rename is the only commit point: any previous token stays intact until
      // the fully written private replacement exists.
      renameSync(temporary,this.path);
    } catch {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* No temporary file may exist. */ }
      throw new Error('TOKEN_PERSIST_FAILED');
    }
  }
  matchesBearer(header: string | undefined): boolean {
    if (!header || !/^Bearer [a-f0-9]{64}$/.test(header)) return false;
    let token: string | null;
    try { token = this.read(); } catch { return false; }
    if (token === null) return false;
    return timingSafeEqual(Buffer.from(header.slice(7),'hex'),Buffer.from(token,'hex'));
  }
}

// Notification allowlist: one key of this app's private config.json. Labels are
// privacy filters that also reach a D-Bus match expression, so the charset is
// deliberately narrow (no quote, comma, backslash, control or non-ASCII).
export const MAX_NOTIFICATION_APPS = 10;
const labelPattern = /^[A-Za-z0-9 _.:-]{1,80}$/;
export function isValidNotificationLabel(label: unknown): label is string {
  return typeof label === 'string' && labelPattern.test(label) && label.trim() === label && label.length > 0;
}
const configFile = (directory: string) => join(resolve(directory),'config.json');
function readConfigObject(directory: string): Record<string,unknown> {
  let raw: unknown;
  try { raw = readPrivateJson(configFile(directory)); } catch { throw new Error('BAD_CONFIG'); }
  if (raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('BAD_CONFIG');
  return raw as Record<string,unknown>;
}
function labelsOf(config: Record<string,unknown>): string[] {
  const value = config.notificationAllowlist;
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const item of value) if (isValidNotificationLabel(item) && !labels.includes(item) && labels.length < MAX_NOTIFICATION_APPS) labels.push(item);
  return labels;
}
export function listNotificationApps(directory = defaultConfigDirectory()): string[] { return labelsOf(readConfigObject(directory)); }
async function updateAllowlist(directory: string, change: (labels: string[]) => string[]): Promise<string[]> {
  const dir = resolve(directory);
  ensurePrivateDirectory(dir);
  return withLock(join(dir,'config.lock'),() => {
    const config = readConfigObject(dir);
    const labels = change(labelsOf(config));
    if (labels.join('\0') !== labelsOf(config).join('\0') || !Array.isArray(config.notificationAllowlist)) atomicWrite(configFile(dir),`${JSON.stringify({...config,notificationAllowlist:labels},null,2)}\n`);
    return labels;
  });
}
export async function allowNotificationApp(directory: string, label: string): Promise<string[]> {
  if (!isValidNotificationLabel(label)) throw new Error('BAD_APP_LABEL');
  return updateAllowlist(directory,labels => {
    if (labels.includes(label)) return labels;
    if (labels.length >= MAX_NOTIFICATION_APPS) throw new Error('ALLOWLIST_FULL');
    return [...labels,label];
  });
}
export async function removeNotificationApp(directory: string, label: string): Promise<string[]> {
  if (!isValidNotificationLabel(label)) throw new Error('BAD_APP_LABEL');
  return updateAllowlist(directory,labels => labels.filter(item => item !== label));
}
