/** Fresh native stores participate in cross-process generation lifetime from birth. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs'; import path from 'path'; import os from 'os';
import type { CodeGraph as Graph } from '../src';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { getCodeGraphDir } = require('../dist/directory') as typeof import('../src/directory');
const { resolveGeneration, collectRetiredGenerations } = require('../dist/sync/generation-store') as typeof import('../src/sync/generation-store');
const { readAdaptiveHistory } = require('../dist/sync/adaptive-plan') as typeof import('../src/sync/adaptive-plan');
let root: string; let argv: string[]; const graphs: Graph[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-managed-init-'));
  argv = process.execArgv; process.execArgv = ['--liftoff-only'];
  fs.writeFileSync(path.join(root, 'main.c'), 'int initial_symbol(void) { return 3; }\n');
});
afterEach(async () => {
  vi.restoreAllMocks(); for (const graph of graphs.splice(0)) graph.close();
  await collectRetiredGenerations(getCodeGraphDir(root));
  process.execArgv = argv; fs.rmSync(root, { recursive: true, force: true });
});
function manifest(): any { return JSON.parse(fs.readFileSync(path.join(getCodeGraphDir(root), 'CURRENT'), 'utf8')); }
it('initSync publishes storage-ready, not a complete index, and later indexes durably', async () => {
  const graph = CodeGraph.initSync(root); graphs.push(graph);
  expect(manifest()).toMatchObject({ complete: false, storageReady: true, purpose: 'initial-storage' });
  expect(fs.existsSync(path.join(getCodeGraphDir(root), 'codegraph.db'))).toBe(false);
  expect(graph.getFiles()).toEqual([]);
  expect((graph as any).queries.getMetadata('index_completeness')).not.toBe('complete');
  expect(readAdaptiveHistory(root).samples).toHaveLength(0);
  const db = (graph as any).db.getDb();
  const pragma = vi.spyOn(db, 'pragma');
  expect((await graph.indexAll()).success).toBe(true);
  expect(pragma.mock.calls.some(([sql]: any[]) => /journal_mode\s*=\s*MEMORY|synchronous\s*=\s*OFF/i.test(sql))).toBe(false);
  expect(graph.searchNodes('initial_symbol').length).toBeGreaterThan(0);
  expect(graph.getFiles().map(file => file.path)).toEqual(['main.c']);
}, 30_000);
it('async schema-only init is managed and remains unindexed', async () => {
  const graph = await CodeGraph.init(root, { index: false }); graphs.push(graph);
  expect(manifest().storageReady).toBe(true); expect(graph.getFiles()).toEqual([]);
  expect((graph as any).queries.getMetadata('index_completeness')).not.toBe('complete');
});
it('full init stays private throughout extraction and records a genuine full observation', async () => {
  let observed = false;
  const graph = await CodeGraph.init(root, { index: true, onProgress: () => {
    observed = true;
    expect(fs.existsSync(path.join(getCodeGraphDir(root), 'CURRENT'))).toBe(false);
    expect(() => CodeGraph.initSync(root)).toThrow(/locked/);
  } }); graphs.push(graph);
  expect(observed).toBe(true);
  expect((graph as any).queries.getMetadata('index_completeness')).toBe('complete');
  expect(readAdaptiveHistory(root).samples.some(sample => sample.kind === 'full' && sample.durationMs > 0)).toBe(true);
  expect(graph.getFiles().map(file => file.path)).toEqual(['main.c']);
}, 30_000);
it('failed initial extraction never publishes a half index or leaves a flat database', async () => {
  vi.spyOn(CodeGraph.prototype, 'indexAll').mockResolvedValue({ success: false, complete: false,
    errors: [{ severity: 'error', message: 'injected initialization failure' }] } as any);
  await expect(CodeGraph.init(root, { index: true })).rejects.toThrow('injected initialization failure');
  const dir = getCodeGraphDir(root); await collectRetiredGenerations(dir);
  expect(fs.existsSync(path.join(dir, 'CURRENT'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'codegraph.db'))).toBe(false);
  expect(fs.readdirSync(path.join(dir, 'generations'))).toEqual([]);
  expect(fs.existsSync(path.join(dir, 'codegraph.lock'))).toBe(false);
});
it('cancellation before publication leaves no current generation', async () => {
  const abort = new AbortController();
  vi.spyOn(CodeGraph.prototype, 'indexAll').mockImplementation(async () => {
    abort.abort(); return { success: true, complete: false, errors: [] } as any;
  });
  await expect(CodeGraph.init(root, { index: true, signal: abort.signal })).rejects.toThrow();
  await collectRetiredGenerations(getCodeGraphDir(root));
  expect(fs.existsSync(path.join(getCodeGraphDir(root), 'CURRENT'))).toBe(false);
});
it('retains the initial real SQLite generation for readers then automatically collects it', async () => {
  const graph = await CodeGraph.init(root, { index: true }); graphs.push(graph);
  const first = resolveGeneration(getCodeGraphDir(root)); expect(first.id).not.toBeNull();
  const reader = CodeGraph.openReadOnlySync(root); graphs.push(reader);
  fs.writeFileSync(path.join(root, '.gitignore'), '# force changed configuration\n');
  expect((await graph.sync()).adaptive?.strategy).toBe('rebuild');
  graph.close(); await collectRetiredGenerations(getCodeGraphDir(root));
  expect(fs.existsSync(first.databasePath)).toBe(true);
  expect(reader.searchNodes('initial_symbol').length).toBeGreaterThan(0);
  reader.close(); await collectRetiredGenerations(getCodeGraphDir(root));
  expect(fs.existsSync(path.dirname(first.databasePath))).toBe(false);
  expect(fs.existsSync(resolveGeneration(getCodeGraphDir(root)).databasePath)).toBe(true);
}, 30_000);
it('usable but incomplete initial indexing is not relabeled complete or used for calibration', async () => {
  vi.spyOn(CodeGraph.prototype, 'indexAll').mockImplementation(async function (this: Graph) {
    (this as any).queries.setMetadata('index_completeness', 'incomplete');
    return { success: true, complete: false, errors: [] } as any;
  });
  const graph = await CodeGraph.init(root, { index: true }); graphs.push(graph);
  expect(manifest()).toMatchObject({ complete: false, storageReady: true });
  expect((graph as any).queries.getMetadata('index_completeness')).toBe('incomplete');
  expect(readAdaptiveHistory(root).samples).toEqual([]);
});
it('initial storage validation failure keeps CURRENT absent and reclaims the closed candidate', async () => {
  const controller = require('../dist/sync/rebuild-controller') as typeof import('../src/sync/rebuild-controller');
  const run = controller.runAdaptiveReadWorker;
  vi.spyOn(controller, 'runAdaptiveReadWorker').mockImplementation(async (job, options) => {
    const result = await run(job, options); return (job.type === 'validate-initial' ? false : result) as any;
  });
  await expect(CodeGraph.init(root)).rejects.toThrow('Initial storage validation failed');
  const dir = getCodeGraphDir(root); await collectRetiredGenerations(dir);
  expect(fs.existsSync(path.join(dir, 'CURRENT'))).toBe(false);
  expect(fs.readdirSync(path.join(dir, 'generations'))).toEqual([]);
});

it('built CLI init creates managed storage and status/query use it without migration', () => {
  const cli = path.resolve(__dirname, '../dist/bin/codegraph.js');
  const invoke = (...args: string[]) => spawnSync(process.execPath, ['--liftoff-only', cli, ...args],
    { cwd: root, encoding: 'utf8', input: '', timeout: 30_000, env: { ...process.env, CI: '1', CODEGRAPH_NO_WATCH: '1' } });
  const init = invoke('init', root); expect(init.status, init.stderr + init.stdout).toBe(0);
  expect(manifest()).toMatchObject({ complete: false, storageReady: true });
  expect(fs.existsSync(path.join(getCodeGraphDir(root), 'codegraph.db'))).toBe(false);
  const status = invoke('status', root, '--json'); expect(status.status, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout).index.completeness).toBe('complete');
  const query = invoke('query', 'initial_symbol', '--path', root, '--json');
  expect(query.status, query.stderr).toBe(0); expect(query.stdout).toContain('initial_symbol');
}, 60_000);
it('a failing internal result observer cannot publish successful-looking initial storage', async () => {
  await expect(CodeGraph.init(root, { index: true, onIndexResult: () => { throw new Error('observer failed'); } }))
    .rejects.toThrow('observer failed');
  await collectRetiredGenerations(getCodeGraphDir(root));
  expect(fs.existsSync(path.join(getCodeGraphDir(root), 'CURRENT'))).toBe(false);
}, 30_000);
it.skipIf(process.platform === 'win32')('does not recursively forward writers when the project is opened through a directory alias', async () => {
  const alias = root + '-alias'; fs.symlinkSync(root, alias, 'dir');
  try {
    const graph = CodeGraph.initSync(alias); graphs.push(graph);
    expect((await graph.indexAll()).success).toBe(true);
    fs.writeFileSync(path.join(root, 'main.c'), 'int alias_updated_symbol(void) { return 1234; }\n');
    expect((await graph.sync({ adaptive: false })).complete).toBe(true);
    expect(graph.searchNodes('alias_updated_symbol').length).toBeGreaterThan(0);
  } finally { fs.unlinkSync(alias); }
}, 30_000);
