#!/usr/bin/env node
// Read-only DB benchmark for cache preparation + three membership checks.
// No schema initialization, sync, source reads or database maintenance.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { createDatabase } = require('../dist/db/sqlite-adapter.js');
const { QueryBuilder } = require('../dist/db/queries.js');
const { ReferenceResolver } = require('../dist/resolution/index.js');
const { ResolutionDiagnostics } = require('../dist/resolution/diagnostics.js');
const args = process.argv.slice(2);

if (args[0] === '--worker') {
  const { database, names } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const { db } = createDatabase(database, { readOnly: true });
  try {
    const queries = new QueryBuilder(db);
    const resolver = new ReferenceResolver(path.dirname(database), queries);
    const mode = args[1];
    const detail = new ResolutionDiagnostics();
    const started = performance.now();
    resolver.warmCaches(detail, mode);
    const check = () => names.map(name => resolver.hasKnownName(name));
    // Internal benchmark seam: exercise the same lookup and accounting used
    // by resolveAll without inventing references or touching graph contents.
    const answers = resolver.indexedNames ? resolver.indexedNames.capture(detail, check) : check();
    const totalMs = performance.now() - started;
    console.log(JSON.stringify({ mode, probes: names.length, totalMs, knownFiles: detail.knownFiles,
      knownNames: detail.knownNames, nameQueries: detail.nameQueries, nameCacheHits: detail.nameCacheHits,
      timings: detail.timings, hash: createHash('sha256').update(JSON.stringify(answers)).digest('hex') }));
  } finally { db.close(); }
  process.exit(0);
}
if (!args[0] || args.length > 2) throw new Error('Usage: node scripts/benchmark-reference-name-lookup.mjs <codegraph.db> [rounds=3]');
const database = path.resolve(args[0]), rounds = Number(args[1] ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('rounds must be 1..5');
const { db } = createDatabase(database, { readOnly: true });
let names;
try {
  names = db.prepare('SELECT DISTINCT name FROM nodes ORDER BY name LIMIT 2').all().map(row => row.name);
  names.push('__codegraph_name_lookup_benchmark_missing_558bdf__');
} finally { db.close(); }
let expected;
for (let round = 1; round <= rounds; round++) {
  for (const mode of (round % 2 ? ['full', 'indexed'] : ['indexed', 'full'])) {
    const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', mode],
      { input: JSON.stringify({ database, names }), encoding: 'utf8', timeout: 120000,
        maxBuffer: 1024 * 1024, windowsHide: true }));
    expected ??= result.hash;
    if (result.hash !== expected) throw new Error('Membership parity mismatch; keep database unchanged while benchmarking');
    console.log(JSON.stringify({ round, ...result }));
  }
}
