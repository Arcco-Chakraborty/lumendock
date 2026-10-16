import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UsageSourceSchema } from '@phone-monitor/protocol';
import { CLAUDE_USAGE_URL, CREDENTIAL_RECHECK_MS, RATE_LIMIT_BACKOFF_MS, USAGE_INTERVAL_MS, ClaudeUsagePoller, parseClaudeUsage, readAccessToken, type ClaudeUsageIo } from '../src/collectors/claude-usage.js';
import { ClaudeObservationStore } from '../src/collectors/claude.js';
import { HubCollectors } from '../src/collectors/index.js';
import { HubStore } from '../src/store.js';
import { claudeUsagePollingEnabled } from '../src/config.js';
import { runClaudeUsageCommand } from '../src/claude-usage-cli.js';

// Synthetic sign-in and responses only: nothing here reads Claude Code's real files or reaches the network.
const TOKEN = 'synthetic-access-token-0123456789';
const NOW = 1_800_000_000_000;
const body = {five_hour: {utilization: 42.04, resets_at: new Date(NOW + 3_600_000).toISOString()}, seven_day: {utilization: 13, resets_at: new Date(NOW + 86_400_000).toISOString()}, seven_day_opus: {utilization: 0, resets_at: null}};
function fakeIo(credentials: unknown = {claudeAiOauth: {accessToken: TOKEN, expiresAt: NOW + 3_600_000, refreshToken: 'synthetic-refresh'}}) {
  const requests: Array<{url: string; headers: Record<string, string>}> = [];
  const replies: Array<{status: number; retryAfter?: string; json?: unknown}> = [];
  let creds = credentials;
  const io: ClaudeUsageIo = {
    readCredentials: () => { if (creds === null) throw Error('ENOENT'); return Buffer.from(JSON.stringify(creds)); },
    get: async (url, headers) => {
      requests.push({url, headers});
      const reply = replies.shift() ?? {status: 200, json: body};
      return {status: reply.status, retryAfter: reply.retryAfter ?? null, json: async () => reply.json};
    },
  };
  return {io, requests, replies, setCredentials: (value: unknown) => { creds = value; }};
}

describe('Claude usage polling', () => {
  it('reads only a well-formed access token and its expiry', () => {
    expect(readAccessToken(Buffer.from(JSON.stringify({claudeAiOauth: {accessToken: TOKEN, expiresAt: 5}})))).toEqual({token: TOKEN, expiresAtMs: 5});
    for (const bad of ['not json', '{}', JSON.stringify({claudeAiOauth: {accessToken: 'short'}}), JSON.stringify({claudeAiOauth: {accessToken: `${TOKEN}\r\nX-Injected: 1`}})])
      expect(readAccessToken(Buffer.from(bad))).toBeNull();
  });
  it('maps the response onto the 5-hour and 7-day windows', () => {
    const windows = parseClaudeUsage(body, NOW);
    expect(windows).toEqual([
      {bucketId: 'claude', windowId: 'five_hour', label: 'Session', windowDurationMins: 300, usedPercent: 42, resetsAtEpochSec: (NOW + 3_600_000) / 1000, reportedAtEpochMs: NOW},
      {bucketId: 'claude', windowId: 'seven_day', label: 'Week', windowDurationMins: 10080, usedPercent: 13, resetsAtEpochSec: (NOW + 86_400_000) / 1000, reportedAtEpochMs: NOW},
    ]);
    expect(parseClaudeUsage({five_hour: {utilization: 'x', resets_at: 'never'}}, NOW)[0]).toMatchObject({usedPercent: null, resetsAtEpochSec: null});
    expect(parseClaudeUsage(null, NOW)).toEqual([]);
  });
  it('sends the token only to the usage endpoint and waits between polls', async () => {
    const m = fakeIo();
    const poller = new ClaudeUsagePoller(m.io);
    expect(await poller.maybePoll(NOW)).toBe(true);
    expect(m.requests).toEqual([{url: CLAUDE_USAGE_URL, headers: expect.objectContaining({Authorization: `Bearer ${TOKEN}`, 'anthropic-beta': 'oauth-2025-04-20'})}]);
    expect(JSON.stringify(poller.windows)).not.toContain(TOKEN);
    expect(await poller.maybePoll(NOW + USAGE_INTERVAL_MS - 1)).toBe(false);
    expect(await poller.maybePoll(NOW + USAGE_INTERVAL_MS)).toBe(true);
    expect(m.requests).toHaveLength(2);
  });
  it('never sends an expired or refused token, and keeps the last readings', async () => {
    const m = fakeIo({claudeAiOauth: {accessToken: TOKEN, expiresAt: NOW - 1}});
    const poller = new ClaudeUsagePoller(m.io);
    await poller.maybePoll(NOW);
    expect(m.requests).toHaveLength(0);
    expect(poller.state).toBe('signed_out');
    m.setCredentials({claudeAiOauth: {accessToken: TOKEN, expiresAt: NOW + 3_600_000}});
    await poller.maybePoll(NOW + CREDENTIAL_RECHECK_MS);
    expect(poller.state).toBe('ok');
    m.replies.push({status: 401});
    await poller.maybePoll(NOW + CREDENTIAL_RECHECK_MS + USAGE_INTERVAL_MS);
    expect(poller.state).toBe('rejected');
    expect(poller.windows).toHaveLength(2);
    await poller.maybePoll(NOW + CREDENTIAL_RECHECK_MS * 2 + USAGE_INTERVAL_MS);
    expect(m.requests).toHaveLength(2);
    m.setCredentials({claudeAiOauth: {accessToken: `${TOKEN}-renewed`, expiresAt: NOW + 7_200_000}});
    await poller.maybePoll(NOW + CREDENTIAL_RECHECK_MS * 3 + USAGE_INTERVAL_MS);
    expect(m.requests).toHaveLength(3);
    expect(poller.state).toBe('ok');
  });
  it('backs off when rate limited or the reply is unexpected', async () => {
    const m = fakeIo();
    const poller = new ClaudeUsagePoller(m.io);
    m.replies.push({status: 429, retryAfter: '1800'});
    await poller.maybePoll(NOW);
    expect(poller.state).toBe('rate_limited');
    await poller.maybePoll(NOW + RATE_LIMIT_BACKOFF_MS);
    expect(m.requests).toHaveLength(1);
    await poller.maybePoll(NOW + 1_800_000);
    expect(m.requests).toHaveLength(2);
    m.replies.push({status: 200, json: {unexpected: true}});
    await poller.maybePoll(NOW + 1_800_000 + USAGE_INTERVAL_MS);
    expect(poller.state).toBe('error');
    expect(poller.windows).toHaveLength(2);
  });
});

