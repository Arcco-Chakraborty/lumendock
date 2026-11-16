import { describe, expect, it, vi } from 'vitest';
import { ResourceSampler, startResourceProfiler } from '../src/resources.js';

describe('opt-in own-process resources',()=>{
  it('reports CPU deltas and RSS without exposing process identifiers or private fields',()=>{
    let now=100;let cpu={user:10_000,system:20_000};
    const sample=new ResourceSampler('offload',{now:()=>now,cpu:()=>cpu,rss:()=>12_345});
    now=1100;cpu={user:110_000,system:120_000};
    expect(sample.sample()).toEqual({v:1,scope:'hub-process',profile:'offload',elapsedMs:1000,cpuPercent:20,rssBytes:12345});
    now=2100;cpu={user:110_000,system:120_000};expect(sample.sample().cpuPercent).toBe(0);
  });
  it('starts only on explicit call and stops after a bounded sample budget',()=>{
    vi.useFakeTimers();
    try {
      const write=vi.fn();const sample=vi.fn(()=>({v:1}));
      const stop=startResourceProfiler({sample},write,{intervalMs:1000,maxSamples:2});
      vi.advanceTimersByTime(10_000);stop();
      expect(sample).toHaveBeenCalledTimes(2);expect(write.mock.calls).toEqual([['{"v":1}'],['{"v":1}']]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {vi.useRealTimers();}
  });
});
