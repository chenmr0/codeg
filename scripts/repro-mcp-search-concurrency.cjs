#!/usr/bin/env node
/** Reproduce raw-source timeout under real overlapping MCP symbol queries. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createInterface } = require('node:readline');
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const repo = path.resolve(__dirname, '..');
const prefix = '[mcp-overlap] ';
const targetQueries = ['LICENSE_SMART_SCHEDULE_ADAPTIVE_QQ', 'LICENSE_INTRA_SITE_RESOURCE_PRECISE_ORCHESTRA_AJ'];
const heavyQueries = Array.from({ length: 8 }, (_, i) => `CG_CONCURRENCY_MISSING_SYMBOL_${i + 1}_8F31`);
const out = path.join(repo, 'bench-logs', `mcp-search-concurrency-${Date.now()}`);

function setupChild(config) {
  const { installBenchmarkHooks } = require('./repro-search-miss.cjs');
  installBenchmarkHooks(config);
  const context = new AsyncLocalStorage();
  const event = (kind, fields = {}) => process.stderr.write(prefix + JSON.stringify({ kind, at: Date.now(), ...context.getStore(), ...fields }) + '\n');
  let sequence = 0;
  const { ToolHandler } = require(path.join(repo, 'dist/mcp/tools.js'));
  const { MCPSession } = require(path.join(repo, 'dist/mcp/session.js'));
  const startSession = MCPSession.prototype.start;
  MCPSession.prototype.start = function () { startSession.call(this); event('session-ready'); };
  const execute = ToolHandler.prototype.execute;
  ToolHandler.prototype.execute = function (name, args, options) {
    return context.run({ sequence: ++sequence, queries: args.queries || [args.query] }, async () => {
      const start = performance.now();
      event('tool-start', { name });
      const result = await execute.call(this, name, args, options);
      event('tool-end', { ms: performance.now() - start });
      return result;
    });
  };
  const raw = require(path.join(repo, 'dist/mcp/raw-source-evidence.js'));
  const scan = raw.scanRawSourceEvidence;
  raw.scanRawSourceEvidence = async function (...args) {
    const start = performance.now();
    event('raw-start');
    const result = await scan.apply(this, args);
    event('raw-end', { ms: performance.now() - start, report: result });
    return result;
  };
  // New builds own rg in a worker. Observe its progress messages without
  // changing the scanner; old builds continue using the spawn observer below.
  const workerClientPath = path.join(repo, 'dist/mcp/raw-source-worker-client.js');
  if (fs.existsSync(workerClientPath)) {
    const workerClient = require(workerClientPath);
    const run = workerClient.runRawEvidenceWorker;
    workerClient.runRawEvidenceWorker = function (owner, task, signal, onProgress) {
      const captured = context.getStore();
      return run(owner, task, signal, progress => {
        event(progress.event === 'start' ? 'rg-start' : 'rg-close', {
          ...captured, stage: progress.stage, pid: progress.pid,
          ms: progress.elapsedMs, code: progress.status, fromWorker: true,
        });
        onProgress?.(progress);
      });
    };
  }
  const spawn = cp.spawn;
  cp.spawn = function (executable, args, options) {
    const child = spawn.call(this, executable, args, options);
    if (!/rg(?:\.exe)?$/i.test(path.basename(executable))) return child;
    const captured = context.getStore();
    const start = performance.now();
    const info = { ...captured, stage: args.includes('--files') ? 'inventory' : 'search', pid: child.pid };
    event('rg-start', info);
    let stdoutBytes = 0, jsonOutput = '';
    child.stdout.on('data', chunk => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (info.stage === 'search' && stdoutBytes <= 1024 * 1024) jsonOutput += chunk.toString();
    });
    const kill = child.kill.bind(child);
    child.kill = function (...args) { event('rg-kill', { ...info, ms: performance.now() - start, stdoutBytes }); return kill(...args); };
    child.once('close', (code, signal) => {
      let summary;
      for (const line of jsonOutput.split('\n')) {
        try { const message = JSON.parse(line); if (message.type === 'summary') summary = message.data; } catch { /* partial line */ }
      }
      event('rg-close', { ...info, code, signal, ms: performance.now() - start, stdoutBytes, summary });
    });
    return child;
  };
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const lagMs = now - last - 50;
    last = now;
    if (lagMs > 100) event('event-loop-lag', { lagMs });
  }, 50).unref();
}

