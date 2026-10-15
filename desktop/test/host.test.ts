import { describe, expect, it } from 'vitest';
import { parseVolume, readHostState, readMedia, HostCollector } from '../src/collectors/host.js';
import { HubStore } from '../src/store.js';

// Synthetic busctl/wpctl/gsettings outputs only: nothing here touches the real session bus.
const prop = (type: string, data: unknown) => JSON.stringify({ type, data });
function fakeHost(over: Record<string, string | Error> = {}) {
  const base: Record<string, string | Error> = {
    'busctl --user --json=short list': JSON.stringify([{ name: ':1.2' }, { name: 'org.mpris.MediaPlayer2.synthetic_a' }, { name: 'org.mpris.MediaPlayer2.synthetic_b.instance1' }, { name: 'org.freedesktop.DBus' }]),
    'busctl --user --json=short get-property org.mpris.MediaPlayer2.synthetic_a /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player PlaybackStatus': prop('s', 'Paused'),
    'busctl --user --json=short get-property org.mpris.MediaPlayer2.synthetic_a /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player Metadata': prop('a{sv}', { 'xesam:title': { type: 's', data: 'Synthetic paused' }, 'xesam:artist': { type: 'as', data: ['Synthetic A'] } }),
    'busctl --user --json=short get-property org.mpris.MediaPlayer2.synthetic_a /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2 Identity': prop('s', 'Synthetic Player A'),
    'busctl --user --json=short get-property org.mpris.MediaPlayer2.synthetic_b.instance1 /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player PlaybackStatus': prop('s', 'Playing'),
    'busctl --user --json=short get-property org.mpris.MediaPlayer2.synthetic_b.instance1 /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player Metadata': prop('a{sv}', { 'xesam:title': { type: 's', data: 'Synthetic track' }, 'xesam:artist': { type: 'as', data: ['Synthetic B', 'Synthetic C'] } }),
    'busctl --user --json=short get-property org.mpris.MediaPlayer2.synthetic_b.instance1 /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2 Identity': new Error('no identity'),
    'wpctl get-volume @DEFAULT_AUDIO_SINK@': 'Volume: 0.45\n',
    'wpctl get-volume @DEFAULT_AUDIO_SOURCE@': 'Volume: 1.00 [MUTED]\n',
    'gsettings get org.gnome.desktop.notifications show-banners': 'false\n',
  };
  const table = { ...base, ...over };
  return async (command: string, args: string[]) => {
    const value = table[[command, ...args].join(' ')];
    if (value === undefined || value instanceof Error) throw value ?? new Error('not found');
    return value;
  };
}

describe('host state', () => {
  it('parses wpctl volume and mute', () => {
    expect(parseVolume('Volume: 0.68\n')).toEqual({ percent: 68, muted: false });
    expect(parseVolume('Volume: 0.40 [MUTED]')).toEqual({ percent: 40, muted: true });
    expect(parseVolume('Volume: 2.00')).toEqual({ percent: 150, muted: false });
    expect(parseVolume('garbage')).toEqual({ percent: null, muted: null });
  });
  it('prefers the playing player and joins artists', async () => {
    expect(await readMedia(fakeHost())).toEqual({ player: 'synthetic_b', status: 'playing', title: 'Synthetic track', artist: 'Synthetic B, Synthetic C' });
  });
  it('falls back to a paused player, then to nothing', async () => {
    const paused = fakeHost({ 'busctl --user --json=short get-property org.mpris.MediaPlayer2.synthetic_b.instance1 /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player PlaybackStatus': prop('s', 'Stopped') });
    expect(await readMedia(paused)).toMatchObject({ player: 'Synthetic Player A', status: 'paused' });
    expect(await readMedia(fakeHost({ 'busctl --user --json=short list': '[]' }))).toBeNull();
  });
  it('reads every field and reports DND from hidden banners', async () => {
    expect(await readHostState(fakeHost())).toMatchObject({ volumePercent: 45, muted: false, micMuted: true, doNotDisturb: true, media: { title: 'Synthetic track' } });
  });
  it('leaves only the failing tool null', async () => {
    const state = await readHostState(fakeHost({ 'wpctl get-volume @DEFAULT_AUDIO_SINK@': new Error('no wpctl'), 'gsettings get org.gnome.desktop.notifications show-banners': new Error('no gsettings') }));
    expect(state).toMatchObject({ volumePercent: null, muted: null, doNotDisturb: null, micMuted: true });
    expect(state.media).not.toBeNull();
  });
  it('clips long titles to the protocol budget', async () => {
    const long = fakeHost({ 'busctl --user --json=short get-property org.mpris.MediaPlayer2.synthetic_b.instance1 /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player Metadata': prop('a{sv}', { 'xesam:title': { type: 's', data: '♪'.repeat(300) } }) });
    const media = await readMedia(long);
    expect([...media!.title]).toHaveLength(120);
    expect(media!.artist).toBe('');
  });
  it('publishes host state in the hub snapshot', async () => {
    const store = new HubStore();
    expect(store.snapshot(1_000).host).toBeUndefined();
    await new HostCollector({ store, run: fakeHost() }).poll();
    expect(store.snapshot(1_000).host).toMatchObject({ micMuted: true, media: { status: 'playing' } });
  });
});
