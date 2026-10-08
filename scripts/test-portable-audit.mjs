#!/usr/bin/env node
// Read-only packaging audit tests. No fixture or downloaded executable is run.
// Optional: CODEGRAPH_TEST_PORTABLE_RUNTIME=/absolute/path/to/node node --test scripts/test-portable-audit.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { auditPortableElf } from './audit-portable-elf.mjs';

const readelfProbe = spawnSync('readelf', ['--version'], { encoding: 'utf8' });
const hasReadelf = !readelfProbe.error && readelfProbe.status === 0;
const needsReadelf = hasReadelf ? false : 'readelf is not available';
const trueBinary = '/bin/true';
const hasSystemElf = hasReadelf && process.platform === 'linux' && process.arch === 'x64' && fs.existsSync(trueBinary);
const needsSystemElf = hasSystemElf ? false : 'requires readelf and Linux x64 /bin/true';

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph ELF audit '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function minimalElf(machine = 62) {
  // A static ELF64 header with no code, program headers, or section table.
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  header.writeUInt16LE(2, 16); // ET_EXEC
  header.writeUInt16LE(machine, 18); // EM_X86_64
  header.writeUInt32LE(1, 20); // EV_CURRENT
  header.writeUInt16LE(64, 52);
  header.writeUInt16LE(56, 54);
  header.writeUInt16LE(64, 58);
  return header;
}

function copyNonExecutable(source, destination) {
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o644);
}

test('ignores ordinary files without executing shell scripts', (t) => {
  const root = temporaryRoot(t);
  const marker = path.join(root, 'must-not-be-created');
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'empty'), '');
  fs.writeFileSync(path.join(root, 'nested', 'data.json'), '{"safe":true}\n');
  fs.writeFileSync(path.join(root, 'node'), `#!/bin/sh\ntouch '${marker}'\nexit 99\n`, { mode: 0o755 });
  assert.deepEqual(auditPortableElf(root), []);
  assert.equal(fs.existsSync(marker), false, 'audit executed a payload file');
});

test('rejects symbolic links, including dangling links', {
  skip: process.platform === 'win32' ? 'requires POSIX symlinks' : false,
}, (t) => {
  const root = temporaryRoot(t);
  fs.symlinkSync('missing-target', path.join(root, 'linked-file'));
  assert.throws(() => auditPortableElf(root), /Symlink in portable payload/);
});

test('rejects native addons even when they are not valid ELF files', (t) => {
  const root = temporaryRoot(t);
  fs.mkdirSync(path.join(root, 'dependencies'));
  fs.writeFileSync(path.join(root, 'dependencies', 'binding.node'), 'unreviewed native addon');
  assert.throws(() => auditPortableElf(root), /Native addon requires explicit ABI review/);
});

test('rejects special files without trying to read a FIFO', {
  skip: process.platform === 'win32' ? 'requires POSIX mkfifo' : false,
}, (t) => {
  const root = temporaryRoot(t);
  const result = spawnSync('mkfifo', [path.join(root, 'pipe')], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') return t.skip('mkfifo is not available');
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => auditPortableElf(root), /Special file in portable payload/);
});

test('audits a static x86-64 ELF and returns a stable checksum', { skip: needsReadelf }, (t) => {
  const root = temporaryRoot(t);
  fs.mkdirSync(path.join(root, 'helpers'));
  const bytes = minimalElf();
  const filename = path.join(root, 'helpers', 'static-helper');
  fs.writeFileSync(filename, bytes, { mode: 0o644 });
  assert.deepEqual(auditPortableElf(root), [{
    file: 'helpers/static-helper',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    libraries: [],
    interpreter: null,
    glibc: [],
  }]);
  assert.deepEqual(fs.readFileSync(filename), bytes, 'read-only audit modified its input');
});

test('rejects ELF files for a different machine', { skip: needsReadelf }, (t) => {
  const root = temporaryRoot(t);
  fs.writeFileSync(path.join(root, 'node'), minimalElf(183)); // EM_AARCH64
  assert.throws(() => auditPortableElf(root), /Wrong ELF architecture/);
});

test('rejects truncated ELF rather than treating it as ordinary data', { skip: needsReadelf }, (t) => {
  const root = temporaryRoot(t);
  fs.writeFileSync(path.join(root, 'node'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  assert.throws(() => auditPortableElf(root), /readelf failed/);
});

test('recognizes the real readelf machine header without executing the binary', { skip: needsSystemElf }, (t) => {
  const root = temporaryRoot(t);
  copyNonExecutable(trueBinary, path.join(root, 'node'));
  const result = auditPortableElf(root, '999.0');
  assert.equal(result.length, 1);
  assert.equal(result[0].file, 'node');
  assert.ok(result[0].libraries.includes('libc.so.6'));
  assert.equal(result[0].interpreter, '/lib64/ld-linux-x86-64.so.2');
  assert.equal(fs.statSync(path.join(root, 'node')).mode & 0o111, 0, 'fixture must remain non-executable');
});

test('rejects a real host ELF when its glibc requirement exceeds 2.17', { skip: needsSystemElf }, (t) => {
  const root = temporaryRoot(t);
  copyNonExecutable(trueBinary, path.join(root, 'node'));
  const [{ glibc }] = auditPortableElf(root, '999.0');
  const tooNew = glibc.some((value) => {
    const [major, minor, patch = 0] = value.split('.').map(Number);
    return major > 2 || (major === 2 && (minor > 17 || (minor === 17 && patch > 0)));
  });
  if (!tooNew) return t.skip('host /bin/true already meets the glibc 2.17 baseline');
  assert.throws(() => auditPortableElf(root), /GLIBC_[0-9.]+ exceeds 2\.17/);
});

test('rejects a dynamically linked helper even at an allowed glibc level', { skip: needsSystemElf }, (t) => {
  const root = temporaryRoot(t);
  fs.mkdirSync(path.join(root, 'helpers'));
  copyNonExecutable(trueBinary, path.join(root, 'helpers', 'dynamic-helper'));
  assert.throws(() => auditPortableElf(root, '999.0'), /Helper must be static: helpers\/dynamic-helper/);
});

const optionalRuntime = process.env.CODEGRAPH_TEST_PORTABLE_RUNTIME;
test('optional pinned runtime passes the glibc 2.17 read-only audit', {
  skip: !optionalRuntime ? 'set CODEGRAPH_TEST_PORTABLE_RUNTIME to inspect a local runtime' : needsReadelf,
}, (t) => {
  assert.ok(path.isAbsolute(optionalRuntime), 'CODEGRAPH_TEST_PORTABLE_RUNTIME must be an absolute binary path');
  const root = temporaryRoot(t);
  const node = path.join(root, 'node');
  copyNonExecutable(optionalRuntime, node);
  const before = fs.readFileSync(node);
  const result = auditPortableElf(root);
  assert.equal(result.length, 1);
  assert.equal(result[0].file, 'node');
  assert.equal(result[0].sha256, createHash('sha256').update(before).digest('hex'));
  assert.deepEqual(fs.readFileSync(node), before, 'audit must not modify the runtime');
  assert.equal(fs.statSync(node).mode & 0o111, 0, 'runtime must remain non-executable');
});