function startProcess(config, mode) {
  return cp.spawn(process.execPath, ['--liftoff-only', __filename, mode], {
    cwd: config.project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MCP_OVERLAP_CONFIG: JSON.stringify(config),
      CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_WATCH: '1', CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS: '8000' },
  });
}

async function runStandalone(config) {
  const start = performance.now();
  const proc = startProcess(config, '--raw');
  let stdout = '', stderr = '';
  proc.stdout.on('data', chunk => { stdout += chunk; });
  proc.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { proc.once('close', resolve); proc.once('error', reject); });
  if (code !== 0) throw new Error(stderr);
  return { processMs: performance.now() - start, ...JSON.parse(stdout) };
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const args = process.argv.slice(2);
  const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const daemonMode = args.includes('--daemon-test');
  const triggerStage = value('--trigger', 'inventory');
  const rounds = Number(value('--rounds', '2'));
  if (!['inventory', 'search'].includes(triggerStage) || !Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new Error('Invalid trigger or rounds');
  const config = { project: path.resolve(value('--project', 'D:/c_proj/mame')), database: path.resolve(value('--database', path.join(repo, 'bench-logs/mame-init-20260909/fork-macro-context/codegraph.db'))), out };
  const evidence = { config, mode: daemonMode ? 'daemon-two-clients' : 'stdio-one-client', triggerStage, timeoutMs: 8000, scenarios: [], events: [], diagnosticPhases: [], logs: [] };
  console.log(`Artifacts: ${out}`);
  const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(evidence, null, 2));
  const proc = startProcess(config, daemonMode ? '--daemon' : '--mcp');
  let nextId = 1;
  const pending = new Map();
  const observers = new Set();
  let daemonReady;
  const ready = new Promise(resolve => { daemonReady = resolve; });
  let primary = proc.stdin, secondary = proc.stdin;
  const sockets = [];
  createInterface({ input: proc.stderr }).on('line', line => {
    fs.appendFileSync(path.join(out, 'server.jsonl'), line + '\n');
    if (line.startsWith(prefix)) {
      const item = JSON.parse(line.slice(prefix.length));
      evidence.events.push(item);
      if (item.kind === 'daemon-ready') daemonReady(item.socketPath);
      for (const observer of [...observers]) observer(item);
    } else if (line.startsWith('[search-bench] ')) {
      evidence.diagnosticPhases.push(JSON.parse(line.slice('[search-bench] '.length)));
    } else evidence.logs.push(line);
  });
  const receive = line => {
    fs.appendFileSync(path.join(out, 'responses.jsonl'), line + '\n');
    const message = JSON.parse(line);
    const callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); callback(message); }
  };
  createInterface({ input: proc.stdout }).on('line', receive);
  const request = (method, params = {}, destination = primary) => new Promise((resolve, reject) => {
    const id = nextId++, start = performance.now();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); proc.kill(); }, 120_000);
    pending.set(id, message => {
      clearTimeout(timer);
      if (message.error || message.result?.isError) reject(new Error(JSON.stringify(message)));
      else resolve({ ms: performance.now() - start, result: message.result });
    });
    destination.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const search = (queries, destination = primary) => request('tools/call', { name: 'search', arguments: { queries } }, destination);
  const summary = entry => ({ label: entry.label, targetMs: Math.round(entry.target.ms),
    inconclusive: entry.target.result.content[0].text.includes('INCONCLUSIVE'),
    heavyMs: entry.heavy && Math.round(entry.heavy.ms), pingMs: entry.ping && Math.round(entry.ping.ms),
    standaloneRawMs: entry.standalone && Math.round(entry.standalone.rawMs),
    standaloneTimeout: entry.standalone?.report.timeBudgetReached });
  try {
    if (daemonMode) {
      const socketPath = await ready;
      const { connectWithHello } = require(path.join(repo, 'dist/mcp/proxy.js'));
      const connect = async () => {
        const socket = await connectWithHello(socketPath);
        if (!socket || typeof socket === 'string') throw new Error('Daemon connection failed');
        sockets.push(socket);
        createInterface({ input: socket }).on('line', receive);
        return socket;
      };
      primary = await connect();
      secondary = await connect();
      // Observe both real sessions being attached before sending requests;
      // this keeps the experiment independent of client-hello pipelining.
      if (evidence.events.filter(e => e.kind === 'session-ready').length < 2) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { observers.delete(check); reject(new Error('Session setup timed out')); }, 10_000);
          const check = () => {
            if (evidence.events.filter(e => e.kind === 'session-ready').length >= 2) {
              clearTimeout(timer); observers.delete(check); resolve();
            }
          };
          observers.add(check); check();
        });
      }
    }
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-overlap-repro', version: '1' } });
    await request('tools/list');
    if (daemonMode) {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-overlap-second-client', version: '1' } }, secondary);
      await request('tools/list', {}, secondary);
    }
    await search(['debugload']);
    let entry = { label: 'serial-before', target: await search(targetQueries) };
    evidence.scenarios.push(entry); save(); console.log(JSON.stringify(summary(entry)));
    for (let round = 1; round <= rounds; round++) {
      // Dispatch a genuine 8-symbol MCP request while the first request is
      // waiting for its real rg inventory child. No fake delay or busy loop.
      const overlapStart = Date.now();
      let heavyPromise, rawPromise, pingPromise;
      const trigger = event => {
        if (event.kind !== 'rg-start' || event.stage !== triggerStage || event.queries?.[0] !== targetQueries[0]) return;
        observers.delete(trigger);
        heavyPromise = search(heavyQueries, secondary);
        rawPromise = runStandalone(config);
        pingPromise = new Promise(resolve => setTimeout(resolve, 100)).then(() => request('ping'));
      };
      observers.add(trigger);
      const target = await search(targetQueries);
      observers.delete(trigger);
      if (!heavyPromise) throw new Error('Overlap trigger did not run');
      const [heavy, standalone, ping] = await Promise.all([heavyPromise, rawPromise, pingPromise]);
      entry = { label: `overlap-${round}`, startedAt: overlapStart, target, heavy, standalone, ping };
      evidence.scenarios.push(entry); save(); console.log(JSON.stringify(summary(entry)));
    }
    entry = { label: 'serial-after', target: await search(targetQueries) };
    evidence.scenarios.push(entry); save(); console.log(JSON.stringify(summary(entry)));
    if (args.includes('--expect-success') && evidence.scenarios.some(s => s.target.result.content[0].text.includes('INCONCLUSIVE'))) {
      throw new Error('Regression: a target scan was inconclusive under concurrent MCP load');
    }
  } finally {
    const closed = proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise(resolve => proc.once('close', resolve));
    for (const socket of sockets) socket.end();
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill(), 3000);
    await closed; clearTimeout(timer); save();
  }
  console.log(`Artifacts: ${out}`);
}

