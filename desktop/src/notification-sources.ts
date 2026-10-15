import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Labels are explicit privacy selections, never inferred from notification titles or message text.
const NATIVE_SELECTED = ['Claude','Claude Code','Codex','codex','WhatsApp','WhatsApp Web'];
const PREFIX = 'desktop-entry:whatsapp:';
export function whatsAppDesktopEntry(selector:string):string|null {
  if(!selector.startsWith(PREFIX))return null;
  const entry=selector.slice(PREFIX.length);
  return /^chrome-[a-p]{32}-[A-Za-z0-9_-]{1,20}$/.test(entry)&&selector.length<=80?entry:null;
}
export function notificationDisplayLabel(selector:string):string {return whatsAppDesktopEntry(selector)?'WhatsApp':selector;}
export function notificationApplicationDirectories():string[] {
  return [join(process.env.XDG_DATA_HOME||join(homedir(),'.local/share'),'applications'),...((process.env.XDG_DATA_DIRS||'/usr/local/share:/usr/share').split(':').filter(Boolean).map(dir=>join(dir,'applications')))];
}
/** Inspect only small .desktop metadata, never browser profiles or Exec output. */
export function discoverSelectedNotificationApps(directories:readonly string[]=notificationApplicationDirectories()):string[] {
  const selectors=[...NATIVE_SELECTED];
  for(const directory of directories){
    let files:string[];try{files=readdirSync(directory).slice(0,2000);}catch{continue;}
    for(const name of files){
      if(!/^chrome-[a-p]{32}-[A-Za-z0-9_-]{1,20}\.desktop$/.test(name))continue;
      let fd:number|undefined;
      try{
        fd=openSync(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW);
        const info=fstatSync(fd);if(!info.isFile()||info.size>16384)continue;
        const text=readFileSync(fd,'utf8'),fields:Record<string,string>={};let main=false;
        for(const line of text.split(/\r?\n/)){
          if(line.startsWith('[')){main=line==='[Desktop Entry]';continue;}
          if(!main)continue;const match=/^([A-Za-z0-9-]+)=(.*)$/.exec(line);if(match)fields[match[1]!]=match[2]!;
        }
        if(!['WhatsApp','WhatsApp Web'].includes(fields.Name??'')||fields.Hidden==='true'||fields.NoDisplay==='true')continue;
        const id=/^chrome-([a-p]{32})-/.exec(name)?.[1];
        if(!id||fields.StartupWMClass!==`crx_${id}`||!new RegExp(`(?:^|\\s)--app-id=${id}(?:\\s|$)`).test(fields.Exec??''))continue;
        const selector=PREFIX+name.slice(0,-8);
        if(whatsAppDesktopEntry(selector)&&!selectors.includes(selector)&&selectors.length<10)selectors.push(selector);
      }catch{/* Invalid or unsafe metadata cannot broaden capture. */}finally{if(fd!==undefined)closeSync(fd);}
    }
  }
  return selectors;
}
