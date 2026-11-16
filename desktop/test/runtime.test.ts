import { describe, expect, it, vi } from 'vitest';
import { createRuntime, parseRuntimeOptions, type RuntimeDependencies } from '../src/runtime.js';

function fixture(windows = false) {
  const calls: string[] = [];
  const service = (name: string) => { calls.push(`new:${name}`); return { start: vi.fn(async () => { calls.push(`start:${name}`); }), stop: vi.fn(async () => { calls.push(`stop:${name}`); }) }; };
  const helper = { stop: vi.fn(() => { calls.push('stop:helper'); }) };
  const deps: RuntimeDependencies<typeof helper, object, object> = {
    windows,
    createHelper: () => { calls.push('new:helper'); return helper; },
    createVitals: () => { calls.push('new:vitals'); return {}; },
    createHost: () => ({ ...service('host'), poll: vi.fn(async () => { calls.push('poll:host'); }) }),
    createCalendar: () => ({ ...service('calendar'), routes: {} }),
    createQuotas: () => service('quotas'),
    createNotifications: () => service('notifications'),
    createAllowlistSync: () => service('allowlist'),
    executeAction: async (action, getHelper) => { calls.push(`action:${action}`); if (windows && action === 'media_mute') getHelper(); return { success: true }; },
  };
  return { calls, deps, helper };
}

describe('runtime profiles', () => {
  it('keeps the full default and accepts explicit offload pairing in either order', () => {
    expect(parseRuntimeOptions([])).toEqual({profile:'full',pair:false,profileResources:false});
    expect(parseRuntimeOptions(['--pair','--offload','--profile-resources'])).toEqual({profile:'offload',pair:true,profileResources:true});
    for (const args of [['--offload','--offload'],['--full'],['--pair','extra']]) expect(() => parseRuntimeOptions(args)).toThrow('RUNTIME_ARGUMENTS');
  });
  it('constructs and starts the same full-profile services and owns Windows cleanup', async () => {
    const { calls, deps } = fixture(true);
    const runtime = createRuntime('full', deps);
    await runtime.start();
    expect(calls).toEqual(['new:helper','new:vitals','new:host','new:calendar','new:quotas','new:notifications','new:allowlist','start:quotas','start:host','start:allowlist']);
    await runtime.afterAction();
    expect(calls.at(-1)).toBe('poll:host');
    await runtime.stop();
    expect(calls.filter(call => call.startsWith('stop:')).sort()).toEqual(['stop:allowlist','stop:calendar','stop:helper','stop:host','stop:notifications','stop:quotas']);
  });
  it('never constructs Calendar, vitals, host or helper in offload, including shutdown', async () => {
    const { calls, deps } = fixture(true);
    const runtime = createRuntime('offload', deps);
    expect(runtime.calendar).toBeUndefined();
    await runtime.start();
    await runtime.afterAction();
    await runtime.stop();
    await runtime.stop();
    expect(calls).toEqual(['new:quotas','new:notifications','new:allowlist','start:quotas','start:allowlist','stop:allowlist','stop:notifications','stop:quotas']);
  });
  it('allows explicit offload Deck actions and cleans up only a lazily owned helper', async () => {
    const { calls, deps } = fixture(true);
    const runtime = createRuntime('offload', deps);
    expect(await runtime.executeAction('media_mute')).toEqual({success:true});
    expect(await runtime.executeAction('media_mute')).toEqual({success:true});
    await runtime.stop();
    expect(calls.filter(call=>call==='new:helper')).toHaveLength(1);
    expect(calls.filter(call=>call==='stop:helper')).toHaveLength(1);
    expect(calls.some(call=>/host|calendar|vitals/.test(call))).toBe(false);
    await expect(runtime.executeAction('media_mute')).rejects.toThrow('RUNTIME_STOPPED');
  });
  it('cleans partially started services when startup fails', async () => {
    const { calls, deps } = fixture();
    deps.createQuotas = () => ({ start:async()=>{throw Error('synthetic');},stop:async()=>{calls.push('stop:quotas');} });
    const runtime = createRuntime('offload', deps);
    await expect(runtime.start()).rejects.toThrow('synthetic');
    await runtime.stop();
    expect(calls.filter(call=>call==='stop:quotas')).toHaveLength(1);
  });
});
