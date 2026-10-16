import { readFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--diagnostic' && arg !== '--release') || args.length > 1)
  throw new Error('Usage: node scripts/build.mjs [--diagnostic | --release]');
const diagnostic = args.includes('--diagnostic');
// --release signs with the private keystore described by LUMENDOCK_SIGNING (default:
// ~/.local/share/phone-monitor/signing/release.properties). The keystore never enters the repository.
const release = args.includes('--release');
const signing = process.env.LUMENDOCK_SIGNING || resolve(homedir(), '.local/share/phone-monitor/signing/release.properties');
if (release && !existsSync(signing)) throw new Error(`Release signing properties not found at ${signing}. Set LUMENDOCK_SIGNING to its path.`);
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
const tasks = release
  ? [`-PlumendockSigning=${signing}`, ':app:testDebugUnitTest', ':app:lintRelease', ':app:assembleRelease']
  : [...(diagnostic ? ['-PdiagnosticUi=true'] : []), ':app:testDebugUnitTest', ':app:lintDebug', ':app:assembleDebug'];
run(resolve(root, 'android/gradlew'), ['-p', 'android', ...tasks], {...process.env, JAVA_HOME: java, ANDROID_HOME: sdk});
if (release) {
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const built = resolve(root, 'android/app/build/outputs/apk/release/app-release.apk');
  if (!existsSync(built)) throw new Error('Gradle reported success but the signed release APK is missing.');
  const apksigner = resolve(sdk, 'build-tools', toolchain.buildTools || '36.0.0', 'apksigner');
  run(apksigner, ['verify', '--verbose', '--print-certs', built], {...process.env, JAVA_HOME: java, PATH: `${resolve(java, 'bin')}:${process.env.PATH ?? ''}`});
  mkdirSync(resolve(root, 'artifacts'), {recursive: true});
  // A release package must never pick up a stale debug build next to it.
  rmSync(resolve(root, 'artifacts/phone-monitor-debug.apk'), {force: true});
  copyFileSync(built, resolve(root, `artifacts/lumendock-${version}.apk`));
  console.log(`Signed release APK copied to artifacts/lumendock-${version}.apk`);
  process.exit(0);
}
if (!diagnostic) {
  // Only a production build is published as an artifact; diagnostic APKs stay in android/app/build.
  const built = resolve(root, 'android/app/build/outputs/apk/debug/app-debug.apk');
  if (!existsSync(built)) throw new Error('Gradle reported success but the APK is missing.');
  mkdirSync(resolve(root, 'artifacts'), {recursive: true});
  copyFileSync(built, resolve(root, 'artifacts/phone-monitor-debug.apk'));
  console.log('Production APK copied to artifacts/phone-monitor-debug.apk');
}
