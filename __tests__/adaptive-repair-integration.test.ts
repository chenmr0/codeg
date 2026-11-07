/** Repaired automatic entry paths and real generation lifetime contracts. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs'; import path from 'path'; import os from 'os';
import { spawnSync, spawn } from 'child_process';
import { once } from 'events';
import type { CodeGraph as Graph } from '../src';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { getCodeGraphDir, createDirectory } = require('../dist/directory') as typeof import('../src/directory');
const { resolveGeneration, collectRetiredGenerations, drainGenerationCollections, GenerationWriterLock, createGeneration, publishInitialGeneration, cleanupGenerationCandidate } = require('../dist/sync/generation-store') as typeof import('../src/sync/generation-store');
const legacyDist = process.env.CODEGRAPH_LEGACY_DIST ?? path.resolve(__dirname, '../../adaptive-perf-20261028/codeg-baseline/dist');
let root: string; const graphs: Graph[] = []; let argv: string[];
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-repair-integration-')); argv = process.execArgv; process.execArgv = ['--liftoff-only']; });
afterEach(async () => { vi.restoreAllMocks(); for (const graph of graphs.splice(0)) { graph.close(); await graph.whenIdle(); } await drainGenerationCollections(); process.execArgv = argv; fs.rmSync(root, { recursive: true, force: true }); });
async function fresh(count = 2, legacyGeneration = false): Promise<Graph> {
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(root, `f${i}.c`), `int initial_${i}(void) { return ${i}; }\n`);
  if (!legacyGeneration) { const graph = await CodeGraph.init(root, { index: true }); graphs.push(graph); return graph; }
  // These compatibility tests explicitly exercise retained CURRENT/generation
  // lifetime semantics. Fresh production projects now use a fixed portable DB.
  createDirectory(root);
  const dataDir = getCodeGraphDir(root), lock = new GenerationWriterLock(dataDir);
  lock.acquire();
  try {
    const candidate = createGeneration(dataDir, lock);
    try {
      const builder = await CodeGraph.createShadow(root, candidate.databasePath);
      try { expect((await builder.indexAll()).complete).toBe(true); }
      finally { builder.close(); await builder.whenIdle(); }
      await publishInitialGeneration(dataDir, candidate, { lock, validate: () => true });
    } finally { cleanupGenerationCandidate(dataDir, candidate); }
  } finally { lock.release(); }
  const graph = CodeGraph.openSync(root); graphs.push(graph); return graph;
}
function change(count: number): void { for (let i = 0; i < count; i++) fs.writeFileSync(path.join(root, `f${i}.c`), `int replaced_${i}(void) { return ${i + 1000}; }\n`); }
it.skipIf(!fs.existsSync(path.join(legacyDist, 'index.js')))('automatically upgrades a real untouched official legacy index without manual init', async () => {
  const baseline = legacyDist;
  fs.writeFileSync(path.join(root, 'legacy.c'), 'int legacy_symbol(void) { return 4; }\n');
  const build = spawnSync(process.execPath, ['--liftoff-only', '-e', `const {CodeGraph}=require(${JSON.stringify(baseline)}); (async()=>{let g=await CodeGraph.init(${JSON.stringify(root)},{index:true});g.close()})().catch(e=>{console.error(e);process.exitCode=1});`], { encoding: 'utf8', timeout: 30_000 });
  expect(build.status, build.stderr).toBe(0);
  // This actual old executable keeps a live DB reader without knowing our lease protocol.
  const legacyReader = spawn(process.execPath, ['--liftoff-only', '-e', `
    const {CodeGraph}=require(${JSON.stringify(baseline)}); const g=CodeGraph.openSync(${JSON.stringify(root)});
    process.on('message',m=>{if(m==='query')process.send({count:g.searchNodes('legacy_symbol').length});
      if(m==='close'){g.close();process.disconnect();}}); process.send({ready:true});
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const [ready] = await once(legacyReader, 'message'); expect(ready.ready).toBe(true);
    const graph = CodeGraph.openSync(root); graphs.push(graph);
    const result = await graph.sync();
    expect(result.adaptive?.strategy).not.toBe('rebuild');
    expect(graph.isIndexStale()).toBe(false);
    expect(graph.searchNodes('legacy_symbol').length).toBeGreaterThan(0);
    expect(graph.getDatabaseFilePath()).toBe(path.join(getCodeGraphDir(root), 'codegraph.db'));
    await collectRetiredGenerations(getCodeGraphDir(root));
    const answer = once(legacyReader, 'message'); legacyReader.send('query');
    const [read] = await answer; expect(read.count).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(getCodeGraphDir(root), 'codegraph.db'))).toBe(true);
  } finally {
    if (legacyReader.exitCode === null) { const exit = once(legacyReader, 'exit'); legacyReader.send('close'); await exit; }
  }
}, 60_000);
it('first large scoped change uses automatic rebuilding with no incremental observations', async () => {
  const graph = await fresh(130); change(130);
  const result = await graph.sync({ paths: Array.from({ length: 130 }, (_, i) => `f${i}.c`) });
  expect(result.adaptive?.strategy).toBe('rebuild'); expect(result.adaptive?.reason).toBe('structural-large-change');
  expect(graph.searchNodes('replaced_129').length).toBeGreaterThan(0);
}, 60_000);
it('ignore configuration changes reconcile membership incrementally in both directions', async () => {
  const graph = await fresh();
  fs.writeFileSync(path.join(root, '.gitignore'), 'f1.c\n');
  const decisions: string[] = [];
  expect((await graph.sync({ onAdaptiveDecision: decision => decisions.push(decision.strategy) })).complete).toBe(true);
  expect(decisions).not.toContain('rebuild');
  expect(graph.getFiles().map(file => file.path)).toEqual(['f0.c']);
  fs.unlinkSync(path.join(root, '.gitignore'));
  decisions.length = 0;
  expect((await graph.sync({ onAdaptiveDecision: decision => decisions.push(decision.strategy) })).complete).toBe(true);
  expect(decisions).not.toContain('rebuild');
  expect(graph.getFiles()).toHaveLength(2);
}, 60_000);
it('legacy CURRENT retains a real retired SQLite generation until readers close, including a failed close retry', async () => {
  const graph = await fresh(130, true);
  const oldLocation = resolveGeneration(getCodeGraphDir(root));
  const old = CodeGraph.openReadOnlySync(root); graphs.push(old);
  change(130);
  expect((await graph.sync()).adaptive?.reason).toBe('structural-large-change');
  graph.close();
  await collectRetiredGenerations(getCodeGraphDir(root)); expect(fs.existsSync(oldLocation.databasePath)).toBe(true);
  const db = (old as any).db;
  const close = vi.spyOn(db, 'close').mockImplementationOnce(() => { throw new Error('injected live close failure'); });
  expect(() => old.close()).toThrow('injected live close failure'); expect(db.isOpen()).toBe(true);
  await collectRetiredGenerations(getCodeGraphDir(root)); expect(fs.existsSync(oldLocation.databasePath)).toBe(true);
  close.mockRestore(); old.close();
  await collectRetiredGenerations(getCodeGraphDir(root)); expect(fs.existsSync(path.dirname(oldLocation.databasePath))).toBe(false);
  expect(fs.existsSync(resolveGeneration(getCodeGraphDir(root)).databasePath)).toBe(true);
}, 60_000);
it('real watcher scoped burst can trigger its own first background rebuild', async () => {
  const graph = await fresh(130);
  let resolve!: () => void, reject!: (error: Error) => void;
  const complete = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  const timeout = setTimeout(() => reject(new Error('watch rebuild timeout')), 25_000);
  let changed = 0;
  try {
    expect(graph.watch({ debounceMs: 200, onSyncComplete: result => {
      changed += result.filesChanged;
      if (changed >= 130) resolve();
    }, onSyncError: reject })).toBe(true);
    await graph.waitUntilWatcherReady();
    change(130); await complete;
    expect(graph.isPortableStorage()).toBe(true);
    expect(graph.getDatabaseFilePath()).toBe(path.join(getCodeGraphDir(root), 'codegraph.db'));
    expect(fs.existsSync(path.join(getCodeGraphDir(root), 'CURRENT'))).toBe(false);
    expect(graph.getNodesByName('replaced_129').length).toBeGreaterThan(0);
    expect(graph.getNodesByName('initial_129')).toHaveLength(0);
    expect(fs.readFileSync(path.join(getCodeGraphDir(root), '.runtime', 'adaptive-sync.log'), 'utf8')).toContain('structural-large-change');
  } finally { clearTimeout(timeout); graph.unwatch(); }
}, 60_000);

it('legacy CURRENT rejected off-thread validation cleans the failed candidate only after workers exit and keeps old queries', async () => {
  const graph = await fresh(130, true);
  const initial = resolveGeneration(getCodeGraphDir(root));
  change(130);
  const controller = require('../dist/sync/rebuild-controller') as typeof import('../src/sync/rebuild-controller');
  const run = controller.runAdaptiveReadWorker;
  vi.spyOn(controller, 'runAdaptiveReadWorker').mockImplementation(async (job, options) => {
    const result = await run(job, options);
    return (job.type === 'validate' ? false : result) as any;
  });
  await expect(graph.sync()).rejects.toThrow(/Publication validation/);
  const dataDir = getCodeGraphDir(root);
  expect(resolveGeneration(dataDir).id).toBe(initial.id);
  expect(graph.searchNodes('initial_0').length).toBeGreaterThan(0);
  await collectRetiredGenerations(dataDir);
  expect(fs.readdirSync(path.join(dataDir, 'generations')).filter(name => name.startsWith('g-'))).toEqual([initial.id]);
}, 60_000);

it('keeps the active portable database when a config comment creates no index work', async () => {
  const original = await fresh();
  const databasePath = original.getDatabaseFilePath();
  original.close(); await original.whenIdle();
  const { DatabaseSync } = require('node:sqlite');
  const extension = new DatabaseSync(databasePath);
  try { extension.exec("CREATE TABLE business_data (value TEXT); INSERT INTO business_data VALUES ('keep-me')"); }
  finally { extension.close(); }
  const graph = CodeGraph.openSync(root); graphs.push(graph);
  fs.writeFileSync(path.join(root, '.gitignore'), '# changed configuration\n');
  const reasons: string[] = []; const result = await graph.sync({ onAdaptiveDecision: decision => reasons.push(decision.reason) });
  expect(result.adaptive).toBeUndefined();
  expect(reasons).toContain('no-content-changes');
  expect(graph.getDatabaseFilePath()).toBe(databasePath);
  const check = new DatabaseSync(databasePath, { readOnly: true });
  try { expect(check.prepare('SELECT value FROM business_data').get().value).toBe('keep-me'); }
  finally { check.close(); }
}, 30_000);
