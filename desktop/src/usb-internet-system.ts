import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { defaultAdbPath } from './adb.js';
import { UsbInternetSession, parseUsbInternetArgs, publicIpv4Routes, type UsbInternetDependencies, type RelayChild } from './usb-internet.js';
export interface RelayProcess {exitCode:number|null;once(event:string,listener:(...args:unknown[])=>void):unknown;kill(signal:NodeJS.Signals):unknown}
export interface UsbSystemIo {hashFile(file:string):Promise<string>;run(args:string[]):Promise<{code:number;stdout:string}>;spawnRelay(file:string,args:string[],port:number):Promise<RelayChild>}
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const probe=(port:number)=>new Promise<boolean>(resolve=>{
  const socket=connect({host:'127.0.0.1',port});let done=false;
  const finish=(ok:boolean)=>{if(done)return;done=true;socket.destroy();resolve(ok);};
  socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(200,()=>finish(false));
});
const portFree=(port:number)=>new Promise<void>((resolve,reject)=>{
  const server=createServer();server.once('error',()=>reject(Error('USB_RELAY_PORT_IN_USE')));
  server.listen({host:'127.0.0.1',port,exclusive:true},()=>server.close(error=>error?reject(Error('USB_RELAY_PORT_IN_USE')):resolve()));
});
const systemIo:UsbSystemIo={
  async hashFile(file) {
    const metadata=await stat(file);if(!metadata.isFile()||metadata.size<1||metadata.size>64*1024*1024) throw Error('USB_RELAY_FILE');
    const hash=createHash('sha256');for await(const chunk of createReadStream(file)) hash.update(chunk);return hash.digest('hex');
  },
  run:args=>new Promise((resolve,reject)=>{
    execFile(defaultAdbPath(),args,{timeout:5000,maxBuffer:64*1024,windowsHide:true},(error,stdout)=>{
      if(error&&typeof error.code!=='number') {reject(Error('USB_ADB_FAILED'));return;}
      resolve({code:error?.code as number??0,stdout});
    });
  }),
  async spawnRelay(file,args,port) {
    await portFree(port);
    const child=spawn(file,args,{stdio:'ignore',windowsHide:true});
    return ownedRelayChild(child,{probe:()=>probe(port),sleep});
  },
};
export function createUsbInternetDependencies(io:UsbSystemIo=systemIo):UsbInternetDependencies {
  return {
    async verifyRelay(options) {
      let actual:string;
      try {actual=await io.hashFile(options.relay);} catch {throw Error('USB_RELAY_FILE');}
      if(actual.toLowerCase()!==options.relaySha256.toLowerCase()) throw Error('USB_RELAY_HASH_MISMATCH');
    },
    async adb(args) {
      const result=await io.run(args);
      const noPid=result.code===1&&args.length===5&&args[2]==='shell'&&args[3]==='pidof'&&args[4]==='com.genymobile.gnirehtet';
      if(result.code!==0&&!noPid) throw Error('USB_ADB_FAILED');return result.stdout;
    },
    startRelay:(file,args)=>io.spawnRelay(file,args,Number(args[2])),sleep,
  };
}
export function ownedRelayChild(child:RelayProcess,io:{probe():Promise<boolean>;sleep(ms:number):Promise<void>}):RelayChild {
  let gone=child.exitCode!==null;let stopping:Promise<void>|undefined;
  const exited=new Promise<void>(resolve=>{if(gone) resolve();child.once('exit',()=>{gone=true;resolve();});child.once('error',()=>{gone=true;resolve();});});
  return {
    exited,
    async ready() {
      for(let i=0;i<50;i++) {
        if(gone||child.exitCode!==null) throw Error('USB_RELAY_UNAVAILABLE');
        if(await io.probe()&&!gone&&child.exitCode===null) return;
        await io.sleep(100);
      }
      throw Error('USB_RELAY_UNAVAILABLE');
    },
    stop() {
      stopping??=(async()=>{
        if(gone||child.exitCode!==null)return;
        child.kill('SIGTERM');
        for(let i=0;i<10&&!gone;i++) await io.sleep(100);
        if(!gone&&child.exitCode===null) child.kill('SIGKILL');
      })();return stopping;
    },
  };
}
const help=`USB internet is optional. No command starts by default.
Usage: node scripts/usb-internet.mjs help
       node scripts/usb-internet.mjs dry-run --serial DEVICE --relay ABSOLUTE_FILE --relay-sha256 SHA256 [--port 31416] [--lifetime-seconds 3600]
       node scripts/usb-internet.mjs start --client-prepared --serial DEVICE --relay ABSOLUTE_FILE --relay-sha256 SHA256 [--port 31416] [--lifetime-seconds 3600]
Requires an independently installed, pinned Rust gnirehtet relay and matching prepared Android client. Human VPN consent may be shown on the phone. Ctrl+C stops this session. Maximum lifetime 8h; no daemon or installer. See docs/OFFLOAD.md.`;
const safeErrors=new Set(['USB_ARGUMENTS','USB_OPTIONS','USB_RELAY_FILE','USB_RELAY_HASH_MISMATCH','USB_RELAY_PORT_IN_USE','USB_ADB_FAILED','USB_DEVICE_UNAVAILABLE','USB_CLIENT_MISSING','USB_CLIENT_IN_USE','USB_MAPPING_IN_USE','USB_RELAY_UNAVAILABLE','USB_CLIENT_START_FAILED','USB_STOPPED']);
export async function runUsbInternetCli(args:string[],io={write:(text:string)=>console.log(text),dependencies:createUsbInternetDependencies}):Promise<number> {
  let session:UsbInternetSession|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let signal:(()=>void)|undefined;
  try {
    const parsed=parseUsbInternetArgs(args);
    if(parsed.command==='help') {io.write(help);return 0;}
    const options=parsed.options!;
    if(parsed.command==='dry-run') {
      io.write(JSON.stringify({mode:'dry-run',bind:'127.0.0.1',port:options.port,lifetimeSeconds:options.lifetimeMs/1000,routeCount:publicIpv4Routes().length,selectedDevice:true,preparedClientRequired:true,installs:false}));return 0;
    }
    session=new UsbInternetSession(options,io.dependencies());
    const current=session;
    const stopped=new Promise<void>(resolve=>{
      signal=()=>{void current.stop();resolve();};
      process.once('SIGINT',signal);process.once('SIGTERM',signal);
      timer=setTimeout(signal,options.lifetimeMs);
    });
    await session.start();
    io.write('USB relay session started on loopback. Complete any VPN consent on the phone. Local routing remains device-unverified.');
    await Promise.race([session.exited,stopped]);return 0;
  } catch(error) {
    const message=error instanceof Error&&safeErrors.has(error.message)?error.message:'USB_SETUP_FAILED';
    io.write(`${message}. Check the prepared relay/client and selected USB device; no installer is run.`);return 1;
  } finally {
    if(timer)clearTimeout(timer);
    if(signal){process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);}
    await session?.stop();
  }
}
