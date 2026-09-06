#!/usr/bin/env node
// Read-only scan: no CodeGraph database, source parsing, source edits or index.
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
  process.env.CODEGRAPH_GIT_REALPATH = args[1];
  process.env.CODEGRAPH_RUST_GIT_IGNORE = '0';
  // This experiment must not accidentally measure the existing Rust walker.
  // Ignore configuration is never changed to force a Git route.
  process.env.CODEGRAPH_RUST_SCAN = '0';
  clearCanonicalCache();
  const detail = new ScanDiagnostics();
  const started = performance.now();
  const files = scanDirectory(path.resolve(args[2]), undefined, detail);
  const totalMs = performance.now() - started;
  if (detail.mode !== 'git') throw new Error(`Git route required, got ${detail.mode}/${detail.fallbackReason}; leave ignore rules unchanged`);
  console.log(JSON.stringify({ requestedMode: args[1], totalMs, ...detail,
    hash: createHash('sha256').update(JSON.stringify(files)).digest('hex') }));
} else {
  if (!args[0] || args.length > 2) throw new Error('Usage: node scripts/benchmark-git-paths.mjs <project> [rounds=3]');
  const root = path.resolve(args[0]), rounds = Number(args[1] ?? 3);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('rounds must be 1..5');
  const sample = mode => JSON.parse(execFileSync(process.execPath,
    [fileURLToPath(import.meta.url), '--worker', mode, root],
    { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }));
  // Verify first, not after asking the user to trust a faster but different scan.
  const verified = sample('verify');
  console.log(JSON.stringify({ verification: true, ...verified }));
  if (verified.gitPathMismatches) throw new Error('Native path mismatch; retain legacy mode');
  const results = { legacy: [], native: [] };
  for (let round = 1; round <= rounds; round++) {
    for (const mode of (round % 2 ? ['legacy', 'native'] : ['native', 'legacy'])) {
      const result = sample(mode);
      if (result.hash !== verified.hash) throw new Error('Path/order mismatch or changing worktree; retain legacy mode');
      results[mode].push(result);
      console.log(JSON.stringify({ round, ...result }));
    }
  }
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const medians = Object.fromEntries(Object.entries(results).map(([mode, rows]) => [mode,
    Object.fromEntries(['totalMs', 'filterCanonicalMs', 'gitIgnoreMs', 'gitCanonicalMs', 'gitRealpathMs']
      .map(key => [key, median(rows.map(row => row[key]))]))]));
  console.log(JSON.stringify({ summary: true, parity: true, rounds, sourceFiles: verified.sourceFiles,
    hash: verified.hash, medians }));
}
