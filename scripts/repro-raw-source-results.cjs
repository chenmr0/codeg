#!/usr/bin/env node
/** Real-ripgrep repro for raw-source timeout accounting and result decoding. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { performance } = require('node:perf_hooks');
const repo = path.resolve(__dirname, '..');
const out = path.join(repo, 'bench-logs', `raw-source-results-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const needles = ['LICENSE_SMART_SCHEDULE_ADAPTIVE_QQ', 'LICENSE_INTRA_SITE_RESOURCE_PRECISE_ORCHESTRA_AJ'];
const specs = needles.map(needle => ({ label: needle, needle }));
const experiments = [];
let active;
let rgId = 0;
const spawn = cp.spawn;
// Observe real child output without changing commands, bytes or timing policy.
cp.spawn = function (executable, args, options) {
  const child = spawn.call(this, executable, args, options);
  if (!active || path.basename(executable).toLowerCase() !== 'rg.exe' && path.basename(executable) !== 'rg') return child;
  const start = performance.now();
  const logFile = path.join(out, `rg-${++rgId}.stdout`);
  const log = fs.createWriteStream(logFile);
  const event = { args, cwd: options.cwd, logFile, stdoutBytes: 0, types: {}, matches: 0, ends: 0,
    byteEncodedMatches: 0, finishedIndexedFiles: 0 };
  active.ripgrep.push(event);
  let buffer = '';
  child.stdout.on('data', chunk => {
    log.write(chunk);
    event.stdoutBytes += Buffer.byteLength(chunk);
    if (!args.includes('--json')) return;
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let json; try { json = JSON.parse(line); } catch { continue; }
      event.types[json.type] = (event.types[json.type] || 0) + 1;
      if (json.type === 'match') {
        event.matches++;
        if (json.data?.lines?.bytes) event.byteEncodedMatches++;
        if (!event.firstMatch) event.firstMatch = json;
      }
      if (json.type === 'end') {
        event.ends++;
        if (active?.indexedPaths?.has(json.data?.path?.text?.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase())) event.finishedIndexedFiles++;
      }
    }
  });
  child.once('close', (code, signal) => { event.ms = performance.now() - start; event.code = code; event.signal = signal; log.end(); });
  return child;
};
const { CodeGraph } = require(path.join(repo, 'dist/index.js'));
const { ToolHandler } = require(path.join(repo, 'dist/mcp/tools.js'));
const { scanRawSourceEvidence, formatRawSourceEvidence } = require(path.join(repo, 'dist/mcp/raw-source-evidence.js'));
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ node: process.version, needles, experiments }, (key, value) => key === 'indexedPaths' ? undefined : value, 2));

async function run(label, cg, fn) {
  active = { label, ripgrep: [], indexedPaths: new Set(cg.getFiles().map(f => f.path.replace(/\\/g, '/').toLowerCase())) };
  const entry = active;
  const start = performance.now();
  const result = await fn();
  entry.ms = performance.now() - start;
  if (result.states) { entry.report = result; entry.output = formatRawSourceEvidence(result); }
  else { entry.result = result; entry.output = result.content.map(x => x.text).join('\n'); }
  experiments.push(entry); save(); active = null;
  console.log(JSON.stringify({ label, ms: Math.round(entry.ms),
    raw: entry.ripgrep.map(x => ({ stage: x.args.includes('--files') ? 'inventory' : 'search', ms: Math.round(x.ms), matches: x.matches, ends: x.ends, finishedIndexedFiles: x.finishedIndexedFiles, byteEncodedMatches: x.byteEncodedMatches })),
    scanned: entry.report?.totalScannedFiles, timedOut: entry.report?.timeBudgetReached,
    matches: entry.report?.states.map(s => s.matchingLines), output: entry.output.slice(0, 1800) }));
}

async function fixture() {
  const root = path.join(out, 'fixture');
  fs.mkdirSync(root);
  const source = path.join(root, 'markers.cpp');
  fs.writeFileSync(source, needles.map(n => `// ${n} 中文注释\n`).join(''));
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  const handler = new ToolHandler(cg);
  try {
    process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND = 'ripgrep';
    process.env.CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS = '8000';
    await run('utf8-real-ripgrep-batch', cg, () => handler.execute('search', { queries: needles }));
    process.env.CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS = '0';
    await run('timeout-before-inventory-batch', cg, () => handler.execute('search', { queries: needles }));
    process.env.CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS = '8000';
    // Chinese GBK bytes on the same line make ripgrep emit JSON lines.bytes.
    fs.writeFileSync(source, Buffer.concat(needles.flatMap(n => [Buffer.from(`// ${n} `), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\n')])));
    await run('gbk-real-ripgrep-report', cg, () => scanRawSourceEvidence(cg, specs));
    await run('gbk-real-ripgrep-batch', cg, () => handler.execute('search', { queries: needles }));
    process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND = 'node';
    await run('same-gbk-file-node-control', cg, () => scanRawSourceEvidence(cg, specs));
  } finally { cg.close(); }
}

async function mame() {
  const root = 'D:/c_proj/mame';
  const dbPath = path.join(repo, 'bench-logs/mame-init-20260909/fork-macro-context/codegraph.db');
  if (!fs.existsSync(root) || !fs.existsSync(dbPath)) return;
  const { createDatabase } = require(path.join(repo, 'dist/db/sqlite-adapter.js'));
  const { DatabaseConnection } = require(path.join(repo, 'dist/db/index.js'));
  const { QueryBuilder } = require(path.join(repo, 'dist/db/queries.js'));
  const opened = createDatabase(dbPath, { readOnly: true });
  opened.db.pragma('cache_size = -64000');
  opened.db.pragma('mmap_size = 268435456');
  const connection = new DatabaseConnection(opened.db, dbPath, opened.backend);
  const cg = new CodeGraph(connection, new QueryBuilder(opened.db), root);
  process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND = 'ripgrep';
  process.env.CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS = '8000';
  try {
    await run('mame-two-license-names-default-8s', cg, () => scanRawSourceEvidence(cg, specs));
    for (const budget of [100, 300, 500]) {
      await run(`mame-two-license-names-${budget}ms`, cg, () => scanRawSourceEvidence(cg, specs, undefined, { timeoutMs: budget }));
    }
    for (const budget of [300, 500]) {
      await run(`mame-existing-raw-matches-${budget}ms`, cg, () => scanRawSourceEvidence(cg,
        [{ needle: 'ROM_START', label: 'ROM_START' }], undefined, { timeoutMs: budget }));
    }
  } finally { cg.close(); }
}

(async () => {
  console.log(`Artifacts: ${out}`);
  await fixture();
  await mame();
  save();
})().catch(error => { save(); console.error(error); process.exitCode = 1; });
