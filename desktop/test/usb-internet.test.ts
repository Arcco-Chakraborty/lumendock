import { describe, expect, it } from 'vitest';
import { createUsbInternetPlan, publicIpv4Routes, UsbInternetSession, parseUsbInternetArgs, type UsbInternetDependencies } from '../src/usb-internet.js';

const options = {serial:'SYNTHETIC_USB_DEVICE',relay:'/synthetic/gnirehtet',relaySha256:'a'.repeat(64),port:31416,lifetimeMs:60_000};
function contains(route:string,ip:string) {
  const n=(s:string)=>s.split('.').reduce((a,b)=>a*256+Number(b),0);
  const [network,bits]=route.split('/');
  const size=2**(32-Number(bits));
  return Math.floor(n(ip)/size)===Math.floor(n(network!)/size);
}
function fixture() {
  const calls:Array<string[]>=[]; let mappings=''; let failures=0; let stopped=0;
  const deps:UsbInternetDependencies = {
    verifyRelay:async()=>{},
    adb:async args=>{
      calls.push(args);
      if (args.includes('get-state')) return 'device\n';
      if (args.includes('path')) return 'package:/synthetic/base.apk\n';
      if (args.includes('pidof')) return '';
      if (args.includes('--list')) return mappings;
      if (args.includes('--no-rebind')) mappings='SYNTHETIC_USB_DEVICE localabstract:gnirehtet tcp:31416\n';
      if (args.includes('--remove')) mappings='';
      return '';
    },
    startRelay:async (_file,args)=>{
      calls.push(['RELAY',...args]);
      if (failures-->0) throw Error('synthetic spawn failure');
      return {ready:async()=>{},exited:new Promise<void>(()=>{}),stop:async()=>{stopped++;}};
    },
    sleep:async ms=>{calls.push(['BACKOFF',String(ms)]);},
  };
  return {deps,calls,setMappings:(s:string)=>{mappings=s;},setFailures:(n:number)=>{failures=n;},stopped:()=>stopped};
}

