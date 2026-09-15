#!/usr/bin/env node
/** Profile real MCP batch searches using an existing read-only MAME index.
 * node scripts/repro-search-batch-profile.cjs [--project ROOT] [--database DB]
 *   [--rounds 3] [--calls-file JSON] [--out DIR]
 * Reuses the read-only/startup isolation hooks from repro-search-miss.cjs.
 * Timings are nested/inclusive; do not sum parents and children together.
 */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createInterface } = require('node:readline');
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const repo = path.resolve(__dirname, '..');
const marker = '[batch-profile] ';
const userSymbols = ['TIFM_X2itfSonNeedProbeMsg', 'TIFM_X2itfIsMixedAddr', 'TIFM_X2itfSonFillProbeXnTnlCfgInfo'];

function childMain(config) {
  require('./repro-search-miss.cjs').installBenchmarkHooks(config);
  const context = new AsyncLocalStorage();
  const emit = event => process.stderr.write(marker + JSON.stringify({ at: performance.now(), ...context.getStore(), ...event }) + '\n');
  const adapter = require(path.join(repo, 'dist/db/sqlite-adapter.js'));
  const createDatabase = adapter.createDatabase;
  adapter.createDatabase = function (...args) {
    const opened = createDatabase(...args);
    const db = opened.db;
    const prepare = db.prepare.bind(db);
    db.prepare = function (sql) {
      const statement = prepare(sql);
      const all = statement.all.bind(statement);
      statement.all = function (...params) {
        const start = performance.now();
        const result = all(...params);
        const ms = performance.now() - start;
        if (ms >= 20 || sql.includes('COLLATE NOCASE')) emit({ event: 'sql', sql: sql.replace(/\s+/g, ' ').trim(), ms, count: result.length });
        return result;
      };
      return statement;
    };
    return opened;
  };
  let id = 0;
  function instrument(target, name, label = name) {
    const original = target[name];
    if (typeof original !== 'function') throw new Error(`Missing method ${label}`);
    target[name] = function (...args) {
      const start = performance.now();
      const callId = ++id;
      const parentId = context.getStore()?.callId;
      const query = typeof args[0] === 'string' ? args[0] : args[0]?.query;
      return context.run({ ...context.getStore(), callId, parentId }, () => {
        emit({ event: 'start', phase: label, query });
        const finish = (result, error) => {
          emit({ event: 'end', phase: label, query, ms: performance.now() - start,
            count: Array.isArray(result) ? result.length : undefined,
            error: error ? String(error) : undefined,
            report: label === 'rawSource' ? result : undefined });
          if (error) throw error;
          return result;
        };
        try {
          const result = original.apply(this, args);
          return result?.then ? result.then(r => finish(r), e => finish(undefined, e)) : finish(result);
        } catch (error) { return finish(undefined, error); }
      });
    };
  }
  const { QueryBuilder } = require(path.join(repo, 'dist/db/queries.js'));
  for (const method of ['getNodesBySymbolExact', 'searchNodes', 'searchNodesFTS', 'searchNodesLike', 'searchNodesFuzzy', 'getAllNodeNames']) {
    instrument(QueryBuilder.prototype, method);
  }
  const { ToolHandler } = require(path.join(repo, 'dist/mcp/tools.js'));
  for (const method of ['handleSearch', 'handleSearchSingle', 'formatSearchResults', 'findCaseInsensitiveSymbolMatches']) {
    instrument(ToolHandler.prototype, method);
  }
  const execute = ToolHandler.prototype.execute;
  let requestId = 0;
  ToolHandler.prototype.execute = function (...args) {
    return context.run({ requestId: ++requestId }, () => execute.apply(this, args));
  };
  const { CodeGraph } = require(path.join(repo, 'dist/index.js'));
  instrument(CodeGraph.prototype, 'getFiles');
  const raw = require(path.join(repo, 'dist/mcp/raw-source-evidence.js'));
  instrument(raw, 'scanRawSourceEvidence', 'rawSource');
  const worker = require(path.join(repo, 'dist/mcp/raw-source-worker-client.js'));
  const run = worker.runRawEvidenceWorker;
  worker.runRawEvidenceWorker = function (owner, task, signal, onProgress) {
    emit({ event: 'worker-submit', files: task.files.length, timeoutMs: task.timeoutMs });
    return run(owner, task, signal, progress => {
      emit({ event: 'worker-progress', progress });
      onProgress?.(progress);
    });
  };
  let previousTick = performance.now();
  setInterval(() => {
    const now = performance.now();
    const lagMs = now - previousTick - 50;
    previousTick = now;
    if (lagMs > 100) emit({ event: 'event-loop-lag', lagMs });
  }, 50).unref();
  const cli = path.join(repo, 'dist/bin/codegraph.js');
  process.argv = [process.execPath, cli, 'serve', '--mcp', '-p', config.project];
  require(cli);
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const config = {
    project: path.resolve(value('--project', 'D:/c_proj/mame')),
    database: path.resolve(value('--database', path.join(repo, 'bench-logs/mame-init-20260909/fork-macro-context/codegraph.db'))),
  };
  const rounds = Number(value('--rounds', '3'));
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('--rounds must be 1..10');
  const out = path.resolve(value('--out', path.join(repo, 'bench-logs/search-batch-20260915')));
  const calls = value('--calls-file') ? JSON.parse(fs.readFileSync(path.resolve(value('--calls-file')), 'utf8').replace(/^\uFEFF/, '')) : [
    { label: 'reported-three-symbols', arguments: { queries: userSymbols.map(query => ({ query, includeCode: 'if_unique' })) } },
  ];
  fs.mkdirSync(out, { recursive: true });
  const initialStat = fs.statSync(config.database);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(config.database, { readOnly: true });
  const metadata = { ...config, node: process.version, rounds, calls,
    searchFuzzyEnv: process.env.CODEGRAPH_SEARCH_FUZZY ?? null,
    codegraphCommit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim(),
    projectCommit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: config.project, encoding: 'utf8', windowsHide: true }).trim(),
    counts: db.prepare('SELECT (SELECT count(*) FROM nodes) nodes, (SELECT count(*) FROM files) files, (SELECT count(DISTINCT name) FROM nodes) names').get(),
    plans: {
      like: db.prepare('EXPLAIN QUERY PLAN SELECT * FROM nodes WHERE name LIKE ? OR qualified_name LIKE ? OR name LIKE ?').all('%TIFM_X2itfIsMixedAddr%', '%TIFM_X2itfIsMixedAddr%', 'TIFM_X2itfIsMixedAddr%'),
      names: db.prepare('EXPLAIN QUERY PLAN SELECT DISTINCT name FROM nodes').all(),
      caseSupplement: db.prepare('EXPLAIN QUERY PLAN SELECT * FROM nodes WHERE name = ? COLLATE NOCASE').all('TIFM_X2itfIsMixedAddr'),
      indexedLower: db.prepare('EXPLAIN QUERY PLAN SELECT * FROM nodes WHERE lower(name) = ?').all('tifm_x2itfismixedaddr'),
    },
    exactCounts: userSymbols.map(query => ({ query, ...db.prepare('SELECT count(*) n FROM nodes WHERE name = ? OR qualified_name = ?').get(query, query) })),
    isolation: 'Existing read-only index; real stdio MCP; startup catch-up, daemon and watcher disabled; timing wrappers only. OS page cache is not cleared.',
  };
  db.close();
  const results = [], events = [], logs = [];
  const traceWaiters = new Map();
  const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ metadata, results, events, logs }, null, 2));
  save();
  const proc = cp.spawn(process.execPath, ['--liftoff-only', __filename, '--child'], {
    cwd: config.project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BATCH_PROFILE_CONFIG: JSON.stringify(config), CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_WATCH: '1', CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS: '8000' },
  });
  createInterface({ input: proc.stderr }).on('line', line => {
    if (line.startsWith(marker)) {
      const event = JSON.parse(line.slice(marker.length));
      events.push(event);
      if (event.event === 'end' && event.phase === 'handleSearch') traceWaiters.get(event.requestId)?.();
    }
    else if (!line.startsWith('[search-bench] ')) logs.push(line);
    fs.appendFileSync(path.join(out, 'server.jsonl'), line + '\n');
  });
  const pending = new Map();
  let nextId = 0;
  createInterface({ input: proc.stdout }).on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { proc.kill(); finish(new Error(`MCP ${method} timed out after 10 minutes`)); }, 600000);
    const onExit = code => finish(new Error(`MCP exited ${code}`));
    function finish(error, result) {
      clearTimeout(timer); pending.delete(id); proc.off('exit', onExit); proc.off('error', onError);
      if (error) reject(error); else resolve(result);
    }
    const onError = error => finish(error);
    proc.once('exit', onExit); proc.once('error', onError);
    pending.set(id, message => finish(message.error ? new Error(JSON.stringify(message.error)) : null, message.result));
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  // stdout replies and stderr traces are independent pipes. Correlate by the
  // server's tool request ID and wait for the final trace before aggregating.
  const completeTrace = requestId => new Promise((resolve, reject) => {
    if (events.some(e => e.requestId === requestId && e.event === 'end' && e.phase === 'handleSearch')) return resolve();
    const timer = setTimeout(() => { traceWaiters.delete(requestId); reject(new Error(`Missing trace for request ${requestId}`)); }, 5000);
    traceWaiters.set(requestId, () => { clearTimeout(timer); traceWaiters.delete(requestId); resolve(); });
  });
  try {
    let start = performance.now();
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'batch-profile', version: '1' } });
    await request('tools/list', {});
    metadata.handshakeMs = performance.now() - start;
    start = performance.now();
    const warmup = await request('tools/call', { name: 'search', arguments: { query: 'debugload', includeCode: 'if_unique' } });
    if (warmup.isError) throw new Error(JSON.stringify(warmup));
    metadata.warmupMs = performance.now() - start;
    let requestId = 1;
    await completeTrace(requestId);
    for (let round = 1; round <= rounds; round++) {
      for (const call of calls) {
        requestId++;
        start = performance.now();
        const result = await request('tools/call', { name: 'search', arguments: call.arguments });
        const ms = performance.now() - start;
        if (result.isError) throw new Error(JSON.stringify(result));
        await completeTrace(requestId);
        const ownEvents = events.filter(e => e.requestId === requestId);
        const beginAt = ownEvents[0].at;
        const endAt = ownEvents.at(-1).at;
        const phases = events.filter(e => e.requestId === requestId || (e.event === 'event-loop-lag' && e.at >= beginAt && e.at <= endAt));
        const sum = name => phases.filter(e => e.event === 'end' && e.phase === name).reduce((total, e) => total + e.ms, 0);
        const summary = { label: call.label, round, ms, exactMs: sum('getNodesBySymbolExact'), caseCorrectionMs: sum('findCaseInsensitiveSymbolMatches'), searchMs: sum('searchNodes'), ftsMs: sum('searchNodesFTS'), likeMs: sum('searchNodesLike'), fuzzyMs: sum('searchNodesFuzzy'), namesMs: sum('getAllNodeNames'), formatMs: sum('formatSearchResults'), rawMs: sum('rawSource'), getFilesMs: sum('getFiles') };
        results.push({ ...summary, arguments: call.arguments, result, phases });
        save();
        console.log(JSON.stringify(summary));
      }
    }
  } finally {
    const finalStat = fs.statSync(config.database);
    metadata.databaseUnchanged = initialStat.size === finalStat.size && initialStat.mtimeMs === finalStat.mtimeMs;
    save();
    if (proc.exitCode === null) {
      const closed = new Promise(resolve => proc.once('close', resolve));
      proc.stdin.end();
      const timer = setTimeout(() => proc.kill(), 3000);
      await closed;
      clearTimeout(timer);
    }
  }
  console.log(`Saved ${path.join(out, 'results.json')}`);
}

if (process.argv[2] === '--child') childMain(JSON.parse(process.env.BATCH_PROFILE_CONFIG));
else main().catch(error => { console.error(error); process.exitCode = 1; });
