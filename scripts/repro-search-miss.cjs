#!/usr/bin/env node
/**
 * Compare the real CLI and stdio MCP search against the same existing index.
 * Usage: node scripts/repro-search-miss.cjs --project <root> --database <db> [--rounds 3] [--out <dir>] [--query <symbol>]
 * Add --batch --queries-file <JSON array> to time real MCP batch calls only.
 * Requires the current dist build and Node's native SQLite backend.
 * The DB is opened read-only. Startup sync/watching/daemon are disabled so
 * query latency can be separated from index maintenance. No search is mocked.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const repo = path.resolve(__dirname, '..');
const cli = path.join(repo, 'dist/bin/codegraph.js');
const marker = '[search-bench] ';

function instrument(target, method, label = method) {
  const original = target[method];
  if (typeof original !== 'function') throw new Error(`Missing method: ${label}`);
  target[method] = function (...args) {
    const start = performance.now();
    const finish = (result) => {
      const event = { phase: label, ms: performance.now() - start };
      if (typeof args[0] === 'string') event.query = args[0];
      if (Array.isArray(result)) event.count = result.length;
      if (label === 'rawSource') {
        event.report = { backend: result.backend, cacheHit: result.cacheHit,
          totalScannedFiles: result.totalScannedFiles, totalScannedBytes: result.totalScannedBytes,
          timeBudgetReached: result.timeBudgetReached, budgetReached: result.budgetReached,
          matches: result.states.map(s => s.matchingLines) };
      }
      process.stderr.write(marker + JSON.stringify(event) + '\n');
      return result;
    };
    const result = original.apply(this, args);
    return result?.then ? result.then(finish) : finish(result);
  };
}

function installBenchmarkHooks(config) {
  const dist = path.join(repo, 'dist');
  // Route directory discovery to an existing benchmark index while retaining
  // the real project root for all on-disk source reads.
  const directory = require(path.join(dist, 'directory.js'));
  directory.getCodeGraphDir = () => path.dirname(config.database);
  directory.isInitialized = root => path.resolve(root).toLowerCase() === config.project.toLowerCase();
  directory.findNearestCodeGraphRoot = () => config.project;
  directory.validateDirectory = () => ({ valid: true, errors: [], warnings: [] });
  const adapter = require(path.join(dist, 'db/sqlite-adapter.js'));
  const createDatabase = adapter.createDatabase;
  adapter.createDatabase = dbPath => createDatabase(dbPath, { readOnly: true });
  const database = require(path.join(dist, 'db/index.js'));
  database.getDatabasePath = () => config.database;
  const { MCPEngine } = require(path.join(dist, 'mcp/engine.js'));
  MCPEngine.prototype.catchUpSync = function () {};
  const { QueryBuilder } = require(path.join(dist, 'db/queries.js'));
  for (const method of ['getNodesBySymbolExact', 'searchNodes', 'searchNodesExact',
    'searchNodesFTS', 'searchNodesLike', 'searchNodesFuzzy', 'getAllNodeNames']) {
    instrument(QueryBuilder.prototype, method);
  }
  const { ToolHandler } = require(path.join(dist, 'mcp/tools.js'));
  instrument(ToolHandler.prototype, 'findCaseInsensitiveSymbolMatches', 'caseCorrection');
  const raw = require(path.join(dist, 'mcp/raw-source-evidence.js'));
  instrument(raw, 'scanRawSourceEvidence', 'rawSource');
}

function child(config, args) {
  return spawn(process.execPath, ['--liftoff-only', __filename, '--child', ...args], {
    cwd: config.project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SEARCH_BENCH_CONFIG: JSON.stringify(config),
      CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_WATCH: '1' },
  });
}

function captureStderr(proc) {
  const phases = [], logs = [];
  createInterface({ input: proc.stderr }).on('line', line => {
    if (line.startsWith(marker)) phases.push(JSON.parse(line.slice(marker.length)));
    else logs.push(line);
  });
  return { phases, logs };
}

async function runCli(config, query, fuzzy) {
  const start = performance.now();
  const proc = child(config, ['query', query, '-p', config.project, '--json', ...(fuzzy ? ['--fuzzy'] : [])]);
  const detail = captureStderr(proc);
  let output = '';
  proc.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill(); reject(new Error('CLI timed out after 120s')); }, 120_000);
    proc.once('error', e => { clearTimeout(timer); reject(e); });
    proc.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  if (code !== 0) throw new Error(`CLI failed (${code}): ${detail.logs.join('\n')}\n${output}`);
  return { mode: fuzzy ? 'cli-fuzzy' : 'cli-exact', query, ms: performance.now() - start,
    results: JSON.parse(output), ...detail };
}

async function connectMcp(config) {
  const start = performance.now();
  const proc = child(config, ['serve', '--mcp', '-p', config.project]);
  const detail = captureStderr(proc);
  let nextId = 1;
  const pending = new Map();
  createInterface({ input: proc.stdout }).on('line', line => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id); proc.kill(); reject(new Error(`MCP ${method} timed out after 120s`));
    }, 120_000);
    const onExit = code => { clearTimeout(timer); pending.delete(id); reject(new Error(`MCP exited ${code}: ${detail.logs.join('\n')}`)); };
    proc.once('exit', onExit);
    pending.set(id, message => {
      clearTimeout(timer); proc.off('exit', onExit);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'codegraph-search-benchmark', version: '1' } });
  await request('tools/list', {});
  return { request, proc, detail, handshakeMs: performance.now() - start };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  if (!value('--project') || !value('--database')) throw new Error('Provide --project and --database');
  const config = { project: path.resolve(value('--project')), database: path.resolve(value('--database')) };
  const rounds = Number(value('--rounds', '3'));
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('--rounds must be 1..10');
  const out = path.resolve(value('--out', path.join(repo, 'bench-logs/search-miss-20260911')));
  fs.mkdirSync(out, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(config.database, { readOnly: true });
  const batch = args.includes('--batch');
  const queries = value('--queries-file') ? JSON.parse(fs.readFileSync(path.resolve(value('--queries-file')), 'utf8')) : value('--query') ? [value('--query')] :
    ['cg_missing_symbol_20260911_7e91', 'zzqvnotexist', 'cg_missing_owner::cg_missing_symbol_20260911_7e91', 'osd_getpid'];
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > 8 || queries.some(q => typeof q !== 'string' || !q.trim())) throw new Error('Queries must be 1..8 non-empty strings');
  const metadata = { ...config, node: process.version, rounds, batch,
    rawTimeoutMs: process.env.CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS ?? 'default (8000)',
    counts: db.prepare('SELECT (SELECT count(*) FROM nodes) AS nodes, (SELECT count(*) FROM files) AS files, (SELECT count(DISTINCT name) FROM nodes) AS names').get(),
    exactCounts: queries.map(query => ({ query, count: db.prepare('SELECT count(*) AS n FROM nodes WHERE name = ? OR qualified_name = ?').get(query, query).n })),
    likePlan: db.prepare('EXPLAIN QUERY PLAN SELECT * FROM nodes WHERE name LIKE ? OR qualified_name LIKE ? OR name LIKE ?').all('%zzqvnotexist%', '%zzqvnotexist%', 'zzqvnotexist%'),
    lowerNamePlan: db.prepare('EXPLAIN QUERY PLAN SELECT * FROM nodes WHERE lower(name) = ?').all('zzqvnotexist'),
    isolation: 'Read-only DB; existing MAME index; real CLI and MCP stdio; daemon, watcher and startup catch-up disabled; timing wrappers only; no search implementation changes.' };
  db.close();
  const results = [];
  const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ metadata, results }, null, 2));
  const record = entry => {
    results.push(entry); save();
    console.log(JSON.stringify({ mode: entry.mode, query: entry.query, round: entry.round, ms: Math.round(entry.ms),
      phases: entry.phases?.map(p => ({ phase: p.phase, ms: Math.round(p.ms), count: p.count, report: p.report })) }));
  };
  save();
  console.log(JSON.stringify(metadata));
  const mcp = await connectMcp(config);
  metadata.handshakeMs = mcp.handshakeMs;
  try {
    // Warm the MCP open path before measuring requests; keep this separately.
    let start = performance.now();
    const warmup = await mcp.request('tools/call', { name: 'search', arguments: { query: 'osd_getpid' } });
    if (warmup.isError) throw new Error(JSON.stringify(warmup));
    metadata.mcpWarmupMs = performance.now() - start;
    for (let round = 1; round <= rounds; round++) {
      if (batch) {
        const phaseStart = mcp.detail.phases.length;
        start = performance.now();
        const result = await mcp.request('tools/call', { name: 'search', arguments: { queries } });
        const ms = performance.now() - start;
        if (result.isError) throw new Error(JSON.stringify(result));
        record({ mode: 'mcp-batch', query: queries, round, ms, result, phases: mcp.detail.phases.slice(phaseStart) });
        continue;
      }
      for (const query of queries) {
        // Alternate order to reduce one-sided OS page-cache advantage.
        const modes = round % 2 ? ['cli-exact', 'cli-fuzzy', 'mcp'] : ['mcp', 'cli-fuzzy', 'cli-exact'];
        for (const mode of modes) {
          if (mode !== 'mcp') {
            record({ ...await runCli(config, query, mode === 'cli-fuzzy'), round });
          } else {
            const phaseStart = mcp.detail.phases.length;
            start = performance.now();
            const result = await mcp.request('tools/call', { name: 'search', arguments: { query } });
            const ms = performance.now() - start;
            if (result.isError) throw new Error(JSON.stringify(result));
            record({ mode, query, round, ms, result, phases: mcp.detail.phases.slice(phaseStart) });
          }
        }
      }
    }
  } finally {
    metadata.mcpLogs = mcp.detail.logs;
    save();
    const closed = new Promise(resolve => mcp.proc.once('close', resolve));
    mcp.proc.stdin.end();
    const timer = setTimeout(() => mcp.proc.kill(), 3000);
    await closed;
    clearTimeout(timer);
  }
  console.log(`Saved ${path.join(out, 'results.json')}`);
}

module.exports = { installBenchmarkHooks, connectMcp };

if (require.main === module && process.argv[2] === '--child') {
  const config = JSON.parse(process.env.SEARCH_BENCH_CONFIG);
  installBenchmarkHooks(config);
  process.argv = [process.execPath, cli, ...process.argv.slice(3)];
  require(cli);
} else if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
