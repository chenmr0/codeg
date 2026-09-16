#!/usr/bin/env node
// Run on the TARGET OS. No Cargo, compiler, registry access or project database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { artifactApi, checkExecutable } from './rust-scan-release-lib.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = artifactApi(root), require = createRequire(import.meta.url);
const key = `${process.platform}-${process.arch}`, spec = api.RUST_SCAN_TARGETS[key];
if (!spec) throw new Error(`No release validator for ${key}`);
const binary = path.join(root, 'dist/native-scan', key, spec.executable);
const manifestPath = path.join(path.dirname(binary), 'manifest.json');
const manifest = api.checkRustScanArtifact(binary, process.platform, process.arch, api.rustScanPackageVersion(), false);
checkExecutable(fs.readFileSync(binary), process.platform);
if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
// A failed revalidation must not leave a stale success stamp behind.
delete manifest.validation;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
process.env.CODEGRAPH_RUST_SCAN_PATH = binary;
process.env.CODEGRAPH_HYBRID_SCAN = '0';
delete process.env.CODEGRAPH_DIR;
const { scanDirectory } = require(path.join(root, 'dist/extraction'));
const { ScanDiagnostics } = require(path.join(root, 'dist/extraction/sync-diagnostics'));
const { clearCanonicalCache } = require(path.join(root, 'dist/utils'));
const { verifyRustSnapshot } = require(path.join(root, 'dist/extraction/rust-scan'));
const ignoreModule = require('ignore');
const ignore = ignoreModule.default ?? ignoreModule;
let count = 0;
function fixture(name, files, expected = 'used', setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-release-'));
  const write = (file, content) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), content); };
  try {
    write('.codegraphignore', '!/extra/\n');
    for (const [file, content] of Object.entries(files)) write(file, content);
    setup?.(dir);
    process.env.CODEGRAPH_RUST_SCAN = '0'; clearCanonicalCache();
    const baseline = scanDirectory(dir);
    process.env.CODEGRAPH_RUST_SCAN = '1'; clearCanonicalCache();
    const diag = new ScanDiagnostics(), capture = {};
    assert.deepEqual(scanDirectory(dir, undefined, diag, capture), baseline, name + ' paths/order');
    assert.equal(diag.nativeStatus, expected, name + ': ' + diag.nativeReason);
    if (expected === 'used') assert.equal(verifyRustSnapshot(dir, capture.snapshot, baseline), true, name + ' metadata');
    else assert.equal(capture.snapshot, undefined, name + ' partial snapshot');
    count++; console.log(`[rust-scan] PASS ${name}`);
  } finally {
    clearCanonicalCache();
    assert.equal(path.dirname(fs.realpathSync(dir)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('cg-native-release-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
fixture('order and source selection', { 'src/z.c': 'int z;', 'src/A.h': '#define N 1', 'src/a space.cpp': 'int a;',
  '.hidden.c': 'int h;', 'app/conf/routes': 'GET / C.a', 'a/foo.routes': '', 'templates/a.json': '{}',
  'a/sections/group.json': '{}', 'app/config.json': '{}', 'templates/.json': '{}' });
fixture('anchored whitelist and nested ignore', { '.codegraphignore': '/*\n!/a/b/\n!/a/c/\n',
  'a/b/yes.c': 'int x;', 'a/b/no.c': '', 'a/b/.gitignore': 'no.c\n', 'a/c/yes.c': '', 'other/no.c': '' });
fixture('root info exclude', { '.git/info/exclude': 'hidden/\n', 'hidden/no.c': '', 'visible/yes.c': '' });
fixture('blocked parent', { 'src/.gitignore': 'blocked/\n!blocked/yes.c\n', 'src/blocked/yes.c': '', 'src/ok.c': '' });
fixture('double star negation', { '.gitignore': 'tests/**/test_*\n!tests/**/test_*.*\n', 'tests/test_a.c': '', 'tests/deep/test_b.c': '' });
fixture('wx data directories and community sources', { '.codegraph-wx/a.c': '', '.codegraph-wx-other/a.c': '',
  '.codegraph/a.c': '', '.codegraph-other/a.c': '', 'src/a.c': '' });
fixture('Unicode documentation', { '报告.md': '', 'docs/说明.txt': '', 'src/a.c': '' });
for (const name of ['src/中文.c', '中文/a.c', 'src/中文.Kt', 'templates/中文.json', 'src/中文.routes']) {
  fixture('Unicode source fallback: ' + name, { [name]: '', 'src/a.c': '' }, 'fallback');
}
fixture('complex rule fallback', { '.gitignore': '[ab].c\n', 'src/a.c': '' }, 'fallback');
fixture('link fallback', { 'real/a.c': '' }, 'fallback', dir => {
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
});
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-filter-release-'));
  try {
    const rootRules = ['build/\n*.tmp\n!/keep.tmp\n/ROOT/*\n!/ROOT/keep.c\nlocked/\n!locked/child.c\n'];
    const candidates = ['src/a.c', 'build/no.c', 'deep/value.tmp', 'keep.tmp',
      'ROOT/no.c', 'ROOT/keep.c', 'root/KEEP.C', '.hidden.c', 'dir/a space.c', 'locked/child.c', '中文.c'];
    const matcher = ignore({ ignorecase: true });
    for (const group of rootRules) matcher.add(group);
    const expected = candidates.map((candidate, index) => matcher.ignores(candidate) ? -1 : index).filter(index => index >= 0);
    const response = spawnSync(binary, [], { encoding: 'utf8', windowsHide: true,
      input: JSON.stringify({ protocol: api.RUST_SCAN_PROTOCOL, operation: 'filter', root: dir,
        rootRules, candidates }), maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
    assert.equal(response.status, 0, response.stderr || response.error?.message);
    const value = JSON.parse(response.stdout);
    assert.equal(value.ok, true, value.reason); assert.equal(value.operation, 'filter');
    assert.deepEqual(value.files, []); assert.deepEqual(value.included, expected.slice(0, -1));
    assert.deepEqual(value.deferred, [candidates.length - 1]);
    count++; console.log('[rust-scan] PASS Git candidate root-rule filter');
  } finally {
    assert.equal(path.dirname(fs.realpathSync(dir)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('cg-native-filter-release-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
assert.equal(api.sha256(fs.readFileSync(binary)), manifest.sha256, 'Binary changed during validation');
manifest.validation = { suite: api.RUST_SCAN_VALIDATION_SUITE, platform: process.platform,
  arch: process.arch, sha256: manifest.sha256, passed: true };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
api.checkRustScanArtifact(binary);
console.log(`[rust-scan] ${key}: ${count} real differential fixtures passed; automatic selection is now permitted.`);
