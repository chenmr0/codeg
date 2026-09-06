import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkExecutable, macroSourceHash, nativeSourceHash } from '../scripts/rust-scan-release-lib.mjs';

const elf = () => {
  const b = Buffer.alloc(256);
  b.write('7f454c46', 0, 'hex'); b[4] = 2; b[5] = 1; b.writeUInt16LE(62, 18);
  b.writeBigUInt64LE(64n, 32); b.writeUInt16LE(56, 54); b.writeUInt16LE(1, 56);
  b.writeUInt32LE(1, 64); return b;
};
describe('release executable checks', () => {
  it('accepts an x64 ELF without dynamic dependencies', () => expect(() => checkExecutable(elf(), 'linux')).not.toThrow());
  it('rejects a dynamic interpreter', () => {
    const b = elf(); b.writeUInt32LE(3, 64);
    expect(() => checkExecutable(b, 'linux')).toThrow('dynamic interpreter');
  });
  it('rejects a needed shared library', () => {
    const b = elf(); b.writeUInt32LE(2, 64); b.writeBigUInt64LE(128n, 72); b.writeBigUInt64LE(16n, 96); b.writeBigUInt64LE(1n, 128);
    expect(() => checkExecutable(b, 'linux')).toThrow('shared libraries');
  });
  it('rejects the wrong architecture and truncated headers', () => {
    const b = elf(); b.writeUInt16LE(183, 18);
    expect(() => checkExecutable(b, 'linux')).toThrow('x64');
    expect(() => checkExecutable(elf().subarray(0, 70), 'linux')).toThrow('program headers');
  });
  it('rejects relabeling a Linux binary as a Windows program', () => expect(() => checkExecutable(elf(), 'win32')).toThrow('PE'));
  it('checks the Windows machine type', () => {
    const b = Buffer.alloc(128); b.write('MZ'); b.writeUInt32LE(64, 60); b.write('PE\0\0', 64); b.writeUInt16LE(0x8664, 68);
    expect(() => checkExecutable(b, 'win32')).not.toThrow();
    b.writeUInt16LE(0xaa64, 68); expect(() => checkExecutable(b, 'win32')).toThrow('x64');
  });
});
describe('cross-platform source fingerprint', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-source-'));
    fs.mkdirSync(path.join(dir, 'codegraph-scan/src'), { recursive: true });
    for (const file of ['Cargo.toml', 'Cargo.lock', 'src/main.rs']) fs.writeFileSync(path.join(dir, 'codegraph-scan', file), 'a\nb\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  it('ignores Git CRLF conversion but detects actual source/lock changes', () => {
    const hash = nativeSourceHash(dir);
    fs.writeFileSync(path.join(dir, 'codegraph-scan/src/main.rs'), 'a\r\nb\r\n'); expect(nativeSourceHash(dir)).toBe(hash);
    fs.appendFileSync(path.join(dir, 'codegraph-scan/Cargo.lock'), 'changed'); expect(nativeSourceHash(dir)).not.toBe(hash);
  });
});
describe('macro source fingerprint', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-macro-source-'));
    fs.mkdirSync(path.join(dir, 'codegraph-macros/src'), { recursive: true });
    for (const file of ['Cargo.toml', 'Cargo.lock', 'src/main.rs']) {
      fs.writeFileSync(path.join(dir, 'codegraph-macros', file), 'a\nb\n');
    }
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  it('normalizes CRLF and detects macro source changes', () => {
    const hash = macroSourceHash(dir);
    fs.writeFileSync(path.join(dir, 'codegraph-macros/src/main.rs'), 'a\r\nb\r\n');
    expect(macroSourceHash(dir)).toBe(hash);
    fs.appendFileSync(path.join(dir, 'codegraph-macros/Cargo.toml'), 'changed');
    expect(macroSourceHash(dir)).not.toBe(hash);
  });
});