describe('Claude usage in the hub', () => {
  const statusLine = (used: number) => ({session_id: 'synthetic-session', cost: {total_api_duration_ms: used}, rate_limits: {five_hour: {used_percentage: used, resets_at: Math.floor((NOW + 3_600_000) / 1000)}}});
  it('publishes polled usage with no Claude session, and prefers the newer reading per window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phone-monitor-claude-usage-'));
    let now = NOW, enabled = true, watching = true;
    const m = fakeIo();
    const store = new HubStore();
    const collectors = new HubCollectors({store, configDir: dir, nowMs: () => now, claudeUsage: {poller: new ClaudeUsagePoller(m.io), active: () => watching, enabled: () => enabled}});
    await collectors.refresh();
    const polled = store.snapshot(now).usage.claude;
    expect(UsageSourceSchema.safeParse(polled).success).toBe(true);
    expect(polled).toMatchObject({source: 'claude_usage_api', state: 'available', stale: false});
    expect(polled.windows.map(w => w.usedPercent)).toEqual([42, 13]);

    // A later status-line report wins for its own window only.
    now += 60_000;
    const observations = new ClaudeObservationStore(dir);
    await observations.capture(statusLine(49), now - 1000);
    await observations.capture(statusLine(50), now);
    await collectors.refresh();
    const merged = store.snapshot(now).usage.claude;
    expect(merged.source).toBe('claude_statusline');
    expect(merged.windows.map(w => w.usedPercent)).toEqual([50, 13]);

    // Still current hours later: the phone is not shown a false "stale".
    now += 2 * 3_600_000 - 60_000 - 1;
    watching = false;
    await collectors.refresh();
    expect(store.snapshot(now).usage.claude.stale).toBe(false);
    expect(m.requests).toHaveLength(1);

    // Turning it off drops the polled readings; the status line's own window stays.
    enabled = false;
    now += 5000;
    await collectors.refresh();
    expect(store.snapshot(now).usage.claude.windows.map(w => w.windowId)).toEqual(['five_hour']);
  });
  it('asks for a Claude sign-in when polling is on but there is none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phone-monitor-claude-usage-'));
    const store = new HubStore();
    const collectors = new HubCollectors({store, configDir: dir, nowMs: () => NOW, claudeUsage: {poller: new ClaudeUsagePoller(fakeIo(null).io), active: () => true, enabled: () => true}});
    await collectors.refresh();
    expect(store.snapshot(NOW).usage.claude).toMatchObject({state: 'auth_required', errorCode: 'AUTH_REQUIRED'});
  });
  it('is off by default and switched with the claude-usage command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phone-monitor-claude-usage-'));
    const lines: string[] = [];
    expect(claudeUsagePollingEnabled(dir)).toBe(false);
    expect(await runClaudeUsageCommand(['claude-usage', 'on'], dir, l => lines.push(l), join(dir, 'missing.json'))).toBe(0);
    expect(claudeUsagePollingEnabled(dir)).toBe(true);
    expect(lines.join('\n')).toContain('not signed in');
    expect(await runClaudeUsageCommand(['claude-usage', 'off'], dir, l => lines.push(l))).toBe(0);
    expect(claudeUsagePollingEnabled(dir)).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual({claudeUsagePolling: false});
    expect(await runClaudeUsageCommand(['claude-usage', 'maybe'], dir, l => lines.push(l))).toBe(2);
  });
});
