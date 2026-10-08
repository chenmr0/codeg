#!/usr/bin/env node
// Read-only ELF audit. Never invokes an inspected executable (including ldd).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const allowedLibraries = new Set(['libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1', 'ld-linux-x86-64.so.2']);
export function auditPortableElf(root, maxGlibc = '2.17') {
  const report = [];
  const readelf = (args, filename) => {
    const result = spawnSync('readelf', [...args, filename], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`readelf failed for ${filename}: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
  };
  const newer = (value, limit) => {
    const a = value.split('.').map(Number), b = limit.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return false;
  };
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink in portable payload: ${filename}`);
      if (entry.isDirectory()) { walk(filename); continue; }
      if (!entry.isFile()) throw new Error(`Special file in portable payload: ${filename}`);
      if (filename.endsWith('.node')) throw new Error(`Native addon requires explicit ABI review: ${filename}`);
      const fd = fs.openSync(filename, 'r'), magic = Buffer.alloc(4);
      try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
      const header = readelf(['-h'], filename);
      if (!/Class:\s+ELF64/.test(header) || !/Machine:\s+Advanced Micro Devices X86-64/.test(header)) throw new Error(`Wrong ELF architecture: ${filename}`);
      const dynamic = readelf(['-d'], filename);
      const libraries = [...dynamic.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(x => x[1]);
      for (const lib of libraries) if (!allowedLibraries.has(lib)) throw new Error(`Unbundled dynamic dependency ${lib}: ${filename}`);
      if (/\((RPATH|RUNPATH)\)/.test(dynamic)) throw new Error(`Unexpected ELF search path: ${filename}`);
      const versions = readelf(['-V'], filename);
      if (/GLIBCXX_|CXXABI_/.test(versions)) throw new Error(`Dynamic C++ runtime dependency: ${filename}`);
      const glibc = [...new Set([...versions.matchAll(/GLIBC_([0-9.]+)/g)].map(x => x[1]))];
      for (const version of glibc) if (newer(version, maxGlibc)) throw new Error(`GLIBC_${version} exceeds ${maxGlibc}: ${filename}`);
      if (/GLIBC_PRIVATE/.test(versions)) throw new Error(`Private glibc ABI required: ${filename}`);
      const program = readelf(['-l'], filename);
      const interpreter = program.match(/Requesting program interpreter:\s*([^\]]+)\]/)?.[1] ?? null;
      if (interpreter && interpreter !== '/lib64/ld-linux-x86-64.so.2') throw new Error(`Unexpected loader ${interpreter}: ${filename}`);
      const relative = path.relative(root, filename).split(path.sep).join('/');
      if (relative !== 'node' && (libraries.length || interpreter)) throw new Error(`Helper must be static: ${relative}`);
      report.push({ file: relative, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), libraries, interpreter, glibc });
    }
  };
  walk(root);
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: audit-portable-elf.mjs BUNDLE_DIR');
  console.log(JSON.stringify(auditPortableElf(path.resolve(process.argv[2])), null, 2));
}
