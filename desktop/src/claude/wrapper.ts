#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { ClaudeObservationStore } from '../collectors/claude.js';
import { readClaudeInstallation } from './install.js';

const MAX_CAPTURE_BYTES=256*1024;
interface Exit {code:number|null;signal:NodeJS.Signals|null}
function signalOwnedGroup(child:ChildProcessWithoutNullStreams,signal:NodeJS.Signals):void {
  if(child.pid!==undefined){try{process.kill(-child.pid,signal);}catch{/* Already exited. */}}
}
export async function runClaudeWrapper(configDir:string):Promise<Exit> {
  let record;
  try{record=readClaudeInstallation(configDir);}catch{return {code:1,signal:null};}
  if(!record)return {code:1,signal:null};
  let child:ChildProcessWithoutNullStreams|null=null;
  let childDone:Promise<Exit>|null=null;
  let terminated:NodeJS.Signals|null=null;
  let escalation:ReturnType<typeof setTimeout>|null=null;
  const cancel=(signal:NodeJS.Signals)=>{
    if(terminated)return;terminated=signal;
    // Unblock bounded capture/drain; normal SIGTERM/SIGINT owns cleanup.
    // SIGKILL is uncatchable and has no handler.
    process.stdin.destroy();
    if(child){signalOwnedGroup(child,signal);escalation=setTimeout(()=>{if(child)signalOwnedGroup(child,'SIGKILL');},500);}
  };
  const term=()=>cancel('SIGTERM'),int=()=>cancel('SIGINT');
  process.on('SIGTERM',term);process.on('SIGINT',int);
  let pipeClosed=false;
  try {
    if(record.previousCommand!==null){
      const compatibility=record.compatibility;
      if(!record.previousShell||!isAbsolute(record.previousShell)||!compatibility?.shellVerified||!compatibility.cancellationVerified||compatibility.shellPath!==record.previousShell)return {code:1,signal:null};
      child=spawn(record.previousShell,['-c',record.previousCommand],{cwd:process.cwd(),env:process.env,detached:true,stdio:['pipe','inherit','inherit']}) as unknown as ChildProcessWithoutNullStreams;
      const owned=child;
      childDone=new Promise<Exit>(resolve=>{
        owned.once('error',()=>resolve({code:1,signal:null}));
        owned.once('exit',(code,signal)=>resolve({code,signal}));
      });
      owned.stdin.on('error',()=>{pipeClosed=true;});
    }
    let total=0,overflow=false;const parts:Buffer[]=[];
    try {
      for await (const value of process.stdin){
        if(terminated)break;
        const chunk=Buffer.from(value as Buffer);total+=chunk.length;
        if(total>MAX_CAPTURE_BYTES){overflow=true;parts.length=0;}else if(!overflow)parts.push(chunk);
        if(child&&!pipeClosed&&!child.stdin.destroyed){
          if(!child.stdin.write(chunk))await new Promise<void>(resolve=>{
            const stream=child!.stdin;
            const finish=()=>{stream.off('drain',finish);stream.off('error',finish);stream.off('close',finish);resolve();};
            stream.once('drain',finish);stream.once('error',finish);stream.once('close',finish);
          });
        }
      }
    }catch{/* Input cancellation or EPIPE cannot suppress prior output. */}
    if(child&&!child.stdin.destroyed)child.stdin.end();
    if(!terminated&&!overflow){
      try{
        const input:unknown=JSON.parse(Buffer.concat(parts).toString('utf8'));
        await new ClaudeObservationStore(configDir).capture(input,Date.now());
      }catch{/* Capture is best effort and never writes to stdout/stderr. */}
    }
    if(!child){
      if(!terminated){
        let label='Claude';
        try{const input=JSON.parse(Buffer.concat(parts).toString('utf8'));if(typeof input?.model?.display_name==='string')label=[...input.model.display_name.replace(/[\u0000-\u001f\u007f-\u009f]/g,'')].slice(0,80).join('');}catch{/* Minimal fallback label. */}
        process.stdout.write(`[${label}]\n`);
      }
      return {code:0,signal:terminated};
    }
    const result=await childDone!;
    // The root can exit before a resistant descendant. Wait the full grace
    // interval before escalation, then remove all remaining owned processes.
    if(terminated){await new Promise(resolve=>setTimeout(resolve,500));signalOwnedGroup(child,'SIGKILL');}
    else {
      signalOwnedGroup(child,'SIGTERM');
      let remaining=false;
      if(child.pid!==undefined){try{process.kill(-child.pid,0);remaining=true;}catch{/* Group has already exited. */}}
      if(remaining){await new Promise(resolve=>setTimeout(resolve,500));signalOwnedGroup(child,'SIGKILL');}
    }
    return terminated?{code:null,signal:terminated}:result;
  }finally{
    if(escalation)clearTimeout(escalation);
    process.off('SIGTERM',term);process.off('SIGINT',int);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.length!==4||process.argv[2]!=='--config-dir'||!isAbsolute(process.argv[3]!)){process.exitCode=1;}
  else{
    const result=await runClaudeWrapper(process.argv[3]!);
    if(result.signal)process.kill(process.pid,result.signal);else process.exitCode=result.code??1;
  }
}
