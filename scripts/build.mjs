import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--diagnostic')) throw new Error('Usage: node scripts/build.mjs [--diagnostic]');
const diagnostic = args.includes('--diagnostic');
let toolchain = {};
const manifest = resolve(root, '.superpowers/toolchain.json');
if (existsSync(manifest)) toolchain = JSON.parse(readFileSync(manifest, 'utf8'));
const java = process.env.JAVA_HOME || toolchain.jdk;
const sdk = process.env.ANDROID_HOME || toolchain.sdk;
if (!java || !existsSync(resolve(java, 'bin/javac')) || !sdk) throw new Error('Set JAVA_HOME to JDK 17 and ANDROID_HOME to Android SDK 36; system defaults are not changed.');
function run(binary, argv, env = process.env) {
  const result = spawnSync(binary, argv, {cwd: root, env, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!diagnostic) {
  const npm = resolve(dirname(process.execPath), 'npm');
  run(npm, ['run', 'build', '--workspace', 'dashboard'], {...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`});
  if (!existsSync(resolve(root, 'dashboard/dist/index.html'))) throw new Error('Production dashboard bundle is missing.');
}
run(resolve(root, 'android/gradlew'), ['-p', 'android', ...(diagnostic ? ['-PdiagnosticUi=true'] : []), ':app:testDebugUnitTest', ':app:lintDebug', ':app:assembleDebug'], {...process.env, JAVA_HOME: java, ANDROID_HOME: sdk});