if (['--mcp', '--raw', '--daemon'].includes(process.argv[2])) {
  const config = JSON.parse(process.env.MCP_OVERLAP_CONFIG);
  setupChild(config);
  if (process.argv[2] === '--mcp') {
    const cli = path.join(repo, 'dist/bin/codegraph.js');
    process.argv = [process.execPath, cli, 'serve', '--mcp', '--path', config.project];
    require(cli);
  } else if (process.argv[2] === '--daemon') {
    const daemonPaths = require(path.join(repo, 'dist/mcp/daemon-paths.js'));
    const socketPath = process.platform === 'win32' ? daemonPaths.getDaemonSocketPath(config.project) + `-repro-${process.pid}` : path.join(require('node:os').tmpdir(), `cg-overlap-${process.pid}.sock`);
    const pidPath = path.join(config.out, 'daemon.pid');
    daemonPaths.getDaemonSocketPath = () => socketPath;
    daemonPaths.getDaemonPidPath = () => pidPath;
    const { Daemon } = require(path.join(repo, 'dist/mcp/daemon.js'));
    const daemon = new Daemon(config.project, { idleTimeoutMs: 1000 });
    daemon.start().then(result => {
      fs.writeFileSync(pidPath, JSON.stringify(result.lock));
      process.stderr.write(prefix + JSON.stringify({ kind: 'daemon-ready', at: Date.now(), socketPath }) + '\n');
    }).catch(error => { console.error(error); process.exitCode = 1; });
  } else {
    (async () => {
      const { CodeGraph } = require(path.join(repo, 'dist/index.js'));
      const { scanRawSourceEvidence } = require(path.join(repo, 'dist/mcp/raw-source-evidence.js'));
      const cg = await CodeGraph.open(config.project);
      try {
        const start = performance.now();
        const report = await scanRawSourceEvidence(cg, targetQueries.map(needle => ({ label: needle, needle })));
        console.log(JSON.stringify({ rawMs: performance.now() - start, report }));
      } finally { cg.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  }
} else main().catch(error => { console.error(error); process.exitCode = 1; });
