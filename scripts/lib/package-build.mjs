import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTarGz, createZip } from './archive.mjs';
import { PackageError, inspectFrontend, sha256, walk } from './frontend.mjs';
import { assertSafeInputs, classify } from './rules.mjs';

export const APK_BUDGET_BYTES = 20 * 1024 * 1024;
export const MANIFEST_NAME = 'lumendock-manifest.json';
export const SUMS_NAME = 'SHA256SUMS';
const DOCS = ['README.md', 'LICENSE', 'CHANGELOG.md', 'docs/SETUP.md', 'docs/TESTING.md', 'docs/QUICKSTART.md', 'docs/WINDOWS.md'];
const MANIFESTS = ['package.json', 'package-lock.json', '.nvmrc', 'desktop/package.json', 'packages/protocol/package.json', 'dashboard/package.json'];
// Thin wrappers behind `npm run doctor|connect|install-hub|...` over the built desktop modules.
const SCRIPTS = ['workspace', 'doctor', 'connect', 'install-hub', 'uninstall-hub', 'claude-install', 'claude-uninstall'].map(name => `scripts/${name}.mjs`).concat('scripts/lib/dist.mjs');
const LINUX = ['phone-monitor.sh', 'scripts/phone-monitor.sh', 'scripts/phone-monitor-tray.py', 'scripts/linux/install-desktop.sh', 'scripts/linux/lumendock.png', 'scripts/linux/lumendock-48.png'];
const WINDOWS = ['scripts/windows/lumendock.ps1', 'scripts/windows/lumendock-tray.ps1', 'scripts/windows/install.ps1', 'scripts/windows/Install.cmd', 'scripts/windows/lumendock.ico'];
const EXECUTABLE = new Set(['phone-monitor.sh', 'scripts/phone-monitor.sh', 'scripts/phone-monitor-tray.py', 'scripts/linux/install-desktop.sh']);
const REQUIRED = ['desktop/dist/main.js', 'packages/protocol/dist/index.js'];
const TEXT = /\.(js|mjs|cjs|json|md|txt|sh|py|ps1|cmd|svg|map)$|(^|\/)(LICENSE|\.nvmrc)$/;

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const atomicWrite = (path, data) => { writeFileSync(`${path}.partial`, data); renameSync(`${path}.partial`, path); };
// Line endings follow the target, not the checkout, so both bundles are the same from any machine.
const lineEndings = (path, data, crlf) => {
  if (!TEXT.test(path)) return data;
  const lf = Buffer.from(data).toString('utf8').replace(/\r\n/g, '\n');
  return Buffer.from(crlf ? lf.replace(/\n/g, '\r\n') : lf, 'utf8');
};

function fileEntry(root, path) {
  const full = resolve(root, path);
  if (!existsSync(full)) throw new PackageError(`Required input is missing: ${path}`);
  const stat = lstatSync(full);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new PackageError(`Input is not a regular file: ${path}`);
  return { path, data: readFileSync(full) };
}
function treeEntries(root, directory) {
  const base = resolve(root, directory);
  if (!existsSync(base)) throw new PackageError(`Built output is missing: ${directory}. Run: npm run build`);
  return walk(base).map(file => ({ path: `${directory}/${file.path}`, data: readFileSync(file.full) }));
}

export function installInstructions(platform, version, nodeVersion) {
  const top = `lumendock-desktop-${version}`;
  const lines = platform === 'windows' ? [
    `LumenDock for Windows ${version}`,
    '',
    `1. Install Node.js ${nodeVersion.split('.')[0]} (LTS) from https://nodejs.org.`,
    `2. Extract this zip to a folder you keep (for example Documents\\LumenDock).`,
    '3. Double-click Install.cmd. It installs the hub, offers to download adb from Google,',
    '   and puts a LumenDock icon on the desktop. Nothing starts with Windows.',
    '4. Plug the phone in, tap "Allow USB debugging", double-click LumenDock, then choose',
    '   "Pair phone..." in its tray menu. Details: docs\\WINDOWS.md.',
  ] : [
    `LumenDock for Linux (Ubuntu/GNOME) ${version}`,
    '',
    `1. Use Node ${nodeVersion} (this package does not ship a Node binary) and adb (sudo apt install adb).`,
    `2. tar -xzf ${top}-linux.tar.gz -C ~/Apps  (any folder you keep), then cd into ${top}`,
    '3. npm ci --omit=dev --workspace @phone-monitor/desktop',
    '4. ./scripts/linux/install-desktop.sh   # app-grid and desktop launcher; nothing starts at login',
    '5. Plug the phone in, tap "Allow USB debugging", open LumenDock, then "Pair Phone..." in its',
    '   top-bar menu (or ./phone-monitor.sh pair). Details: docs/QUICKSTART.md.',
  ];
  return [...lines, '', 'No account tokens, pairing tokens, Wi-Fi passwords or provider credentials are included.', 'The Android APK is a separate file listed in SHA256SUMS.', ''].join('\n');
}

