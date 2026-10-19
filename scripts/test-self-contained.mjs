import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanEnv, targetInstallArgs, assertChecksum, sha256, checkTargetExecutable,
  auditDependencies, normalizeTarModes } from './self-contained-lib.mjs';

test('target installs include optional packages and override host platform', () => {
  assert.ok(targetInstallArgs('linux-x64').includes('--os=linux'));
  assert.ok(targetInstallArgs('linux-x64').includes('--libc=glibc'));
  assert.ok(targetInstallArgs('win32-x64').includes('--os=win32'));
  assert.ok(targetInstallArgs('linux-x64').includes('--include=optional'));
  assert.ok(targetInstallArgs('linux-x64').includes('--ignore-scripts'));
  assert.throws(() => targetInstallArgs('linux-arm64'));
  assert.deepEqual(cleanEnv({ npm_config_arch: 'arm64', NPM_CONFIG_OS: 'win32', NODE_OPTIONS: '--bad',
    CODEGRAPH_PACK_ALLOW_INCOMPLETE: '1', npm_config_registry: 'https://registry.example', PATH: 'bin' }),
  { npm_config_registry: 'https://registry.example', PATH: 'bin' });
});

test('reject missing foreign optional dependency, wrong binary platform and corrupted download', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bundle-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ packages: {
      '': {}, 'node_modules/@vscode/ripgrep-linux-x64': { version: '1.18.0', optional: true, os: ['linux'], cpu: ['x64'] },
    } }));
    assert.throws(() => auditDependencies(dir, 'linux-x64'), /Missing locked production dependency/);
    const file = path.join(dir, 'binary');
    const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('PE\0\0', 64); pe.writeUInt16LE(0x8664, 68);
    fs.writeFileSync(file, pe);
    checkTargetExecutable(file, 'win32-x64');
    assert.throws(() => checkTargetExecutable(file, 'linux-x64'), /Expected x64 ELF/);
    const hash = sha256(file);
    assertChecksum(file, hash);
    fs.appendFileSync(file, 'tampered');
    assert.throws(() => assertChecksum(file, hash), /SHA256 mismatch/);
    const elf = Buffer.alloc(160); elf.write('7f454c46', 0, 'hex'); elf[4] = 2; elf[5] = 1;
    elf.writeUInt16LE(62, 18); elf.writeBigUInt64LE(64n, 32); elf.writeUInt16LE(56, 54); elf.writeUInt16LE(1, 56);
    elf.writeUInt32LE(2, 64); elf.writeBigUInt64LE(128n, 72); elf.writeBigUInt64LE(32n, 96);
    fs.writeFileSync(file, elf);
    checkTargetExecutable(file, 'linux-x64', { staticLinux: true });
    elf.writeBigUInt64LE(1n, 128); fs.writeFileSync(file, elf);
    assert.throws(() => checkTargetExecutable(file, 'linux-x64', { staticLinux: true }), /Expected static helper/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('Linux tar modes and header checksum are independent of Windows filesystem modes', () => {
  const tar = Buffer.alloc(512 * 4);
  const header = (offset, name, type) => {
    const h = tar.subarray(offset, offset + 512);
    h.write(name); h.write('0000666\0', 100); h.write('00000000000\0', 124); h[156] = type.charCodeAt(0);
  };
  header(0, 'bundle/node', '0'); header(512, 'bundle/config.json', '0'); header(1024, 'bundle/bin/', '5');
  const fixed = normalizeTarModes(tar, new Set(['bundle/node']));
  assert.equal(fixed.toString('ascii', 100, 107), '0000755');
  assert.equal(fixed.toString('ascii', 612, 619), '0000644');
  assert.equal(fixed.toString('ascii', 1124, 1131), '0000755');
  const h = Buffer.from(fixed.subarray(0, 512));
  const expected = parseInt(h.toString('ascii', 148, 154), 8); h.fill(32, 148, 156);
  assert.equal(h.reduce((a, b) => a + b, 0), expected);
  tar[156] = 50;
  assert.throws(() => normalizeTarModes(tar, new Set()), /Links are not supported/);
});
