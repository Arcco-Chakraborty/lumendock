import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTarGz } from './archive.mjs';
import { PackageError, inspectFrontend, sha256, walk } from './frontend.mjs';
import { assertSafeInputs, classify } from './rules.mjs';

export const APK_BUDGET_BYTES = 20 * 1024 * 1024;
export const MANIFEST_NAME = 'phone-monitor-manifest.json';
export const SUMS_NAME = 'SHA256SUMS';
const DOCS = ['docs/SETUP.md', 'docs/TESTING.md'];
const MANIFESTS = ['package.json', 'package-lock.json', '.nvmrc', 'desktop/package.json', 'packages/protocol/package.json', 'dashboard/package.json'];
// Thin wrappers behind `npm run doctor|connect|install-hub|...` over the built desktop modules.
const SCRIPTS = ['workspace', 'doctor', 'connect', 'install-hub', 'uninstall-hub', 'claude-install', 'claude-uninstall'].map(name => `scripts/${name}.mjs`).concat('scripts/lib/dist.mjs');
const REQUIRED = ['desktop/dist/main.js', 'packages/protocol/dist/index.js'];

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const atomicWrite = (path, data) => { writeFileSync(`${path}.partial`, data); renameSync(`${path}.partial`, path); };

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

export function installInstructions(name, version, nodeVersion) {
  const top = `${name}-${version}`;
  return [
    `LumenDock desktop package ${version}`,
    '',
    'Clean install (exact lockfile versions, production dependencies only):',
    `  1. Use Node ${nodeVersion} (user-owned toolchain; this package does not ship a Node binary).`,
    `  2. tar -xzf ${top}.tar.gz && cd ${top}`,
    '  3. npm ci --omit=dev --workspace @phone-monitor/desktop',
    '  4. npm run doctor   # then follow docs/SETUP.md for pairing, USB and the hub service',
    '',
    'No account tokens, pairing tokens, Wi-Fi passwords or provider credentials are included.',
    'The Android APK (if built) is a separate file listed in SHA256SUMS.',
    ''
  ].join('\n');
}

// Builds the deterministic desktop bundle, verifies the frontend, and writes
// checksums plus a manifest into `out`. Builds nothing itself.
export function packageProject({ root, out = join(root, 'artifacts'), log = () => {} }) {
  root = resolve(root);
  out = resolve(out);
  const frontend = inspectFrontend(join(root, 'dashboard/dist'));
  const desktop = readJson(join(root, 'desktop/package.json'));
  const rootPackage = readJson(join(root, 'package.json'));
  const version = String(desktop.version ?? rootPackage.version ?? '0.0.0');
  const nodeVersion = existsSync(join(root, '.nvmrc')) ? readFileSync(join(root, '.nvmrc'), 'utf8').trim() : '24';
  const name = 'phone-monitor-desktop';
  const top = `${name}-${version}`;

  const collected = [
    ...treeEntries(root, 'desktop/dist'), ...treeEntries(root, 'packages/protocol/dist'),
    ...MANIFESTS.map(path => fileEntry(root, path)), ...DOCS.map(path => fileEntry(root, path)),
    ...SCRIPTS.map(path => fileEntry(root, path))
  ];
  const forbidden = collected.filter(entry => classify(entry.path) === 'forbidden');
  if (forbidden.length) throw new PackageError(forbidden.map(entry => `Refusing to package forbidden path: ${entry.path}`));
  const shipped = collected.filter(entry => classify(entry.path) === 'include');
  for (const path of REQUIRED) if (!shipped.some(entry => entry.path === path)) throw new PackageError(`Built output is incomplete: ${path} is missing. Run: npm run build`);
  shipped.push({ path: 'INSTALL.txt', data: Buffer.from(installInstructions(name, version, nodeVersion)) });
  assertSafeInputs(shipped);

  const members = shipped.map(entry => ({ path: `${top}/${entry.path}`, data: entry.data }));
  const tarball = createTarGz(members);
  const tarballName = `${top}.tar.gz`;

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
    format: 1, name, version, node: nodeVersion,
    installCommand: 'npm ci --omit=dev --workspace @phone-monitor/desktop',
    tarball: { name: tarballName, size: tarball.length, sha256: sha256(tarball) },
    files: members.map(member => ({ path: member.path, size: member.data.length, sha256: sha256(member.data) })).sort((a, b) => (a.path < b.path ? -1 : 1)),
    frontend: { jsCssBytes: frontend.jsCssBytes, budgetBytes: frontend.budgetBytes, files: frontend.files },
    apk: apks.length
      ? { present: true, budgetBytes: APK_BUDGET_BYTES, files: apks }
      : { present: false, budgetBytes: APK_BUDGET_BYTES, note: 'No artifacts/lumendock-*.apk or phone-monitor-*.apk found; Android build is not part of this package.' }
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const sums = [
    { name: tarballName, sha256: manifest.tarball.sha256 },
    { name: MANIFEST_NAME, sha256: sha256(manifestBytes) },
    ...apks.map(apk => ({ name: apk.name, sha256: apk.sha256 }))
  ].sort((a, b) => (a.name < b.name ? -1 : 1));
  const sumsText = sums.map(item => `${item.sha256}  ${item.name}\n`).join('');

  mkdirSync(out, { recursive: true });
  atomicWrite(join(out, tarballName), tarball);
  atomicWrite(join(out, MANIFEST_NAME), manifestBytes);
  atomicWrite(join(out, SUMS_NAME), sumsText);
  log(`desktop bundle: ${tarballName} (${tarball.length} bytes, ${members.length} files)`);
  log(`frontend JS+CSS: ${frontend.jsCssBytes} of ${frontend.budgetBytes} bytes`);
  log(apks.length ? `APK: ${apks.map(apk => `${apk.name} (${apk.size} bytes)`).join(', ')}` : 'APK: none found (Android build not packaged)');
  return { out, tarballName, manifest, sums: sumsText };
}
