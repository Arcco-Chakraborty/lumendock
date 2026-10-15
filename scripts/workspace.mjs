import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../',import.meta.url));
const runNpm = command => {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run this command through npm.');
  const result = spawnSync(process.execPath,[npm,'run',command],{cwd:root,stdio:'inherit'});
  if (result.error || result.status !== 0) process.exit(result.status || 1);
};
const command = process.argv[2];
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('Use the user-owned Node 24 toolchain specified in .nvmrc.'); process.exit(1);
}
if (command === 'verify') {
  for (const task of ['test','typecheck','build']) runNpm(task);
} else if (command === 'doctor') {
  console.log(`Node ${process.versions.node}: supported`);
  console.log(`Runtime: ${process.execPath}`);
  for (const [label,path] of [['Desktop hub','desktop/dist/main.js'],['Android APK','artifacts/phone-monitor-debug.apk']]) console.log(`${label}: ${existsSync(new URL('../'+path,import.meta.url)) ? 'built' : 'not built'}`);
} else if (command === 'connect' || command === 'package') {
  const path = new URL(`./${command}.mjs`,import.meta.url);
  if (!existsSync(path)) {
    console.error(`${command} requires the desktop installation/packaging task (D3), which has not been implemented yet.`); process.exit(1);
  }
  const result = spawnSync(process.execPath,[fileURLToPath(path),...process.argv.slice(3)],{cwd:root,stdio:'inherit'});
  process.exit(result.status || (result.error ? 1 : 0));
} else { console.error('Unknown workspace command.'); process.exit(1); }
