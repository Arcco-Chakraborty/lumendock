import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createUsbInternetDependencies, ownedRelayChild, runUsbInternetCli } from '../src/usb-internet-system.js';
const options={serial:'SYNTHETIC_USB_DEVICE',relay:'/synthetic/gnirehtet',relaySha256:'a'.repeat(64),port:31416,lifetimeMs:1000};

describe('USB internet OS boundary',()=>{
  it('checks pinned file hash and treats only pidof exit1 as no existing client',async()=>{
    const run=vi.fn(async()=>({code:1,stdout:''}));
    const deps=createUsbInternetDependencies({hashFile:async()=>options.relaySha256,run,spawnRelay:async()=>{throw Error('unused');}});
    await deps.verifyRelay(options);
    expect(await deps.adb(['-s',options.serial,'shell','pidof','com.genymobile.gnirehtet'])).toBe('');
    await expect(deps.adb(['-s',options.serial,'reverse','--list'])).rejects.toThrow('USB_ADB_FAILED');
    await expect(deps.verifyRelay({...options,relaySha256:'b'.repeat(64)})).rejects.toThrow('USB_RELAY_HASH_MISMATCH');
  });
  it('does not start/read anything for help and prints only sanitized dry-run summary',async()=>{
    const write=vi.fn();const dependencies=vi.fn(()=>{throw Error('must remain unused');});
    expect(await runUsbInternetCli([],{write,dependencies})).toBe(0);
    expect(await runUsbInternetCli(['dry-run','--serial',options.serial,'--relay',options.relay,'--relay-sha256',options.relaySha256],{write,dependencies})).toBe(0);
    expect(dependencies).not.toHaveBeenCalled();
    const text=write.mock.calls.flat().join('');
    expect(text).toContain('127.0.0.1');expect(text).not.toContain(options.serial);expect(text).not.toContain(options.relay);expect(text).not.toContain(options.relaySha256);
  });
  it('sanitizes arbitrary boundary errors without forwarding child output',async()=>{
    const write=vi.fn();const deps={verifyRelay:async()=>{throw Error('private synthetic serial and path');},adb:async()=>'',startRelay:async()=>{throw Error('unused');},sleep:async()=>{}};
    const code=await runUsbInternetCli(['start','--client-prepared','--serial',options.serial,'--relay',options.relay,'--relay-sha256',options.relaySha256],{write,dependencies:()=>deps});
    expect(code).toBe(1);expect(write.mock.calls.flat().join('')).not.toContain('private synthetic');
  });
  it('bounds readiness checks and kills only the child it was handed',async()=>{
    const events=new EventEmitter();let code:number|null=null;
    const process={get exitCode(){return code;},once:events.once.bind(events),kill:vi.fn((signal:string)=>{if(signal==='SIGKILL'){code=1;events.emit('exit');}return true;})};
    const sleeps:number[]=[];
    const child=ownedRelayChild(process,{probe:async()=>false,sleep:async ms=>{sleeps.push(ms);}});
    await expect(child.ready()).rejects.toThrow('USB_RELAY_UNAVAILABLE');
    expect(sleeps.filter(ms=>ms===100)).toHaveLength(50);
    await child.stop();await child.stop();
    expect(process.kill.mock.calls).toEqual([['SIGTERM'],['SIGKILL']]);
    await child.exited;
  });
  it('does not call a ready relay healthy after its owned process has exited',async()=>{
    const events=new EventEmitter();const process={exitCode:1,once:events.once.bind(events),kill:vi.fn(()=>true)};
    const probe=vi.fn(async()=>true);
    const child=ownedRelayChild(process,{probe,sleep:async()=>{}});
    await expect(child.ready()).rejects.toThrow('USB_RELAY_UNAVAILABLE');
    expect(probe).not.toHaveBeenCalled();await child.stop();expect(process.kill).not.toHaveBeenCalled();
  });
});
