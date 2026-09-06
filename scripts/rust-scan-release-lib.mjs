import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export function artifactApi(root) {
  const file = path.join(root, 'dist/extraction/rust-scan-artifact.js');
  if (!fs.existsSync(file)) throw new Error('Run npm run build before preparing native release artifacts.');
  return require(file);
}
export function nativeSourceHash(root) {
  const hash = createHash('sha256');
  for (const file of ['Cargo.toml', 'Cargo.lock', 'src/main.rs']) {
    hash.update(file + '\0');
    hash.update(fs.readFileSync(path.join(root, 'codegraph-scan', file), 'utf8').replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex');
}
/** Refuse an interpreter or dynamic dependencies in the Linux musl artifact. */
export function checkExecutable(bytes, platform) {
  if (platform === 'win32') {
    if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Expected Windows PE executable');
    const pe = bytes.readUInt32LE(60);
    if (pe + 6 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error('Expected x64 Windows executable');
    return;
  }
  if (bytes.length < 64 || bytes.toString('hex', 0, 4) !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) throw new Error('Expected x64 little-endian Linux ELF');
  const offset = Number(bytes.readBigUInt64LE(32));
  const entrySize = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  if (!Number.isSafeInteger(offset) || entrySize < 56 || offset + entrySize * count > bytes.length) throw new Error('Invalid ELF program headers');
  for (let i = 0; i < count; i++) {
    const p = offset + i * entrySize, kind = bytes.readUInt32LE(p);
    if (kind === 3) throw new Error('Linux helper must not depend on a dynamic interpreter');
    if (kind !== 2) continue;
    const begin = Number(bytes.readBigUInt64LE(p + 8)), size = Number(bytes.readBigUInt64LE(p + 32));
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(size) || begin + size > bytes.length) throw new Error('Invalid ELF dynamic section');
    for (let d = begin; d + 16 <= begin + size; d += 16) {
      const tag = bytes.readBigUInt64LE(d);
      if (tag === 0n) break;
      if (tag === 1n) throw new Error('Linux helper must not require shared libraries');
    }
  }
}
