import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageWindow } from '@phone-monitor/protocol';
import { readOwnedFile } from '../private-files.js';

// Opt-in: asks Anthropic for the account's usage with the sign-in Claude Code already
// keeps on this laptop, so the numbers update with no Claude session open. Only the
// access token and its expiry are read; the token is never refreshed, stored, logged
// or sent anywhere but this request. An expired token waits for Claude Code to renew it.
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const USAGE_INTERVAL_MS = 180_000;
export const RATE_LIMIT_BACKOFF_MS = 900_000;
export const ERROR_BACKOFF_MS = 300_000;
export const CREDENTIAL_RECHECK_MS = 60_000;

export interface UsageResponse {status: number; retryAfter: string | null; json(): Promise<unknown>}
export interface ClaudeUsageIo {
  /** Bytes of Claude Code's credentials file; throws when it is missing or unsafe. */
  readCredentials(): Buffer;
  get(url: string, headers: Record<string, string>): Promise<UsageResponse>;
}
export const claudeCredentialsPath = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
export const defaultUsageIo = (path = claudeCredentialsPath()): ClaudeUsageIo => ({
  readCredentials: () => readOwnedFile(path, 64 * 1024),
  get: async (url, headers) => {
    const response = await fetch(url, {headers, redirect: 'error', signal: AbortSignal.timeout(10_000)});
    return {status: response.status, retryAfter: response.headers.get('retry-after'), json: () => response.json()};
  },
});

/** The token and its expiry, or null when Claude Code is signed out or the file is unreadable. */
export function readAccessToken(bytes: Buffer): {token: string; expiresAtMs: number | null} | null {
  try {
    const oauth = (JSON.parse(bytes.toString('utf8')) as {claudeAiOauth?: {accessToken?: unknown; expiresAt?: unknown}}).claudeAiOauth;
    const token = oauth?.accessToken;
    // Printable ASCII only, so it can never break out of the header line.
    if (typeof token !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(token)) return null;
    return {token, expiresAtMs: typeof oauth?.expiresAt === 'number' && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null};
  } catch { return null; }
}

const WINDOWS = [['five_hour', 'Session', 300], ['seven_day', 'Week', 10080]] as const;
const resetSeconds = (value: unknown): number | null => {
  const ms = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value * 1000 : NaN;
  return Number.isFinite(ms) && ms > 0 && ms <= 253402300799000 ? Math.floor(ms / 1000) : null;
};
/** Maps the response's `utilization` (0-100) and `resets_at` onto the same two windows the status line reports. */
export function parseClaudeUsage(body: unknown, reportedAtEpochMs: number): UsageWindow[] {
  const data = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
  const windows: UsageWindow[] = [];
  for (const [key, label, minutes] of WINDOWS) {
    const raw = data[key];
    if (raw === null || typeof raw !== 'object') continue;
    const window = raw as Record<string, unknown>;
    const used = typeof window.utilization === 'number' && Number.isFinite(window.utilization) ? Math.max(0, window.utilization) : null;
    windows.push({bucketId: 'claude', windowId: key, label, windowDurationMins: minutes, usedPercent: used === null ? null : Math.round(used * 10) / 10, resetsAtEpochSec: resetSeconds(window.resets_at), reportedAtEpochMs});
  }
  return windows;
}

export type ClaudeUsageState = 'off' | 'waiting' | 'ok' | 'signed_out' | 'rejected' | 'rate_limited' | 'error';
export class ClaudeUsagePoller {
  windows: UsageWindow[] = [];
  state: ClaudeUsageState = 'off';
  private nextAtMs = 0;
  private busy = false;
  /** Hash of a token the service refused, so it is not retried until Claude Code replaces it. */
  private rejected: string | null = null;
  constructor(private readonly io: ClaudeUsageIo = defaultUsageIo(), private readonly userAgent = 'LumenDock') {}

  /** Polls when one is due; returns true when the readings changed. */
  async maybePoll(nowMs: number): Promise<boolean> {
    if (this.busy || nowMs < this.nextAtMs) return false;
    this.busy = true;
    try { return await this.poll(nowMs); } finally { this.busy = false; }
  }
  private async poll(nowMs: number): Promise<boolean> {
    let credentials: ReturnType<typeof readAccessToken> = null;
    try { credentials = readAccessToken(this.io.readCredentials()); } catch { credentials = null; }
    const hash = credentials ? createHash('sha256').update(credentials.token).digest('hex') : null;
    if (!credentials || (credentials.expiresAtMs !== null && credentials.expiresAtMs <= nowMs) || hash === this.rejected) {
      // Nothing to send: look again shortly, after Claude Code may have signed in or renewed the token.
      this.state = credentials && hash === this.rejected ? 'rejected' : 'signed_out';
      this.nextAtMs = nowMs + CREDENTIAL_RECHECK_MS;
      return false;
    }
    this.rejected = null;
    try {
      const response = await this.io.get(CLAUDE_USAGE_URL, {
        Authorization: `Bearer ${credentials.token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json', 'User-Agent': this.userAgent,
      });
      if (response.status === 401 || response.status === 403) {
        this.rejected = hash; this.state = 'rejected'; this.nextAtMs = nowMs + CREDENTIAL_RECHECK_MS; return false;
      }
      if (response.status === 429) {
        const seconds = Number(response.retryAfter);
        this.state = 'rate_limited';
        this.nextAtMs = nowMs + Math.max(RATE_LIMIT_BACKOFF_MS, Number.isFinite(seconds) ? seconds * 1000 : 0);
        return false;
      }
      if (response.status !== 200) throw Error('UNEXPECTED_STATUS');
      const windows = parseClaudeUsage(await response.json(), nowMs);
      if (!windows.length) throw Error('UNEXPECTED_BODY');
      this.windows = windows; this.state = 'ok'; this.nextAtMs = nowMs + USAGE_INTERVAL_MS;
      return true;
    } catch {
      this.state = 'error'; this.nextAtMs = nowMs + ERROR_BACKOFF_MS; return false;
    }
  }
  /** Turning polling off forgets every reading and schedule. */
  reset(): void { this.windows = []; this.state = 'off'; this.nextAtMs = 0; this.rejected = null; }
}
