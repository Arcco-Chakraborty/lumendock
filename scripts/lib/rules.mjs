import { PackageError } from './frontend.mjs';

// Fail-closed classification of repository-relative paths that might be packaged.
//  - 'forbidden': secrets, private config, user toolchains, VCS data, build caches. Seeing
//    one among the inputs aborts packaging instead of silently dropping it.
//  - 'skip': harmless build by-products that are simply not shipped.
//  - 'include': everything else.
const FORBIDDEN_SEGMENTS = new Set(['node_modules', '.git', '.config', '.ssh', '.gnupg', '.superpowers', '.gradle', '.toolchain', 'toolchains', 'artifacts', '.codex', '.claude']);
const FORBIDDEN_NAME = [
  /^\.env/i, /^\.npmrc$/i, /^\.netrc$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /^local\.properties$/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer)$/i,
  /(^|[-_.])(token|secret|secrets|credential|credentials|password|passwd|auth)([-_.]|$)/i,
  /^node(\.exe)?$/i, /^node-v\d/i, /^phone-token$/i
];
const SKIP_NAME = [/\.d\.ts$/, /\.d\.ts\.map$/, /\.tsbuildinfo$/, /\.test\.[cm]?[jt]s$/, /\.log$/, /^\.DS_Store$/];

export function classify(path) {
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return 'forbidden';
  const parts = path.split('/');
  if (parts.includes('..') || parts.includes('.')) return 'forbidden';
  if (parts.some(part => FORBIDDEN_SEGMENTS.has(part))) return 'forbidden';
  const name = parts[parts.length - 1];
  if (FORBIDDEN_NAME.some(pattern => pattern.test(name))) return 'forbidden';
  if (SKIP_NAME.some(pattern => pattern.test(name))) return 'skip';
  return 'include';
}

// Content that must never appear in a shipped file.
const CONTENT_BLOCKS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key material'],
  [/\/home\/[A-Za-z0-9._-]+\//, 'absolute home-directory path'],
  [/\/Users\/[A-Za-z0-9._-]+\//, 'absolute home-directory path'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'cloud access key id']
];
export function contentProblems(path, data) {
  if (!/\.(js|mjs|cjs|json|md|txt|html|css|svg|sums)$/i.test(path)) return [];
  const text = Buffer.from(data).toString('utf8');
  return CONTENT_BLOCKS.filter(([pattern]) => pattern.test(text)).map(([, label]) => `${path} contains ${label}`);
}
export function assertSafeInputs(entries) {
  const problems = [];
  for (const entry of entries) {
    if (classify(entry.path) === 'forbidden') problems.push(`Refusing to package forbidden path: ${entry.path}`);
    else problems.push(...contentProblems(entry.path, entry.data));
  }
  if (problems.length) throw new PackageError(problems);
}