// Builds the deterministic Linux and Windows desktop bundles, verifies the frontend, and writes
// checksums plus a manifest into `out`. Builds nothing itself.
export function packageProject({ root, out = join(root, 'artifacts'), log = () => {} }) {
  root = resolve(root);
  out = resolve(out);
  const frontend = inspectFrontend(join(root, 'dashboard/dist'));
  const desktop = readJson(join(root, 'desktop/package.json'));
  const rootPackage = readJson(join(root, 'package.json'));
  const version = String(desktop.version ?? rootPackage.version ?? '0.0.0');
  const nodeVersion = existsSync(join(root, '.nvmrc')) ? readFileSync(join(root, '.nvmrc'), 'utf8').trim() : '24';
  const top = `lumendock-desktop-${version}`;

  const common = [
    ...treeEntries(root, 'desktop/dist'), ...treeEntries(root, 'packages/protocol/dist'),
    ...MANIFESTS.map(path => fileEntry(root, path)), ...DOCS.map(path => fileEntry(root, path)),
    ...SCRIPTS.map(path => fileEntry(root, path))
  ];
  const linuxOnly = LINUX.map(path => fileEntry(root, path));
  const windowsOnly = WINDOWS.map(path => fileEntry(root, path));
  const forbidden = [...common, ...linuxOnly, ...windowsOnly].filter(entry => classify(entry.path) === 'forbidden');
  if (forbidden.length) throw new PackageError(forbidden.map(entry => `Refusing to package forbidden path: ${entry.path}`));
  const shipped = common.filter(entry => classify(entry.path) === 'include');
  for (const path of REQUIRED) if (!shipped.some(entry => entry.path === path)) throw new PackageError(`Built output is incomplete: ${path} is missing. Run: npm run build`);
  assertSafeInputs([...shipped, ...linuxOnly, ...windowsOnly]);

  const linuxMembers = [...shipped, ...linuxOnly, { path: 'INSTALL.txt', data: Buffer.from(installInstructions('linux', version, nodeVersion)) }]
    .map(entry => ({ path: `${top}/${entry.path}`, data: lineEndings(entry.path, entry.data, false), mode: EXECUTABLE.has(entry.path) ? 0o755 : 0o644 }));
  const windowsMembers = [...shipped, ...windowsOnly,
    { path: 'Install.cmd', data: windowsOnly.find(entry => entry.path === 'scripts/windows/Install.cmd').data },
    { path: 'INSTALL.txt', data: Buffer.from(installInstructions('windows', version, nodeVersion)) }]
    .map(entry => ({ path: `${top}/${entry.path}`, data: lineEndings(entry.path, entry.data, /\.(cmd|txt)$/.test(entry.path)) }));
  const bundles = [
    { platform: 'linux', name: `${top}-linux.tar.gz`, members: linuxMembers, bytes: createTarGz(linuxMembers) },
    { platform: 'windows', name: `${top}-windows.zip`, members: windowsMembers, bytes: createZip(windowsMembers) },
  ];

  // The Android build output, if present. Absence is allowed while Android tasks are open.
  const apks = [];
  const apkProblems = [];
  const apkNames = existsSync(out) ? readdirSync(out).filter(file => /^(phone-monitor|lumendock)-.*\.apk$/.test(file)).sort() : [];
  for (const file of apkNames) {
    if (/diagnostic/i.test(file)) { apkProblems.push(`Diagnostic APK must not be packaged: ${file}`); continue; }
    const stat = lstatSync(join(out, file));
    if (!stat.isFile() || stat.isSymbolicLink()) { apkProblems.push(`APK is not a regular file: ${file}`); continue; }
    if (stat.size > APK_BUDGET_BYTES) apkProblems.push(`${file} is ${stat.size} bytes; budget is ${APK_BUDGET_BYTES}`);
    apks.push({ name: file, size: stat.size, sha256: sha256(readFileSync(join(out, file))) });
  }
  if (apkProblems.length) throw new PackageError(apkProblems);

  const manifest = {
    format: 2, name: 'lumendock-desktop', version, node: nodeVersion,
    installCommand: 'npm ci --omit=dev --workspace @phone-monitor/desktop',
    bundles: bundles.map(bundle => ({
      platform: bundle.platform, name: bundle.name, size: bundle.bytes.length, sha256: sha256(bundle.bytes),
      files: bundle.members.map(member => ({ path: member.path, size: member.data.length, sha256: sha256(member.data) })).sort((a, b) => (a.path < b.path ? -1 : 1)),
    })),
    frontend: { jsCssBytes: frontend.jsCssBytes, budgetBytes: frontend.budgetBytes, files: frontend.files },
    apk: apks.length
      ? { present: true, budgetBytes: APK_BUDGET_BYTES, files: apks }
      : { present: false, budgetBytes: APK_BUDGET_BYTES, note: 'No artifacts/lumendock-*.apk or phone-monitor-*.apk found; Android build is not part of this package.' }
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const sums = [
    ...bundles.map(bundle => ({ name: bundle.name, sha256: sha256(bundle.bytes) })),
    { name: MANIFEST_NAME, sha256: sha256(manifestBytes) },
    ...apks.map(apk => ({ name: apk.name, sha256: apk.sha256 }))
  ].sort((a, b) => (a.name < b.name ? -1 : 1));
  const sumsText = sums.map(item => `${item.sha256}  ${item.name}\n`).join('');

  mkdirSync(out, { recursive: true });
  // Bundles from older layouts would otherwise sit next to the new ones unchecksummed.
  for (const file of readdirSync(out)) if (/^(phone-monitor-desktop-.*\.tar\.gz|phone-monitor-manifest\.json)$/.test(file)) rmSync(join(out, file));
  for (const bundle of bundles) atomicWrite(join(out, bundle.name), bundle.bytes);
  atomicWrite(join(out, MANIFEST_NAME), manifestBytes);
  atomicWrite(join(out, SUMS_NAME), sumsText);
  for (const bundle of bundles) log(`${bundle.platform} bundle: ${bundle.name} (${bundle.bytes.length} bytes, ${bundle.members.length} files)`);
  log(`frontend JS+CSS: ${frontend.jsCssBytes} of ${frontend.budgetBytes} bytes`);
  log(apks.length ? `APK: ${apks.map(apk => `${apk.name} (${apk.size} bytes)`).join(', ')}` : 'APK: none found (Android build not packaged)');
  return { out, bundles: bundles.map(bundle => bundle.name), manifest, sums: sumsText };
}
