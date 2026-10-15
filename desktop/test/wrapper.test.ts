import { it,expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync,readFileSync,existsSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';import { tmpdir } from 'node:os';
import { installClaudeStatusLine } from '../src/claude/install.js';
const compatibility={claudeVersion:'2.1.300',shellPath:'/bin/sh',shellVerified:true,cancellationVerified:true};
async function start(command:string|null){
 const dir=mkdtempSync(join(tmpdir(),"phone-monitor-wrapper ' $()`ユニ-"));const settingsPath=join(dir,'settings.json');writeFileSync(settingsPath,JSON.stringify(command===null?{}:{statusLine:{type:'command',command}}));
 await installClaudeStatusLine({settingsPath,configDir:join(dir,'private'),wrapperPath:resolve('src/claude/wrapper.ts'),nodePath:process.execPath,...(command===null?{}:{previousShell:'/bin/sh',compatibility})});
 const child=spawn(process.execPath,['--import','tsx',resolve('src/claude/wrapper.ts'),'--config-dir',join(dir,'private')],{stdio:['pipe','pipe','pipe']});
 let out=Buffer.alloc(0),err='';child.stdout.on('data',b=>out=Buffer.concat([out,b]));child.stderr.on('data',b=>err+=b);child.stdin.on('error',()=>{});
 const done=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 return {dir,child,done,output:()=>out,error:()=>err};
}
it('preserves all original stdin/stdout bytes and nonzero exit even when monitoring overflows',async()=>{
 const p=await start('cat; exit 7');const input=Buffer.from('synthetic $() `quotes` ユニ\n'.repeat(20000));p.child.stdin.end(input);
 expect(await p.done).toEqual({code:7,signal:null});expect(p.output()).toEqual(input);expect(p.error()).toBe('');expect(existsSync(join(p.dir,'private','claude-observations.json'))).toBe(false);
});
it('survives malformed capture, early EPIPE and keeps previous output/exit',async()=>{
 const p=await start("printf 'synthetic previous output'; exit 9");p.child.stdin.end(Buffer.alloc(900000,120));
 expect(await p.done).toEqual({code:9,signal:null});expect(p.output().toString()).toBe('synthetic previous output');expect(p.error()).toBe('');
 const invalid=await start('cat');invalid.child.stdin.end('not quota JSON');expect((await invalid.done).code).toBe(0);expect(invalid.output().toString()).toBe('not quota JSON');
});
it('captures standalone private observations without a running hub and labels no-command model',async()=>{
 const p=await start(null);p.child.stdin.end(JSON.stringify({session_id:'synthetic',model:{display_name:'Synthetic model'},cost:{total_api_duration_ms:10},rate_limits:{five_hour:{used_percentage:1,resets_at:1900000000}},transcript_path:'/synthetic/private-do-not-read'}));
 expect((await p.done).code).toBe(0);expect(p.output().toString()).toBe('[Synthetic model]\n');const data=readFileSync(join(p.dir,'private','claude-observations.json'),'utf8');expect(data).not.toContain('transcript');
});
it('terminates the tracked long-running process group and propagates cancellation',async()=>{
 const p=await start('sleep 120 & echo $!; wait');p.child.stdin.end('{}');
 await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('no descendant pid')),5000);const check=()=>{if(p.output().length){clearTimeout(timeout);resolve();}else setTimeout(check,10);};check();});
 const pid=Number(p.output().toString().trim());p.child.kill('SIGTERM');expect(await p.done).toEqual({code:null,signal:'SIGTERM'});
 let alive=true;try{process.kill(pid,0);}catch{alive=false;}
 // On minimal containers an orphan may briefly be a zombie until init reaps;
 // a zombie cannot execute and is no longer an owned live process.
 if(alive&&existsSync(`/proc/${pid}/stat`))expect(readFileSync(`/proc/${pid}/stat`,'utf8').split(' ')[2]).toBe('Z');else expect(alive).toBe(false);
 expect(p.error()).toBe('');
},10000);
it('escalates cancellation for a resistant descendant and repeated invocations leave no live groups',async()=>{
 for(let i=0;i<2;i++){
  const p=await start("trap '' TERM INT; sleep 120 & echo $!; wait");p.child.stdin.end('{}');
  await new Promise<void>((resolve,reject)=>{const until=setTimeout(()=>reject(Error('no resistant descendant')),5000);const check=()=>{if(p.output().length){clearTimeout(until);resolve();}else setTimeout(check,10);};check();});
  const pid=Number(p.output().toString().trim());p.child.kill('SIGINT');expect(await p.done).toEqual({code:null,signal:'SIGINT'});
  if(existsSync(`/proc/${pid}/stat`))expect(readFileSync(`/proc/${pid}/stat`,'utf8').split(' ')[2]).toBe('Z');
 }
},10000);
it('cleans up a resistant background descendant after the previous command exits normally',async()=>{
 const p=await start("trap '' TERM INT; sleep 120 & echo $!; exit 3");p.child.stdin.end('{}');expect(await p.done).toEqual({code:3,signal:null});
 const pid=Number(p.output().toString().trim());let alive=true;try{process.kill(pid,0);}catch{alive=false;}
 if(alive){const state=readFileSync(`/proc/${pid}/stat`,'utf8').split(' ')[2];try{process.kill(pid,'SIGKILL');}catch{}expect(state).toBe('Z');}
},10000);
