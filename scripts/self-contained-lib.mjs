import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const targets = ['win32-x64', 'linux-x64'];
export const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function cleanEnv(original = process.env) {
  return Object.fromEntries(Object.entries(original).filter(([key]) =>
    !/^CODEGRAPH_/i.test(key) && !/^NODE_OPTIONS$/i.test(key) &&
    !/^npm_config_(arch|platform|os|cpu|libc|omit|include|optional|ignore_scripts|production|force)$/i.test(key)));
}

export function targetInstallArgs(target) {
  if (!targets.includes(target)) throw new Error(`Unsupported target: ${target}`);
  return ['ci', '--omit=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund',
    `--os=${target.split('-')[0]}`, '--cpu=x64', ...(target === 'linux-x64' ? ['--libc=glibc'] : [])];
}

export function assertChecksum(file, expected) {
  if (sha256(file) !== expected) throw new Error(`SHA256 mismatch: ${file}`);
}

export function checkTargetExecutable(file, target, { staticLinux = false } = {}) {
  const bytes = fs.readFileSync(file);
  if (target === 'win32-x64') {
    if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error(`Expected PE: ${file}`);
    const pe = bytes.readUInt32LE(60);
    if (pe + 6 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== 0x8664)
      throw new Error(`Expected x64 PE: ${file}`);
  } else {
    if (bytes.length < 64 || bytes.toString('hex', 0, 4) !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62)
      throw new Error(`Expected x64 ELF: ${file}`);
    if (staticLinux) {
      const start = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
      if (!Number.isSafeInteger(start) || size < 56 || start + size * count > bytes.length) throw new Error('Invalid ELF headers');
      for (let i = 0; i < count; i++) {
        const p = start + i * size, kind = bytes.readUInt32LE(p);
        if (kind === 3) throw new Error(`Expected static helper: ${file}`);
        // Static PIE may have PT_DYNAMIC for relocation but no DT_NEEDED.
        if (kind === 2) {
          const begin = Number(bytes.readBigUInt64LE(p + 8)), length = Number(bytes.readBigUInt64LE(p + 32));
          if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(length) || begin + length > bytes.length) throw new Error('Invalid ELF dynamic section');
          for (let d = begin; d + 16 <= begin + length; d += 16) {
            const tag = bytes.readBigUInt64LE(d);
            if (tag === 0n) break;
            if (tag === 1n) throw new Error(`Expected static helper: ${file}`);
          }
        }
      }
    }
  }
}

// Cross-host installs must never quietly omit a foreign optional dependency.
export function auditDependencies(app, target) {
  const lock = JSON.parse(fs.readFileSync(path.join(app, 'package-lock.json')));
  const platform = target.split('-')[0];
  const allows = (values, value) => !values || (!values.includes(`!${value}`) &&
    (!values.some(x => !x.startsWith('!')) || values.includes(value) || values.includes('any')));
  for (const [relative, pkg] of Object.entries(lock.packages)) {
    if (!relative || pkg.dev) continue;
    if (!allows(pkg.os, platform) || !allows(pkg.cpu, 'x64') || !allows(pkg.libc, 'glibc')) continue;
    const file = path.join(app, relative, 'package.json');
    if (!fs.existsSync(file)) throw new Error(`Missing locked production dependency: ${relative}`);
    const actual = JSON.parse(fs.readFileSync(file));
    if (actual.version !== pkg.version) throw new Error(`Dependency version mismatch: ${relative}`);
  }
  const rg = path.join(app, `node_modules/@vscode/ripgrep-${target}/bin/rg${platform === 'win32' ? '.exe' : ''}`);
  checkTargetExecutable(rg, target, { staticLinux: platform === 'linux' });
  return rg;
}

export function auditPayload(directory, target) {
  const entries = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in payload: ${file}`);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile()) throw new Error(`Unexpected special file: ${file}`);
      if (file.endsWith('.node')) throw new Error(`Native Node addon requires explicit ABI review: ${file}`);
      const fd = fs.openSync(file, 'r'), header = Buffer.alloc(4);
      try { fs.readSync(fd, header, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (header.toString('hex') === '7f454c46' || header.toString('ascii', 0, 2) === 'MZ') {
        checkTargetExecutable(file, target);
      }
      entries.push({ file: path.relative(directory, file).split(path.sep).join('/'), sha256: sha256(file) });
    }
  };
  walk(directory);
  return entries;
}

// Windows chmod is not a Unix permission setter. Set tar headers explicitly,
// including their checksums, before gzip, so Linux can execute every entry point.
export function normalizeTarModes(bytes, executables) {
  const result = Buffer.from(bytes);
  for (let offset = 0; offset + 512 <= result.length;) {
    const h = result.subarray(offset, offset + 512);
    if (h.every(x => x === 0)) break;
    const str = (start, end) => h.subarray(start, end).toString().split('\0')[0];
    const size = parseInt(str(124, 136).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid tar size');
    const name = [str(345, 500), str(0, 100)].filter(Boolean).join('/').replace(/^\.\//, '');
    const type = h[156];
    if (type === 49 || type === 50) throw new Error('Links are not supported in bundle tar');
    if (type === 0 || type === 48 || type === 53) {
      const mode = type === 53 || executables.has(name) ? '0000755\0' : '0000644\0';
      h.write(mode, 100, 8, 'ascii');
      h.fill(32, 148, 156);
      const sum = h.reduce((a, b) => a + b, 0);
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}

export function gzipPortableTar(input, output, executables) {
  fs.writeFileSync(output, gzipSync(normalizeTarModes(fs.readFileSync(input), executables)));
}
