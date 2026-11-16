import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarConnectionStore } from '../src/calendar/connection.js';
import {
  CALENDAR_SCOPES,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  authorizeCalendarClient,
  openSystemBrowser,
  parseCalendarClient,
  readCalendarClientFile,
  refreshCalendarTokens,
} from '../src/calendar/oauth.js';
import { runCalendarCommand } from '../src/calendar/cli.js';

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-cal-oauth-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Google Calendar Desktop OAuth and CLI', () => {
  it('parses Desktop OAuth client JSON while ignoring embedded endpoint URLs', () => {
    const parsed = parseCalendarClient({
      installed: {
        client_id: 'synthetic-client-id.apps.googleusercontent.com',
        client_secret: 'synthetic-client-secret',
        auth_uri: 'https://evil.example/auth',
        token_uri: 'https://evil.example/token',
      },
    });
    expect(parsed).toEqual({
      clientId: 'synthetic-client-id.apps.googleusercontent.com',
      clientSecret: 'synthetic-client-secret',
    });
    expect(() => parseCalendarClient({ web: { client_id: 'synthetic-web' } })).toThrow('CALENDAR_CLIENT_INVALID');
    expect(() => parseCalendarClient({})).toThrow('CALENDAR_CLIENT_INVALID');
  });

  it('completes loopback OAuth with PKCE S256, state, offline access, and exact 3 scopes', async () => {
    let capturedAuthUrl: URL | null = null;
    let capturedTokenUrl = '';
    let capturedTokenBody: URLSearchParams | null = null;

    const fakeFetch: typeof globalThis.fetch = async (input, init) => {
      capturedTokenUrl = String(input);
      capturedTokenBody = new URLSearchParams(String(init?.body ?? ''));
      return new Response(
        JSON.stringify({
          access_token: 'synthetic-access-token-1',
          refresh_token: 'synthetic-refresh-token-1',
          expires_in: 3600,
          scope: CALENDAR_SCOPES.join(' '),
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const tokens = await authorizeCalendarClient({
      client: { clientId: 'synthetic-id', clientSecret: 'synthetic-secret' },
      nowMs: () => 1_700_000_000_000,
      fetch: fakeFetch,
      openBrowser: async (url) => {
        capturedAuthUrl = new URL(url);
        const redirectUri = capturedAuthUrl.searchParams.get('redirect_uri')!;
        const state = capturedAuthUrl.searchParams.get('state')!;
        expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
        // Browser favicon request must not abort the callback listener
        const fav = await fetch(new URL('/favicon.ico', redirectUri));
        expect(fav.status).toBe(404);
        const cb = await fetch(`${redirectUri}?code=synthetic-auth-code&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(CALENDAR_SCOPES.join(' '))}`);
        expect(cb.status).toBe(200);
        const text = await cb.text();
        expect(text).not.toContain('synthetic-auth-code');
      },
    });

    expect(capturedAuthUrl).not.toBeNull();
    expect(`${capturedAuthUrl!.origin}${capturedAuthUrl!.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect(capturedAuthUrl!.searchParams.get('access_type')).toBe('offline');
    expect(capturedAuthUrl!.searchParams.get('prompt')).toBe('consent');
    expect(capturedAuthUrl!.searchParams.get('code_challenge_method')).toBe('S256');
    expect(capturedAuthUrl!.searchParams.get('scope')?.split(' ')).toEqual([...CALENDAR_SCOPES]);

    expect(capturedTokenUrl).toBe(GOOGLE_TOKEN_URL);
    const verifier = capturedTokenBody!.get('code_verifier')!;
    const expectedChallenge = createHash('sha256').update(verifier).digest('base64url');
    expect(capturedAuthUrl!.searchParams.get('code_challenge')).toBe(expectedChallenge);
    expect(capturedTokenBody!.get('code')).toBe('synthetic-auth-code');
    expect(tokens).toEqual({
      accessToken: 'synthetic-access-token-1',
      refreshToken: 'synthetic-refresh-token-1',
      expiresAt: 1_700_003_600_000,
    });
  });

  it('rejects state mismatch, cancellation, timeout, and partial scope grants without leaking secrets', async () => {
    const client = { clientId: 'synthetic-id', clientSecret: 'synthetic-secret-do-not-leak' };

    // 1. State mismatch
    await expect(
      authorizeCalendarClient({
        client,
        fetch: async () => new Response('{}', { status: 500 }),
        openBrowser: async (url) => {
          const redirectUri = new URL(url).searchParams.get('redirect_uri')!;
          const res = await fetch(`${redirectUri}?code=synthetic-code&state=wrong-state`);
          expect(res.status).toBe(400);
        },
      }),
    ).rejects.toThrow('CALENDAR_OAUTH_STATE_MISMATCH');

    // 2. User cancellation
    await expect(
      authorizeCalendarClient({
        client,
        fetch: async () => new Response('{}', { status: 500 }),
        openBrowser: async (url) => {
          const parsed = new URL(url);
          const redirectUri = parsed.searchParams.get('redirect_uri')!;
          const state = parsed.searchParams.get('state')!;
          const res = await fetch(`${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`);
          expect(res.status).toBe(400);
        },
      }),
    ).rejects.toThrow('CALENDAR_OAUTH_CANCELLED');

    // 3. Timeout
    await expect(
      authorizeCalendarClient({
        client,
        timeoutMs: 40,
        fetch: async () => new Response('{}', { status: 500 }),
        openBrowser: async () => {
          // Do not hit callback
        },
      }),
    ).rejects.toThrow('CALENDAR_OAUTH_TIMEOUT');

    // 4. Partial grant in token response (missing calendars.readonly)
    await expect(
      authorizeCalendarClient({
        client,
        fetch: async () =>
          new Response(
            JSON.stringify({
              access_token: 'synthetic-access',
              refresh_token: 'synthetic-refresh',
              expires_in: 3600,
              scope: CALENDAR_SCOPES.slice(0, 2).join(' '),
            }),
            { status: 200 },
          ),
        openBrowser: async (url) => {
          const parsed = new URL(url);
          const redirectUri = parsed.searchParams.get('redirect_uri')!;
          const state = parsed.searchParams.get('state')!;
          await fetch(`${redirectUri}?code=synthetic-code&state=${encodeURIComponent(state)}`);
        },
      }),
    ).rejects.toThrow('CALENDAR_PARTIAL_GRANT');
  });

  it('refreshes tokens with generation checks, preserves omitted refreshToken, and invalidates on invalid_grant', async () => {
    const dir = tempDir();
    const storeA = new CalendarConnectionStore(dir);
    const storeB = new CalendarConnectionStore(dir);

    const gen = await storeA.beginConnect();
    await storeA.finishConnect(
      gen,
      { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
      { accessToken: 'old-access', refreshToken: 'kept-refresh', expiresAt: 1000 },
    );

    // Refresh omits refresh_token -> preserves existing refreshToken
    const refreshed = await refreshCalendarTokens({
      store: storeB,
      generation: gen,
      nowMs: () => 2000,
      fetch: async () =>
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            expires_in: 1800,
            scope: CALENDAR_SCOPES.join(' '),
          }),
          { status: 200 },
        ),
    });
    expect(refreshed).toEqual({
      accessToken: 'new-access',
      refreshToken: 'kept-refresh',
      expiresAt: 1_802_000,
    });
    expect(storeA.credentials(gen)?.tokens).toEqual(refreshed);

    // Disconnect during in-flight refresh cannot recreate credentials
    await expect(
      refreshCalendarTokens({
        store: storeA,
        generation: gen,
        nowMs: () => 3000,
        fetch: async () => {
          await storeB.disconnect();
          return new Response(
            JSON.stringify({
              access_token: 'late-access',
              expires_in: 1800,
              scope: CALENDAR_SCOPES.join(' '),
            }),
            { status: 200 },
          );
        },
      }),
    ).rejects.toThrow('CALENDAR_SELECTION_CHANGED');
    expect(storeA.read().connected).toBe(false);
    expect(existsSync(join(dir, 'calendar', 'tokens.json'))).toBe(false);

    // Reconnect and test invalid_grant -> invalidates connection and sets authRequired
    const gen2 = await storeA.beginConnect();
    await storeA.finishConnect(
      gen2,
      { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
      { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: 1000 },
    );
    await expect(
      refreshCalendarTokens({
        store: storeB,
        generation: gen2,
        nowMs: () => 4000,
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'Token has been expired or revoked: secret-detail',
            }),
            { status: 400 },
          ),
      }),
    ).rejects.toThrow('CALENDAR_AUTH_REQUIRED');
    expect(storeA.read()).toMatchObject({ connected: false, authRequired: true });
    expect(storeA.credentials(gen2)).toBeNull();
  });

  it('implements calendar CLI connect, status, disconnect, and help without claiming events are already imported', async () => {
    const dir = tempDir();
    const clientPath = join(dir, 'client.json');
    writeFileSync(
      clientPath,
      JSON.stringify({
        installed: { client_id: 'synthetic-cli-client', client_secret: 'synthetic-cli-secret' },
      }),
      { mode: 0o600 },
    );
    expect(readCalendarClientFile(clientPath).clientId).toBe('synthetic-cli-client');

    const lines: string[] = [];
    const out = (line: string) => lines.push(line);

    // Help
    expect(await runCalendarCommand(['calendar', 'help'], dir, { out })).toBe(0);
    expect(lines.join('\n')).toContain('calendar connect --client FILE');
    lines.length = 0;

    // Status when disconnected
    expect(await runCalendarCommand(['calendar', 'status'], dir, { out })).toBe(0);
    expect(lines.join('\n')).toMatch(/disconnected|not connected/i);
    lines.length = 0;

    // Connect
    const exit = await runCalendarCommand(['calendar', 'connect', '--client', clientPath], dir, {
      out,
      authorize: async () => ({
        accessToken: 'synthetic-cli-access',
        refreshToken: 'synthetic-cli-refresh',
        expiresAt: 9_999_999,
      }),
    });
    expect(exit).toBe(0);
    const connectOutput = lines.join('\n');
    expect(connectOutput).toContain('Agenda');
    expect(connectOutput).not.toContain('synthetic-cli-access');
    expect(connectOutput).not.toMatch(/events imported/i);
    lines.length = 0;

    // Status when setup_required
    expect(await runCalendarCommand(['calendar', 'status'], dir, { out })).toBe(0);
    expect(lines.join('\n')).toMatch(/Agenda|choose|select/i);
    lines.length = 0;

    // Disconnect
    expect(await runCalendarCommand(['calendar', 'disconnect'], dir, { out })).toBe(0);
    expect(lines.join('\n')).toMatch(/disconnected|removed/i);
    expect(new CalendarConnectionStore(dir).read().connected).toBe(false);
  });

  it('launches platform browser safely and fails closed when Windows ACL protection fails', async () => {
    const launched: Array<[string, string[]]> = [];
    const authUrl = `${GOOGLE_AUTH_URL}?client_id=synthetic`;
    await openSystemBrowser(authUrl, {
      platform: 'linux',
      launch: async (cmd, args) => {
        launched.push([cmd, args]);
        return true;
      },
    });
    await openSystemBrowser(authUrl, {
      platform: 'win32',
      launch: async (cmd, args) => {
        launched.push([cmd, args]);
        return true;
      },
    });
    expect(launched).toEqual([
      ['xdg-open', [authUrl]],
      ['rundll32.exe', ['url.dll,FileProtocolHandler', authUrl]],
    ]);
    await expect(openSystemBrowser('https://evil.example/auth')).rejects.toThrow('CALENDAR_OAUTH_FAILED');

    const dir = tempDir();
    const clientPath = join(dir, 'client.json');
    writeFileSync(clientPath, JSON.stringify({ installed: { client_id: 'synthetic-win' } }), { mode: 0o600 });
    const winStore = new CalendarConnectionStore(dir, {
      platform: 'win32',
      protectWindows: () => {
        throw Error('ACL');
      },
    });
    const lines: string[] = [];
    const exit = await runCalendarCommand(['calendar', 'connect', '--client', clientPath], dir, {
      out: (l) => lines.push(l),
      store: winStore,
      authorize: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: 1000 }),
    });
    expect(exit).toBe(1);
    expect(lines.join('\n')).toMatch(/ACL|Private calendar storage/i);
  });
});
