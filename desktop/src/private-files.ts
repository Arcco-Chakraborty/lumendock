import { constants, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

// Windows has no POSIX owner ids (stat reports uid 0 and process.getuid is absent); there the
// per-user profile ACL is what keeps these files private, so ownership checks pass.
export const ownedByCurrentUser=(s:{uid:number}):boolean=>process.getuid?s.uid===process.getuid():true;

export function ensurePrivateDirectory(path:string):void {
  mkdirSync(path,{recursive:true,mode:0o700});
  const s=lstatSync(path);
  if(!s.isDirectory()||s.isSymbolicLink()||!ownedByCurrentUser(s)) throw Error('UNSAFE_CONFIG_DIRECTORY');
  chmodSync(path,0o700);
}
export function readPrivateJson(path:string,maxBytes=512*1024):unknown|null {
  if(!existsSync(path)) return null;
  return JSON.parse(readOwnedFile(path,maxBytes).toString('utf8'));
}
export function readOwnedFile(path:string,maxBytes:number):Buffer {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try { const s=fstatSync(fd); if(!s.isFile()||!ownedByCurrentUser(s)||s.size>maxBytes) throw Error('UNSAFE_FILE'); return readFileSync(fd); }
  finally {closeSync(fd);}
}
export function atomicWrite(path:string,bytes:string|Buffer,mode=0o600):void {
  const temp=join(dirname(path),`.phone-monitor-${randomBytes(12).toString('hex')}`);
  let fd:number|undefined;
  try {
    fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,mode);
    writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,path);
    // Windows cannot open a directory as a file; its rename is already durable enough there.
    if(process.platform!=='win32'){const parent=openSync(dirname(path),constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}}
  } finally {if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{/* renamed or not created */}}
}
// Advisory lock: all product writers use one atomic mkdir. Fail closed on a
// stale lock rather than stealing a possibly live owner's transaction.
export async function withLock<T>(path:string,operation:()=>T|Promise<T>,timeoutMs=1500):Promise<T> {
  const deadline=performance.now()+timeoutMs;
  for(;;){try{mkdirSync(path,{mode:0o700});break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(performance.now()>=deadline)throw Error('CONFIG_BUSY');await new Promise(resolve=>setTimeout(resolve,20));}}
  try{return await operation();}finally{rmdirSync(path);}
}
