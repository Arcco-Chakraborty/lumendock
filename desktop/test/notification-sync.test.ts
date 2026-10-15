import { describe,it,expect,vi,afterEach } from 'vitest';
import { AllowlistSync } from '../src/notification-sync.js';

afterEach(()=>{vi.useRealTimers();});
describe('AllowlistSync',()=>{
 it('applies the initial list, then only changes, and stops cleanly',async()=>{
  vi.useFakeTimers();let labels=['SyntheticApp'];const applied:string[][]=[];
  const sync=new AllowlistSync({configDir:'x',list:()=>labels,apply:async l=>{applied.push(l);},intervalMs:1000});
  await sync.start();expect(applied).toEqual([['SyntheticApp']]);
  await vi.advanceTimersByTimeAsync(3000);expect(applied).toHaveLength(1);
  labels=['SyntheticApp','Other'];await vi.advanceTimersByTimeAsync(1000);expect(applied).toHaveLength(2);expect(applied[1]).toEqual(['SyntheticApp','Other']);
  sync.stop();labels=[];await vi.advanceTimersByTimeAsync(5000);expect(applied).toHaveLength(2);expect(vi.getTimerCount()).toBe(0);
 });
 it('treats an unreadable config as an empty allowlist and keeps running',async()=>{
  vi.useFakeTimers();const applied:string[][]=[];
  const sync=new AllowlistSync({configDir:'x',list:()=>{throw Error('BAD_CONFIG');},apply:async l=>{applied.push(l);},intervalMs:1000});
  await sync.start();expect(applied).toEqual([[]]);sync.stop();
 });
 it('retries a failed apply and never overlaps applies',async()=>{
  vi.useFakeTimers();let calls=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const sync=new AllowlistSync({configDir:'x',list:()=>['A'],intervalMs:1000,apply:async()=>{calls++;if(calls===1)throw Error('boom');if(calls===2)await gate;}});
  await sync.start();expect(calls).toBe(1);
  const second=vi.advanceTimersByTimeAsync(1000);await second;expect(calls).toBe(2);
  await vi.advanceTimersByTimeAsync(3000);expect(calls).toBe(2);release();await vi.advanceTimersByTimeAsync(0);sync.stop();
 });
});
