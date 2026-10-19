// Read an installed candidate, exercise real native fallback through the CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const installed = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node --liftoff-only scripts/smoke-sync-fallback-diagnostic.mjs <installed-package>');
const require = createRequire(import.meta.url);
const CodeGraph = require(path.join(installed, 'dist/index.js')).default;
const { scanDirectory } = require(path.join(installed, 'dist/extraction/index.js'));
const { clearCanonicalCache } = require(path.join(installed, 'dist/utils.js'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-fallback-cli-'));
const cli = path.join(installed, 'dist/bin/codegraph.js');
const env = { ...process.env };
for (const key of ['CODEGRAPH_RUST_SCAN', 'CODEGRAPH_RUST_SCAN_PATH', 'CODEGRAPH_HYBRID_SCAN',
  'CODEGRAPH_SCAN_DIAGNOSTIC_PATHS']) delete env[key];
const run = (args, paths = false) => execFileSync(process.execPath,
  ['--liftoff-only', cli, 'sync', root, ...args], { encoding: 'utf8',
    env: { ...env, CODEGRAPH_SCAN_DIAGNOSTIC_PATHS: paths ? '1' : '0' }, timeout: 120000 });
try {
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, '.codegraphignore'), '/*\n!/src/\n');
  fs.writeFileSync(path.join(root, 'src/a.c'), 'int diagnostic_value;\nint function_a(void) { return diagnostic_value; }\n');
  let cg = CodeGraph.initSync(root); await cg.indexAll();
  const files = cg.getFiles(), stats = cg.getStats(); cg.close();
  fs.symlinkSync('src', path.join(root, 'private-excluded-link'));
  process.env.CODEGRAPH_RUST_SCAN = '0'; clearCanonicalCache();
  const baseline = scanDirectory(root);
  process.env.CODEGRAPH_RUST_SCAN = 'auto'; clearCanonicalCache();
  assert.deepEqual(scanDirectory(root), baseline);
  const skipped = run([]);
  assert.doesNotMatch(skipped, /原生扫描已回退|private-excluded-link/);
  assert.match(run(['-v']), /nativeStatus=used/);
  assert.equal(run(['-q']).trim(), '');
  // Keep an included link to exercise the unchanged diagnostic fallback.
  fs.unlinkSync(path.join(root, 'private-excluded-link'));
  fs.symlinkSync('a.c', path.join(root, 'src/private-fallback-link'));
  const normal = run([]);
  assert.equal(normal.split('原生扫描已回退').length - 1, 1);
  assert.match(normal, /按文件排除=no，按目录排除=no，目标类型=file/);
  assert.doesNotMatch(normal, /private-fallback-link/);
  const verbose = run(['-v']);
  assert.match(verbose, /nativeDiagnosticReason=symlink/);
  assert.match(verbose, /nativeExcludedAsFile=no/);
  assert.doesNotMatch(verbose, /private-fallback-link/);
  assert.equal(run(['-q']).trim(), '');
  const paths = run([], true);
  assert.match(paths, /path="src\/private-fallback-link"/);
  cg = await CodeGraph.open(root);
  assert.deepEqual(cg.getFiles(), files);
  // Existing sync updates lastUpdated bookkeeping; compare graph contents.
  const { lastUpdated: beforeUpdated, dbSizeBytes: beforeBytes, ...beforeGraph } = stats;
  const { lastUpdated: afterUpdated, dbSizeBytes: afterBytes, ...afterGraph } = cg.getStats();
  assert.deepEqual(afterGraph, beforeGraph);
  cg.close();
  console.log('PASS installed CLI: non-v/v/quiet/opt-in paths; excluded-link native scan and real fallback; source set, file records and graph stats unchanged.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
