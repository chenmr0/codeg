#!/usr/bin/env node
// Run on the target OS. No Cargo, network, project database or business source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { checkExecutable, macroArtifactApi, macroSourceHash } from './rust-scan-release-lib.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url), api = macroArtifactApi(root);
const key = `${process.platform}-${process.arch}`, spec = api.RUST_MACRO_TARGETS[key];
if (!spec) throw new Error(`No macro release validator for ${key}`);
const binary = path.join(root, 'dist/native-macros', key, spec.executable);
const manifestPath = path.join(path.dirname(binary), 'manifest.json');
const manifest = api.checkRustMacroArtifact(binary, process.platform, process.arch,
  api.rustMacroPackageVersion(), false);
checkExecutable(fs.readFileSync(binary), process.platform);
if (manifest.sourceHash !== macroSourceHash(root)) throw new Error('Stale macro helper source hash');
if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
delete manifest.validation;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
process.env.CODEGRAPH_RUST_MACROS_PATH = binary;
const { buildMacroContext, scanMacroContribution } = require(path.join(root, 'dist/extraction/macro-scan'));
const { streamRustMacros } = require(path.join(root, 'dist/extraction/rust-macros'));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-macro-release-'));
const sources = [
  '#define EMPTY\n#define A 1\n#define F(x, rest...) x + rest\n#define TABLE \\\n /*中文😀*/ \\\n {1, 2, 0xff}\n',
  '#define A 1\r\n#define V(...) __VA_ARGS__\r\n#define N_NULL "null"\r\n',
  '/*\n#define GHOST 1\n*/\n#define N\n(x)\n#define M //note\n#define K /*note*/\n',
  '#pragma thing \\\n#define INSIDE 1\n#define OUTSIDE 2\n',
  Array.from({ length: 80 }, (_, i) => `#define SPEC_${i} \\\n /* CAP_${i} */ \\\n {${'0, '.repeat(200)}1},\n`).join(''),
  '#\ndefine FALLBACK_A 1\n',
  '#define FALLBACK_B /*start\n*/\n',
  '#define 宏(x) x\n#define ASCII_TOO 2\n',
  '\ufeff#define BOM 1\n',
];
const files = sources.map((source, index) => {
  const file = `f${index}.h`; fs.writeFileSync(path.join(fixture, file), source); return file;
});
files.push('missing.h');
try {
  let rows = 0, native = 0, deferred = 0;
  for await (const row of streamRustMacros(fixture, files)) {
    rows++;
    const index = files.indexOf(row.path);
    if (row.status === 'ok') {
      native++;
      assert.deepEqual(row.contribution, scanMacroContribution(sources[index]), row.path);
    } else deferred++;
  }
  assert.equal(rows, files.length); assert.ok(native >= 5); assert.ok(deferred >= 4);
  console.log(`[rust-macros] PASS ordered rows and per-file fallback: native=${native} fallback=${deferred}`);

  process.env.CODEGRAPH_RUST_MACROS = '0';
  const baseline = await buildMacroContext(fixture, files);
  process.env.CODEGRAPH_RUST_MACROS = '1';
  const accelerated = await buildMacroContext(fixture, files);
  assert.equal(accelerated.metrics.mode, 'rust'); assert.equal(accelerated.metrics.reason, 'none');
  assert.deepEqual([...accelerated.names], [...baseline.names]);
  assert.deepEqual([...accelerated.bodyless], [...baseline.bodyless]);
  assert.deepEqual(accelerated.definitions, baseline.definitions);
  console.log('[rust-macros] PASS complete context and conflict-selection parity');

  process.env.CODEGRAPH_RUST_MACROS = 'verify';
  const verified = await buildMacroContext(fixture, files);
  assert.equal(verified.metrics.mode, 'verify'); assert.equal(verified.metrics.reason, 'none');
  assert.deepEqual([...verified.names], [...baseline.names]);
  assert.deepEqual([...verified.bodyless], [...baseline.bodyless]);
  assert.deepEqual(verified.definitions, baseline.definitions);
  console.log('[rust-macros] PASS per-file verify oracle');
} finally {
  assert.equal(path.dirname(fs.realpathSync(fixture)), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(fixture).startsWith('cg-native-macro-release-'));
  fs.rmSync(fixture, { recursive: true, force: true });
}
assert.equal(api.macroSha256(fs.readFileSync(binary)), manifest.sha256, 'Binary changed during validation');
manifest.validation = { suite: api.RUST_MACRO_VALIDATION_SUITE, platform: process.platform,
  arch: process.arch, sha256: manifest.sha256, passed: true };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
api.checkRustMacroArtifact(binary);
console.log(`[rust-macros] ${key}: macro-parity-v1 target validation passed; automatic selection is now permitted.`);
