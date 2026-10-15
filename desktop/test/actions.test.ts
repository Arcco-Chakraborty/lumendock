import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_ACTIONS, TERMINALS, openTerminal, systemAction } from '../src/actions.js';

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

describe('laptop system keys', () => {
  const recorder = (outputs: Record<string, string> = {}, fail = false) => {
    const calls: string[] = [];
    const run = async (command: string, args: string[]) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      if (fail) throw new Error('synthetic failure');
      return outputs[line] ?? '';
    };
    return { run, calls };
  };
  it('lists the four new fixed actions', () => {
    for (const id of ['mic_mute', 'dnd_toggle', 'lock_screen', 'screenshot']) expect(SUPPORTED_ACTIONS).toContain(id);
  });
  it('toggles the default microphone and locks the session with fixed commands', async () => {
    const { run, calls } = recorder();
    await expect(systemAction('mic_mute', run)).resolves.toMatchObject({ success: true });
    await expect(systemAction('lock_screen', run)).resolves.toMatchObject({ success: true });
    expect(calls).toEqual(['wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle', 'loginctl lock-session']);
  });
  it('flips Do Not Disturb from the current banner setting', async () => {
    const on = recorder({ 'gsettings get org.gnome.desktop.notifications show-banners': 'true\n' });
    await systemAction('dnd_toggle', on.run);
    expect(on.calls[1]).toBe('gsettings set org.gnome.desktop.notifications show-banners false');
    const off = recorder({ 'gsettings get org.gnome.desktop.notifications show-banners': 'false\n' });
    await systemAction('dnd_toggle', off.run);
    expect(off.calls[1]).toBe('gsettings set org.gnome.desktop.notifications show-banners true');
  });
  it('opens the interactive screenshot portal', async () => {
    const { run, calls } = recorder();
    await systemAction('screenshot', run);
    expect(calls[0]).toContain('org.freedesktop.portal.Screenshot.Screenshot');
    expect(calls[0]).toContain("{'interactive': <true>}");
  });
  it('reports failure without leaking command output and ignores unknown ids', async () => {
    const { run } = recorder({}, true);
    await expect(systemAction('mic_mute', run)).resolves.toEqual({ success: false, message: 'Action failed' });
    await expect(systemAction('rm_rf', run)).resolves.toBeNull();
  });
});
