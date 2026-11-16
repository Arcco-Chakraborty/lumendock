import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { AddressInfo, Socket } from 'node:net';
import { readOwnedFile } from '../private-files.js';
import type { CalendarClient, CalendarConnectionStore, CalendarTokens } from './connection.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.calendars.readonly',
] as const;

const SAFE_ASCII = /^[\x21-\x7e]{1,4096}$/;
const SAFE_CLIENT_FIELD = /^[\x21-\x7e]{1,512}$/;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_OAUTH_TIMEOUT_MS = 120_000;

export function parseCalendarClient(raw: unknown): CalendarClient {
  if (raw === null || typeof raw !== 'object') throw Error('CALENDAR_CLIENT_INVALID');
  const root = raw as Record<string, unknown>;
  if ('web' in root && !('installed' in root)) throw Error('CALENDAR_CLIENT_INVALID');
  const source =
    root.installed !== null && typeof root.installed === 'object'
      ? (root.installed as Record<string, unknown>)
      : root;
  const clientId = typeof source.client_id === 'string' ? source.client_id : typeof source.clientId === 'string' ? source.clientId : '';
  const clientSecret =
    typeof source.client_secret === 'string'
      ? source.client_secret
      : typeof source.clientSecret === 'string'
        ? source.clientSecret
        : undefined;
  if (!SAFE_CLIENT_FIELD.test(clientId)) throw Error('CALENDAR_CLIENT_INVALID');
  if (clientSecret !== undefined && clientSecret !== '' && !SAFE_CLIENT_FIELD.test(clientSecret)) {
    throw Error('CALENDAR_CLIENT_INVALID');
  }
  return clientSecret ? { clientId, clientSecret } : { clientId };
}

export function readCalendarClientFile(path: string): CalendarClient {
  try {
    const bytes = readOwnedFile(path, 64 * 1024);
    return parseCalendarClient(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw Error('CALENDAR_CLIENT_INVALID');
  }
}

export function createPkcePair(verifier = randomBytes(32).toString('base64url')): { verifier: string; challenge: string } {
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export type BrowserLauncher = (command: string, args: string[]) => Promise<boolean>;

const defaultBrowserLauncher: BrowserLauncher = (command, args) =>
  new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: homedir(),
      });
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
      child.once('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });

export async function openSystemBrowser(
  url: string,
  options: { platform?: string; launch?: BrowserLauncher } = {},
): Promise<void> {
  if (!url.startsWith(`${GOOGLE_AUTH_URL}?`)) throw Error('CALENDAR_OAUTH_FAILED');
  const platform = options.platform ?? process.platform;
  const launch = options.launch ?? defaultBrowserLauncher;
  const ok =
    platform === 'win32'
      ? await launch('rundll32.exe', ['url.dll,FileProtocolHandler', url])
      : await launch('xdg-open', [url]);
  if (!ok) throw Error('CALENDAR_BROWSER_FAILED');
}

function hasAllRequiredScopes(scopeHeader: unknown): boolean {
  if (typeof scopeHeader !== 'string' || !scopeHeader.trim()) return false;
  const granted = new Set(scopeHeader.trim().split(/\s+/));
  return CALENDAR_SCOPES.every((required) => granted.has(required));
}

async function readBoundedJson(response: Response, maxBytes = MAX_TOKEN_RESPONSE_BYTES): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw Error('CALENDAR_OAUTH_FAILED');
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('CALENDAR_OAUTH_FAILED');
  return parsed as Record<string, unknown>;
}

function isLoopbackRemote(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1' || address === '::1';
}

function sendSafeCallbackResponse(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(body);
}

