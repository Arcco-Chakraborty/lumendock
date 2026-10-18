import { crc32, deflateRawSync, gzipSync } from 'node:zlib';

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

// Minimal deterministic zip writer (deflate, fixed 1980-01-01 timestamps, sorted names), for the
// Windows bundle: Explorer opens zip files natively.
export function createZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const local = [], central = [];
  let offset = 0;
  const seen = new Set();
  for (const entry of sorted) {
    if (seen.has(entry.path)) throw new Error(`Duplicate archive path: ${entry.path}`);
    seen.add(entry.path);
    if (entry.path.startsWith('/') || entry.path.split('/').includes('..') || entry.path.includes('\0')) throw new Error(`Unsafe archive path: ${entry.path}`);
    const name = Buffer.from(entry.path, 'utf8');
    const data = Buffer.from(entry.data);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10); header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(8, 10);
    record.writeUInt16LE(0, 12); record.writeUInt16LE(0x21, 14); record.writeUInt32LE(crc, 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    local.push(header, name, packed);
    central.push(record, name);
    offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
