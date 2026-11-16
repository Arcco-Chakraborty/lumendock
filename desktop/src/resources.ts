import { performance } from 'node:perf_hooks';
import type { RuntimeProfile } from './runtime.js';
export interface ResourceIo {now():number;cpu():NodeJS.CpuUsage;rss():number}
const ownProcess:ResourceIo={now:()=>performance.now(),cpu:()=>process.cpuUsage(),rss:()=>process.memoryUsage.rss()};
/** Only the current hub process; no /proc scanning, cmdlines, environment or provider data. */
export class ResourceSampler {
  private readonly started:number;
  private previousAt:number;
  private previousCpu:NodeJS.CpuUsage;
  constructor(private readonly profile:RuntimeProfile,private readonly io:ResourceIo=ownProcess) {
    this.started=this.previousAt=io.now();this.previousCpu=io.cpu();
  }
  sample() {
    const now=this.io.now(),cpu=this.io.cpu(),elapsed=now-this.previousAt;
    const percent=elapsed>0?Math.max(0,(cpu.user+cpu.system-this.previousCpu.user-this.previousCpu.system)/elapsed/10):0;
    this.previousAt=now;this.previousCpu=cpu;
    return {v:1,scope:'hub-process',profile:this.profile,elapsedMs:Math.round(Math.max(0,now-this.started)),cpuPercent:Math.round(percent*100)/100,rssBytes:Math.max(0,Math.round(this.io.rss()))};
  }
}
/** The executable opts in explicitly; defaults to one sample/10s for at most one hour. */
export function startResourceProfiler(sampler:{sample():unknown},write:(text:string)=>void,options={intervalMs:10_000,maxSamples:360}):()=>void {
  if(!Number.isInteger(options.intervalMs)||options.intervalMs<1000||!Number.isInteger(options.maxSamples)||options.maxSamples<1||options.maxSamples>360) throw Error('RESOURCE_OPTIONS');
  let count=0;
  const timer=setInterval(()=>{try {write(JSON.stringify(sampler.sample()));} catch {clearInterval(timer);} if(++count>=options.maxSamples) clearInterval(timer);},options.intervalMs);
  timer.unref();return ()=>clearInterval(timer);
}
