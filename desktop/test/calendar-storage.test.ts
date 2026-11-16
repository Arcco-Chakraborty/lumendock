import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarConnectionStore, protectWindowsDirectory } from '../src/calendar/connection.js';
import { runCalendarCommand } from '../src/calendar/cli.js';

// PowerShell/Windows ACL APIs are unavailable on Linux. Keep the real store/CLI and
// intercept only the native subprocess boundary; never change a real profile ACL.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn(),
}));

const dirs: string[] = [];
afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Windows calendar private storage subprocess', () => {
  it('keeps a directory containing PowerShell syntax out of the command source', () => {
    const target = "C:\\Synthetic User's folder\\$(throw 'synthetic') & 日本\\calendar";
    protectWindowsDirectory(target);
    const [command, args, options] = vi.mocked(execFileSync).mock.calls[0]!;
    expect(command).toBe('powershell.exe');
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand', expect.any(String)]);
    const script = Buffer.from(args![3]!, 'base64').toString('utf16le');
    expect(script).toContain('$env:LUMENDOCK_CALENDAR_DIRECTORY');
    expect(script).not.toContain(target);
    expect(options).toMatchObject({
      env: { LUMENDOCK_CALENDAR_DIRECTORY: target },
      timeout: 10_000,
      windowsHide: true,
    });
  });

  it('does not start OAuth or persist credentials when native ACL protection fails', async () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw Error('synthetic ACL rejection'); });
    const directory = mkdtempSync(join(tmpdir(), 'synthetic-calendar-storage-'));
    dirs.push(directory);
    const store = new CalendarConnectionStore(directory, { platform: 'win32' });
    const authorize = vi.fn();
    const output: string[] = [];
    const status = await runCalendarCommand(['connect', '--client', 'synthetic-client.json'], directory, {
      store,
      readClient: () => ({ clientId: 'synthetic-client' }),
      authorize,
      out: line => output.push(line),
    });
    expect(status).toBe(1);
    expect(output.join('\n')).toContain('Private calendar storage could not be verified');
    expect(authorize).not.toHaveBeenCalled();
    expect(store.read().connected).toBe(false);
    for (const file of ['connection.json', 'client.json', 'tokens.json']) {
      expect(existsSync(join(store.directory, file))).toBe(false);
    }
  });
});
