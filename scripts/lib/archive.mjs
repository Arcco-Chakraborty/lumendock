import { gzipSync } from 'node:zlib';

// Minimal deterministic ustar writer: sorted names, fixed mtime/uid/gid/owner, no
// timestamps from the filesystem. The same inputs always give the same bytes.
const BLOCK = 512;
function field(buffer, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
  bytes.copy(buffer, offset);
}
const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';
function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return ['', name];
  for (let index = name.lastIndexOf('/'); index > 0; index = name.lastIndexOf('/', index - 1)) {
    const prefix = name.slice(0, index), rest = name.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return [prefix, rest];
  }
  throw new Error(`Archive path too long for ustar: ${name}`);
}
export function createTar(entries) {
  const seen = new Set();
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks = [];
  for (const entry of sorted) {
    if (seen.has(entry.path)) throw new Error(`Duplicate archive path: ${entry.path}`);
    seen.add(entry.path);
    if (entry.path.startsWith('/') || entry.path.split('/').includes('..') || entry.path.includes('\0')) throw new Error(`Unsafe archive path: ${entry.path}`);
    const data = Buffer.from(entry.data);
    const header = Buffer.alloc(BLOCK);
    const [prefix, name] = splitName(entry.path);
    field(header, 0, 100, name);
    field(header, 100, 8, octal(entry.mode ?? 0o644, 8));
    field(header, 108, 8, octal(0, 8));
    field(header, 116, 8, octal(0, 8));
    field(header, 124, 12, octal(data.length, 12));
    field(header, 136, 12, octal(0, 12));
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    field(header, 257, 6, 'ustar\0');
    field(header, 263, 2, '00');
    field(header, 345, 155, prefix);
    let sum = 0;
    for (const byte of header) sum += byte;
    field(header, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
    chunks.push(header, data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}
export const createTarGz = entries => gzipSync(createTar(entries), { level: 9 });