describe('optional selected-device USB internet',()=>{
  it('defaults to help and requires explicit start with already prepared client assertion',()=>{
    expect(parseUsbInternetArgs([])).toEqual({command:'help'});
    expect(()=>parseUsbInternetArgs(['start'])).toThrow('USB_ARGUMENTS');
    expect(()=>parseUsbInternetArgs(['start','--serial',options.serial,'--relay',options.relay,'--relay-sha256',options.relaySha256])).toThrow('USB_ARGUMENTS');
    expect(parseUsbInternetArgs(['dry-run','--serial',options.serial,'--relay',options.relay,'--relay-sha256',options.relaySha256])).toMatchObject({command:'dry-run',options:{port:31416}});
  });
  it('excludes private, loopback, link-local and nonpublic ranges while retaining public internet',()=>{
    const routes=publicIpv4Routes();
    for(const ip of ['0.0.0.0','10.0.0.1','127.0.0.1','169.254.1.2','172.16.0.1','172.31.255.255','192.168.43.1','100.64.0.1','224.0.0.1','255.255.255.255']) expect(routes.some(r=>contains(r,ip)),ip).toBe(false);
    for(const ip of ['1.1.1.1','8.8.8.8','142.250.1.1','172.32.0.1','192.169.0.1','223.255.255.1']) expect(routes.some(r=>contains(r,ip)),ip).toBe(true);
  });
  it('uses fixed argv, selected serial, no-rebind mapping, explicit routes, and no installer',()=>{
    const p=createUsbInternetPlan(options);
    expect(p.relayArgs).toEqual(['relay','-p','31416']);
    expect(p.mapping).toEqual(['-s',options.serial,'reverse','--no-rebind','localabstract:gnirehtet','tcp:31416']);
    expect(p.start.slice(0,9)).toEqual(['-s',options.serial,'shell','am','start','-a','com.genymobile.gnirehtet.START','-n','com.genymobile.gnirehtet/.GnirehtetActivity']);
    expect(p.start.slice(9,12)).toEqual(['--esa','dnsServers','8.8.8.8']);
    expect(p.start.slice(12,14)).toEqual(['--esa','routes']);
    expect(p.start[14]).not.toContain('0.0.0.0/0');
    expect(p.stop).toContain('com.genymobile.gnirehtet.STOP');
  });
  it('rejects malformed options and collisions before running any process',()=>{
    for(const change of [{serial:'-all'},{serial:'host:5555'},{serial:'x;command'},{relay:'gnirehtet'},{relay:'/x\nthing'},{relaySha256:'bad'},{port:8765},{port:8787},{port:0},{lifetimeMs:0},{lifetimeMs:29_000_000}]) expect(()=>createUsbInternetPlan({...options,...change})).toThrow('USB_OPTIONS');
  });
  it('starts a prepared client and removes only its own still-matching mapping once',async()=>{
    const f=fixture();const session=new UsbInternetSession(options,f.deps);
    await session.start();await session.stop();await session.stop();
    expect(f.calls.filter(c=>c.includes('com.genymobile.gnirehtet.START'))).toHaveLength(1);
    expect(f.calls.filter(c=>c.includes('--remove'))).toEqual([['-s',options.serial,'reverse','--remove','localabstract:gnirehtet']]);
    expect(f.stopped()).toBe(1);
    expect(f.calls.flat()).not.toEqual(expect.arrayContaining(['install','run','autorun','kill-server','--remove-all']));
  });
  it('refuses an existing gnirehtet mapping without touching any process/device',async()=>{
    const f=fixture();f.setMappings('SYNTHETIC_USB_DEVICE localabstract:gnirehtet tcp:12345\n');
    const session=new UsbInternetSession(options,f.deps);
    await expect(session.start()).rejects.toThrow('USB_MAPPING_IN_USE');await session.stop();
    expect(f.calls.some(c=>c.includes('RELAY')||c.includes('--remove')||c.includes('com.genymobile.gnirehtet.STOP'))).toBe(false);
  });
  it('preserves a mapping replaced by another owner and an unrelated hub mapping',async()=>{
    const f=fixture();f.setMappings('OTHER_SYNTHETIC tcp:8765 tcp:8765\n');
    const session=new UsbInternetSession(options,f.deps);await session.start();
    f.setMappings('SYNTHETIC_USB_DEVICE localabstract:gnirehtet tcp:12345\nSYNTHETIC_USB_DEVICE tcp:8765 tcp:8765\n');
    await session.stop();
    expect(f.calls.some(c=>c.includes('--remove'))).toBe(false);
    expect(f.calls.some(c=>c.includes('com.genymobile.gnirehtet.STOP'))).toBe(false);
  });
  it('bounds startup retries with backoff and never retries uncertain START',async()=>{
    const f=fixture();f.setFailures(10);
    await expect(new UsbInternetSession(options,f.deps).start()).rejects.toThrow('USB_RELAY_UNAVAILABLE');
    expect(f.calls.filter(c=>c[0]==='RELAY')).toHaveLength(3);
    expect(f.calls.filter(c=>c[0]==='BACKOFF')).toEqual([['BACKOFF','250'],['BACKOFF','1000']]);
    const g=fixture(); const original=g.deps.adb;
    g.deps.adb=async args=>{if(args.includes('com.genymobile.gnirehtet.START')) throw Error('synthetic');return original(args);};
    await expect(new UsbInternetSession(options,g.deps).start()).rejects.toThrow('USB_CLIENT_START_FAILED');
    expect(g.calls.filter(c=>c[0]==='RELAY')).toHaveLength(1);
    expect(g.stopped()).toBe(1);
  });
  it('rejects a missing client and an already running client without installation or STOP',async()=>{
    for(const missing of [true,false]) {
      const f=fixture();const original=f.deps.adb;
      f.deps.adb=async args=>args.includes('path')&&missing?'':args.includes('pidof')&&!missing?'123\n':original(args);
      await expect(new UsbInternetSession(options,f.deps).start()).rejects.toThrow(missing?'USB_CLIENT_MISSING':'USB_CLIENT_IN_USE');
      expect(f.calls.some(c=>c.includes('RELAY')||c.includes('com.genymobile.gnirehtet.STOP'))).toBe(false);
    }
  });
});
