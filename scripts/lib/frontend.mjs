import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const FRONTEND_BUDGET_BYTES = 750 * 1024;
export class PackageError extends Error {
  constructor(problems) {
    const list = Array.isArray(problems) ? problems : [problems];
    super(list.join('\n'));
    this.name = 'PackageError';
    this.problems = list;
  }
}

// Strings that only exist in the development/demo/mock/diagnostic code paths.
export const DIAGNOSTIC_MARKERS = [
  [/createMockAdapter/, 'mock device adapter'],
  [/mocks\/(device|scenarios)/, 'mock module path'],
  [/synthetic/i, 'synthetic fixture data'],
  [/\.has\(["']demo["']\)/, 'demo query switch'],
  [/diagnostic/i, 'diagnostic UI marker']
];
// Namespace/identifier URIs that are never fetched. Any other absolute URL is remote.
const NON_FETCHED_URL = [
  /^https?:\/\/www\.w3\.org\//, /^https?:\/\/json-schema\.org\//,
  /^https:\/\/react\.dev\/errors\/?$/, /^http:\/\/\[\$\{/
];
const TEXT = /\.(html?|js|mjs|css|svg|json|txt|webmanifest)$/i;

export function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new PackageError(`Symbolic link refused: ${relative(base, full)}`);
    if (stat.isDirectory()) out.push(...walk(full, base));
    else if (stat.isFile()) out.push({ full, path: relative(base, full).split(sep).join('/'), size: stat.size });
  }
  return out;
}
export const sha256 = data => createHash('sha256').update(data).digest('hex');

// Verifies the production dashboard bundle and returns its measured contents.
export function inspectFrontend(dir, { budgetBytes = FRONTEND_BUDGET_BYTES } = {}) {
  const root = resolve(dir);
  const problems = [];
  let files;
  try { files = walk(root); } catch (error) {
    if (error instanceof PackageError) throw error;
    throw new PackageError(`Production dashboard bundle is missing at ${dir}. Run: npm run build --workspace @phone-monitor/dashboard`);
  }
  const html = files.find(file => file.path === 'index.html');
  if (!html) throw new PackageError(`Production dashboard bundle is missing index.html in ${dir}. Run: npm run build --workspace @phone-monitor/dashboard`);
  const index = readFileSync(html.full, 'utf8');
  const scripts = [...index.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  const styles = [...index.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)].map(match => match[1]);
  if (!scripts.length) problems.push('index.html references no script bundle');
  if (!styles.length) problems.push('index.html references no stylesheet');
  for (const ref of [...scripts, ...styles]) {
    if (/^([a-z]+:)?\/\//i.test(ref)) { problems.push(`index.html loads a remote asset: ${ref}`); continue; }
    const target = resolve(root, ref);
    if (!target.startsWith(root + sep) || !files.some(file => resolve(file.full) === target)) problems.push(`index.html references a missing asset: ${ref}`);
  }
  let jsCssBytes = 0;
  const listed = [];
  for (const file of files) {
    const data = readFileSync(file.full);
    listed.push({ path: file.path, size: file.size, sha256: sha256(data) });
    if (/\.(js|mjs|css)$/i.test(file.path)) jsCssBytes += file.size;
    if (/\.map$/i.test(file.path)) problems.push(`Source map would leak build paths: ${file.path}`);
    if (!TEXT.test(file.path)) continue;
    const text = data.toString('utf8');
    for (const [pattern, label] of DIAGNOSTIC_MARKERS)
      if (pattern.test(text)) problems.push(`${file.path} contains ${label}`);
    for (const url of text.match(/(?:https?:)?\/\/[^\s"'`)<>\\]+/g) ?? []) {
      if (!/^https?:\/\//.test(url)) {
        if (file.path.endsWith('.css') || file.path.endsWith('.html')) problems.push(`${file.path} references protocol-relative URL ${url}`);
        continue;
      }
      if (!NON_FETCHED_URL.some(pattern => pattern.test(url))) problems.push(`${file.path} contains remote URL ${url}`);
    }
  }
  if (jsCssBytes > budgetBytes) problems.push(`JS+CSS is ${jsCssBytes} bytes; budget is ${budgetBytes}`);
  if (problems.length) throw new PackageError([...new Set(problems)]);
  return { files: listed, jsCssBytes, budgetBytes };
}
