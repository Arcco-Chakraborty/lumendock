import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_ACTIONS, TERMINALS, openTerminal } from '../src/actions.js';

// Fake spawner only: these tests never start a real terminal.
function fakeSpawner(available: string[]) {
  const calls: Array<{ command: string; args: string[]; unref: number }> = [];
  const start = (command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { unref: () => { call.unref++; } });
    const call = { command, args, unref: 0 };
    calls.push(call);
    queueMicrotask(() => child.emit(available.includes(command) ? 'spawn' : 'error'));
    return child;
  };
  return { start, calls };
}

describe('open_terminal', () => {
  it('replaces the Spotify launcher in the fixed action list', () => {
    expect(SUPPORTED_ACTIONS).toContain('open_terminal');
    expect(SUPPORTED_ACTIONS).not.toContain('open_spotify' as never);
  });
  it('starts the first available terminal detached and does not wait for it to exit', async () => {
    const { start, calls } = fakeSpawner(['ptyxis', 'gnome-terminal']);
    await expect(openTerminal(start)).resolves.toEqual({ success: true, message: 'Opening Terminal' });
    expect(calls).toEqual([{ command: 'ptyxis', args: ['--new-window'], unref: 1 }]);
  });
  it('falls through missing terminals in order', async () => {
    const { start, calls } = fakeSpawner(['x-terminal-emulator']);
    await expect(openTerminal(start)).resolves.toMatchObject({ success: true });
    expect(calls.map((c) => c.command)).toEqual(TERMINALS.map(([command]) => command));
  });
  it('reports failure when no terminal exists', async () => {
    const { start } = fakeSpawner([]);
    await expect(openTerminal(start)).resolves.toEqual({ success: false, message: 'No terminal found' });
  });
});
