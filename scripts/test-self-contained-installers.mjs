import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const windows = process.platform === 'win32';
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ps = (args, env = {}) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
  // Let Windows PowerShell construct its own module paths when tests run in pwsh 7.
  encoding: 'utf8', windowsHide: true, env: { ...Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.toLowerCase() !== 'psmodulepath')), ...env }, maxBuffer: 8 * 1024 * 1024,
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg installer tests '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, install: path.join(root, 'install with spaces') };
}
function install(f, archive, sha = digest(archive)) {
  return ps(['-File', path.join(scripts, 'install-self-contained.ps1'), '-Archive', archive,
    '-Sha256', sha, '-InstallDir', f.install, '-NoPath']);
}
test('Windows rejects bad digest without creating installation', { skip: !windows }, t => {
  const f = fixture(t), file = path.join(f.root, 'invalid.zip');
  fs.writeFileSync(file, 'invalid');
  const r = install(f, file, '0'.repeat(64));
  assert.notEqual(r.status, 0); assert.match(r.stderr, /checksum mismatch/);
  assert.equal(fs.existsSync(f.install), false);
});
test('Windows rejects traversal even when the ZIP checksum matches', { skip: !windows }, t => {
  const f = fixture(t), file = path.join(f.root, 'unsafe.zip');
  const code = "Add-Type -AssemblyName System.IO.Compression.FileSystem; Add-Type -AssemblyName System.IO.Compression; $z=[IO.Compression.ZipFile]::Open($env:FIXTURE_ZIP,[IO.Compression.ZipArchiveMode]::Create); $e=$z.CreateEntry('codegraph-1.1.2-win32-x64/../escape'); $z.Dispose()";
  const made = ps(['-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { FIXTURE_ZIP: file });
  assert.equal(made.status, 0, made.stderr);
  const r = install(f, file);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Unsafe archive path/);
  assert.equal(fs.existsSync(f.install), false);
});
test('Windows installs, repeats safely and preserves active version on failed update', {
  skip: !windows || !process.env.CODEGRAPH_TEST_BUNDLE,
}, t => {
  const f = fixture(t), archive = path.resolve(process.env.CODEGRAPH_TEST_BUNDLE);
  for (let i = 0; i < 2; i++) {
    // Exercise both a local script and the same evaluation path as irm | iex.
    const evalCode = 'Invoke-Expression ([IO.File]::ReadAllText($env:FIXTURE_INSTALLER))';
    const r = i === 0 ? install(f, archive) : ps(['-EncodedCommand', Buffer.from(evalCode, 'utf16le').toString('base64')], {
      FIXTURE_INSTALLER: path.join(scripts, 'install-self-contained.ps1'),
      CODEGRAPH_ARCHIVE: archive, CODEGRAPH_SHA256: digest(archive), CODEGRAPH_VERSION: '1.1.2',
      CODEGRAPH_INSTALL_DIR: f.install, CODEGRAPH_UPDATE_PATH: '0',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  const pointer = fs.readFileSync(path.join(f.install, 'current.txt'), 'utf8');
  assert.equal(pointer.trim(), digest(archive));
  const command = "& (Join-Path $env:FIXTURE_INSTALL 'bin/codegraph.cmd') --version; exit $LASTEXITCODE";
  const r = ps(['-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { FIXTURE_INSTALL: f.install });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /1\.1\.2/);
  const failed = install(f, archive, '0'.repeat(64));
  assert.notEqual(failed.status, 0);
  assert.equal(fs.readFileSync(path.join(f.install, 'current.txt'), 'utf8'), pointer);
});
test('Linux rejects wrong checksum without activating an installation', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t), file = path.join(f.root, 'invalid.tar.gz');
  fs.writeFileSync(file, 'invalid');
  const r = spawnSync('sh', [path.join(scripts, 'install-self-contained.sh'), '--archive', file, '--sha256', '0'.repeat(64), '--no-path'], {
    encoding: 'utf8', env: { ...process.env, CODEGRAPH_INSTALL_DIR: f.install, CODEGRAPH_BIN_DIR: path.join(f.root, 'bin') },
  });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /checksum mismatch/);
  assert.equal(fs.existsSync(f.install), false);
});
