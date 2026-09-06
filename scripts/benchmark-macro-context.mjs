#!/usr/bin/env node
// Read-only source benchmark. Does not open a CodeGraph database or modify a repo.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { buildMacroContext } = require('../dist/extraction/macro-scan.js');
const { scanDirectoryAsync } = require('../dist/extraction/index.js');
const { EXTENSION_MAP } = require('../dist/extraction/grammars.js');
const { ScanDiagnostics } = require('../dist/extraction/sync-diagnostics.js');
const { AUTO_RUST_MACRO_FILES } = require('../dist/extraction/rust-macros.js');
const args = process.argv.slice(2);
// Fresh heap/JIT per sample, like separate CLI invocations. Startup and file
// enumeration are outside the macro-context timer.
if (args[0] === '--worker') {
  const { root, files } = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.env.CODEGRAPH_RUST_MACROS = args[1];
  const result = await buildMacroContext(root, files);
  const hash = createHash('sha256').update(JSON.stringify({ names: [...result.names], bodyless: [...result.bodyless], definitions: result.definitions })).digest('hex');
  console.log(JSON.stringify({ ...result.metrics, names: result.names.size, bodyless: result.bodyless.size,
    definitions: result.definitions.length, hash }));
  process.exit(0);
}
if (!args[0] || args.length > 2) throw new Error('Usage: node scripts/benchmark-macro-context.mjs <project> [rounds=3]');
const root = path.resolve(args[0]), rounds = Number(args[1] ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('rounds must be 1..5');
let rootStat;
try { rootStat = fs.statSync(root); }
catch (error) { throw new Error(`Project directory is unavailable (${error.code ?? 'stat-error'}): ${root}`); }
if (!rootStat.isDirectory()) throw new Error(`Project path is not a directory: ${root}`);
const scan = new ScanDiagnostics();
const sourceFiles = await scanDirectoryAsync(root, undefined, scan);
const files = sourceFiles.filter(file => ['c', 'cpp', 'objc'].includes(EXTENSION_MAP[path.extname(file).toLowerCase()]));
if (!files.length) {
  throw new Error(`No C/C++/ObjC candidates: sourceFiles=${sourceFiles.length} scanMode=${scan.mode} ` +
    `fallbackReason=${scan.fallbackReason}. Check the project path and ignore rules: ${root}`);
}
let expected;
const input = JSON.stringify({ root, files });
const sample = mode => JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', mode],
  { input, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 }));
for (let round = 1; round <= rounds; round++) {
  for (const mode of (round % 2 ? ['0', '1'] : ['1', '0'])) {
    const result = sample(mode);
    expected ??= result.hash;
    if (result.hash !== expected || (mode === '1' && result.mode !== 'rust')) throw new Error(`Benchmark rejected: ${result.reason}; parity=${result.hash === expected}`);
    console.log(JSON.stringify({ round, ...result }));
  }
}
const verified = sample('verify');
if (verified.mode !== 'verify' || verified.hash !== expected) throw new Error(`Per-file verification failed: ${verified.reason}`);
console.log(JSON.stringify({ verification: true, ...verified }));
const automatic = sample('auto');
if (automatic.hash !== expected || (files.length >= AUTO_RUST_MACRO_FILES && automatic.mode !== 'rust')) {
  throw new Error(`Automatic selection failed: ${automatic.reason}; parity=${automatic.hash === expected}`);
}
console.log(JSON.stringify({ automatic: true, ...automatic }));