export interface AuthorizeCalendarOptions {
  client: CalendarClient;
  openBrowser?: (url: string) => Promise<void> | void;
  fetch?: typeof globalThis.fetch;
  nowMs?: () => number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function authorizeCalendarClient(options: AuthorizeCalendarOptions): Promise<CalendarTokens> {
  const client = parseCalendarClient(options.client);
  const fetchFn = options.fetch ?? globalThis.fetch;
  const nowMs = options.nowMs ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
  const openBrowser = options.openBrowser ?? ((url: string) => openSystemBrowser(url));
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(24).toString('base64url');
  const sockets = new Set<Socket>();

  let settleCallback!: {
    resolve: (code: string) => void;
    reject: (err: Error) => void;
  };
  const callbackPromise = new Promise<string>((resolve, reject) => {
    settleCallback = { resolve, reject };
  });
  // Prevent unhandled-rejection warnings if openBrowser triggers the callback before returning.
  callbackPromise.catch(() => {});

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!isLoopbackRemote(req.socket.remoteAddress)) {
      sendSafeCallbackResponse(res, 403, 'Forbidden.');
      return;
    }
    if (req.method !== 'GET') {
      sendSafeCallbackResponse(res, 405, 'Method not allowed.');
      return;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendSafeCallbackResponse(res, 400, 'Invalid callback request.');
      return;
    }
    if (parsedUrl.pathname !== '/oauth2callback') {
      sendSafeCallbackResponse(res, 404, 'Not found.');
      return;
    }
    if (parsedUrl.searchParams.has('error')) {
      sendSafeCallbackResponse(res, 400, 'Google Calendar sign-in was cancelled or denied.');
      settleCallback.reject(Error('CALENDAR_OAUTH_CANCELLED'));
      return;
    }
    const receivedState = parsedUrl.searchParams.get('state');
    if (receivedState !== state) {
      sendSafeCallbackResponse(res, 400, 'Google Calendar sign-in state verification failed.');
      settleCallback.reject(Error('CALENDAR_OAUTH_STATE_MISMATCH'));
      return;
    }
    const callbackScope = parsedUrl.searchParams.get('scope');
    if (callbackScope !== null && !hasAllRequiredScopes(callbackScope)) {
      sendSafeCallbackResponse(res, 400, 'All three read-only Google Calendar permissions are required.');
      settleCallback.reject(Error('CALENDAR_PARTIAL_GRANT'));
      return;
    }
    const code = parsedUrl.searchParams.get('code') ?? '';
    if (!SAFE_ASCII.test(code)) {
      sendSafeCallbackResponse(res, 400, 'Google Calendar authorization code is missing or invalid.');
      settleCallback.reject(Error('CALENDAR_OAUTH_FAILED'));
      return;
    }
    sendSafeCallbackResponse(
      res,
      200,
      'Google Calendar sign-in received. Return to the terminal, then open Agenda on your phone to choose calendars.',
    );
    settleCallback.resolve(code);
  });

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(Error('CALENDAR_OAUTH_FAILED')));
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const closeServer = async (): Promise<void> => {
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => settleCallback.reject(Error('CALENDAR_OAUTH_CANCELLED'));
  if (options.signal) {
    if (options.signal.aborted) {
      await closeServer();
      throw Error('CALENDAR_OAUTH_CANCELLED');
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  let redirectUri = '';
  let code = '';
  try {
    const address = server.address() as AddressInfo | null;
    if (!address || typeof address.port !== 'number' || address.port <= 0) {
      throw Error('CALENDAR_OAUTH_FAILED');
    }
    redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
    const authUrl = new URL(GOOGLE_AUTH_URL);
    authUrl.searchParams.set('client_id', client.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', CALENDAR_SCOPES.join(' '));
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    timer = setTimeout(() => settleCallback.reject(Error('CALENDAR_OAUTH_TIMEOUT')), timeoutMs);
    await openBrowser(authUrl.toString());
    code = await callbackPromise;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    await closeServer();
  }

  const form = new URLSearchParams();
  form.set('client_id', client.clientId);
  if (client.clientSecret) form.set('client_secret', client.clientSecret);
  form.set('code', code);
  form.set('code_verifier', verifier);
  form.set('grant_type', 'authorization_code');
  form.set('redirect_uri', redirectUri);

  let response: Response;
  try {
    response = await fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw Error('CALENDAR_OAUTH_FAILED');
  }

  if (response.status !== 200) {
    throw Error('CALENDAR_OAUTH_FAILED');
  }

  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson(response);
  } catch {
    throw Error('CALENDAR_OAUTH_FAILED');
  }

  if (!hasAllRequiredScopes(body.scope)) {
    throw Error('CALENDAR_PARTIAL_GRANT');
  }
  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
  const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? body.expires_in : NaN;
  if (!SAFE_ASCII.test(accessToken) || !SAFE_ASCII.test(refreshToken) || !(expiresIn > 0)) {
    throw Error('CALENDAR_OAUTH_FAILED');
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: nowMs() + Math.floor(expiresIn * 1000),
  };
}

export interface RefreshCalendarOptions {
  store: CalendarConnectionStore;
  generation: string;
  fetch?: typeof globalThis.fetch;
  nowMs?: () => number;
}

export async function refreshCalendarTokens(options: RefreshCalendarOptions): Promise<CalendarTokens> {
  const { store, generation } = options;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const nowMs = options.nowMs ?? (() => Date.now());
  const current = store.credentials(generation);
  if (!current || !current.tokens.refreshToken) {
    throw Error('CALENDAR_AUTH_REQUIRED');
  }

  const form = new URLSearchParams();
  form.set('client_id', current.client.clientId);
  if (current.client.clientSecret) form.set('client_secret', current.client.clientSecret);
  form.set('refresh_token', current.tokens.refreshToken);
  form.set('grant_type', 'refresh_token');

  let response: Response;
  try {
    response = await fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw Error('CALENDAR_UNAVAILABLE');
  }

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    let errorCode = '';
    try {
      const errBody = await readBoundedJson(response);
      errorCode = typeof errBody.error === 'string' ? errBody.error : '';
    } catch {
      errorCode = '';
    }
    if (response.status === 401 || response.status === 403 || errorCode === 'invalid_grant' || errorCode === 'unauthorized_client') {
      await store.invalidate(generation);
      throw Error('CALENDAR_AUTH_REQUIRED');
    }
    throw Error('CALENDAR_UNAVAILABLE');
  }

  if (response.status !== 200) {
    throw Error('CALENDAR_UNAVAILABLE');
  }

  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson(response);
  } catch {
    throw Error('CALENDAR_UNAVAILABLE');
  }

  if (body.scope !== undefined && !hasAllRequiredScopes(body.scope)) {
    await store.invalidate(generation);
    throw Error('CALENDAR_AUTH_REQUIRED');
  }

  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  const rotatedRefresh = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined;
  const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? body.expires_in : NaN;
  if (!SAFE_ASCII.test(accessToken) || (rotatedRefresh !== undefined && !SAFE_ASCII.test(rotatedRefresh)) || !(expiresIn > 0)) {
    throw Error('CALENDAR_UNAVAILABLE');
  }

  const nextTokens: CalendarTokens = {
    accessToken,
    refreshToken: rotatedRefresh ?? current.tokens.refreshToken,
    expiresAt: nowMs() + Math.floor(expiresIn * 1000),
  };

  const saved = await store.saveTokens(generation, nextTokens);
  if (!saved) {
    throw Error('CALENDAR_SELECTION_CHANGED');
  }
  return nextTokens;
}
