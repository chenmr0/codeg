#!/usr/bin/env node
// Read-only Git candidate filtering benchmark. No DB, parsing or source writes.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { scanDirectory } = require('../dist/extraction/index.js');
const { ScanDiagnostics } = require('../dist/extraction/sync-diagnostics.js');
const { clearCanonicalCache } = require('../dist/utils.js');
const args = process.argv.slice(2);

if (args[0] === '--worker') {
  const requestedIgnoreMode = args[1];
  process.env.CODEGRAPH_RUST_GIT_IGNORE = requestedIgnoreMode;
  process.env.CODEGRAPH_GIT_REALPATH = 'native';
  process.env.CODEGRAPH_RUST_SCAN = '0';
  clearCanonicalCache();
  const detail = new ScanDiagnostics(), started = performance.now();
  const files = scanDirectory(path.resolve(args[2]), undefined, detail);
  const totalMs = performance.now() - started;
  if (detail.mode !== 'git') throw new Error(`Git route required, got ${detail.mode}/${detail.fallbackReason}`);
  console.log(JSON.stringify({ requestedIgnoreMode, totalMs, ...detail,
    hash: createHash('sha256').update(JSON.stringify(files)).digest('hex') }));
  process.exit(0);
}
if (!args[0] || args.length > 2) throw new Error('Usage: node scripts/benchmark-git-ignore.mjs <project> [rounds=3]');
const root = path.resolve(args[0]), rounds = Number(args[1] ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('rounds must be 1..5');
const sample = mode => JSON.parse(execFileSync(process.execPath,
  [fileURLToPath(import.meta.url), '--worker', mode, root], { encoding: 'utf8', windowsHide: true,
    timeout: 180_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }));
const verified = sample('verify');
console.log(JSON.stringify({ verification: true, ...verified }));
if (verified.gitIgnoreMode !== 'verify' || verified.gitIgnoreMismatches !== 0) {
  throw new Error(`Rust ignore verification failed: ${verified.gitIgnoreReason}/${verified.gitIgnoreMismatches}`);
}
const results = { legacy: [], rust: [] };
for (let round = 1; round <= rounds; round++) {
  for (const mode of (round % 2 ? ['legacy', 'rust'] : ['rust', 'legacy'])) {
    const result = sample(mode);
    if (result.hash !== verified.hash || (mode === 'rust' && result.gitIgnoreMode !== 'rust')) {
      throw new Error(`Filter fallback or path/order mismatch: ${result.gitIgnoreReason}`);
    }
    results[mode].push(result); console.log(JSON.stringify({ round, ...result }));
  }
}
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const keys = ['totalMs', 'gitCommandMs', 'filterCanonicalMs', 'gitIgnoreMs', 'gitIgnoreNativeMs',
  'gitIgnoreKernelMs', 'gitCanonicalMs', 'gitRealpathMs'];
const medians = Object.fromEntries(Object.entries(results).map(([mode, rows]) => [mode,
  Object.fromEntries(keys.map(key => [key, median(rows.map(row => row[key]))]))]));
console.log(JSON.stringify({ summary: true, parity: true, rounds, sourceFiles: verified.sourceFiles,
  hash: verified.hash, medians }));
