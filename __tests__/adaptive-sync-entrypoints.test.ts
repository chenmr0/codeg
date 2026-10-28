/** Built CLI and real OS watcher acceptance. Artificial history selects a
 * functional path only; it is not a benchmark or a production calibration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import type { CodeGraph as Graph } from '../src';
import type { AdaptiveCostHistory, AdaptiveCostSample } from '../src/sync/adaptive-plan';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { getCodeGraphDir } = require('../dist/directory') as typeof import('../src/directory');
const { adaptiveRuntimeKey, createAdaptivePlan, chooseAdaptiveStrategy } =
  require('../dist/sync/adaptive-plan') as typeof import('../src/sync/adaptive-plan');
const { resolveGeneration, GenerationWriterLock } =
  require('../dist/sync/generation-store') as typeof import('../src/sync/generation-store');
const cli = path.resolve(__dirname, '../dist/bin/codegraph.js');
let root: string;
let graph: Graph;
const readers: Graph[] = [];
let argv: string[];
let nodeOptions: string | undefined;
let noWatch: string | undefined;
beforeEach(async () => {
  argv = process.execArgv; process.execArgv = ['--liftoff-only'];
  nodeOptions = process.env.NODE_OPTIONS; delete process.env.NODE_OPTIONS;
  noWatch = process.env.CODEGRAPH_NO_WATCH; delete process.env.CODEGRAPH_NO_WATCH;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-adaptive-entry-'));
  fs.writeFileSync(path.join(root, 'main.cpp'), 'int entry_original_symbol() { return 1; }\n');
  graph = await CodeGraph.init(root, { index: true });
});
afterEach(() => {
  graph?.unwatch(); graph?.close();
  for (const reader of readers.splice(0)) reader.close();
  process.execArgv = argv;
  if (nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = nodeOptions;
  if (noWatch === undefined) delete process.env.CODEGRAPH_NO_WATCH; else process.env.CODEGRAPH_NO_WATCH = noWatch;
  fs.rmSync(root, { recursive: true, force: true });
});
async function prepareSyntheticRebuild(): Promise<void> {
  fs.writeFileSync(path.join(root, 'main.cpp'), 'int entry_rebuilt_symbol() { return 222; }\n');
  const plan = await createAdaptivePlan(root, graph.getFiles(), { runtimeKey: adaptiveRuntimeKey(root, graph.getBackend()) });
  const sample: AdaptiveCostSample = { kind: 'incremental', runtimeKey: plan.runtimeKey,
    configFingerprint: plan.snapshot.configFingerprint, totalFiles: plan.totalFiles, totalBytes: plan.totalBytes,
    totalNodes: plan.totalNodes, durationMs: 100_000, changedFiles: plan.changedFiles,
    affectedOldNodes: plan.affectedOldNodes, changedBytes: plan.changedBytes,
    addedFiles: plan.added.length, modifiedFiles: plan.modified.length, removedFiles: plan.removed.length,
    shape: plan.shape, recordedAt: Date.now() };
  const history: AdaptiveCostHistory = { version: 1,
    samples: [{ ...sample, kind: 'full', durationMs: 1_000 }, sample, { ...sample }, { ...sample }] };
  expect(chooseAdaptiveStrategy(plan, history).strategy).toBe('rebuild');
  fs.writeFileSync(path.join(getCodeGraphDir(root), 'adaptive-cost-history.json'), JSON.stringify(history));
}
function queryNames(reader: Graph, query: string): string[] { return reader.searchNodes(query).map(row => row.node.name); }

describe('adaptive sync production entry points', () => {
  it('built CLI sync publishes CURRENT and built CLI status/query read the new generation', async () => {
    const old = CodeGraph.openReadOnlySync(root); readers.push(old);
    await prepareSyntheticRebuild();
    graph.close();
    const invoke = (...args: string[]) => spawnSync(process.execPath, ['--liftoff-only', cli, ...args],
      { cwd: root, encoding: 'utf8', env: { ...process.env }, timeout: 30_000 });
    const sync = invoke('sync', root, '--quiet');
    expect(sync.error).toBeUndefined();
    expect(sync.status, sync.stderr + sync.stdout).toBe(0);
    expect(resolveGeneration(getCodeGraphDir(root)).id).not.toBeNull();
    const status = invoke('status', root, '--json');
    expect(status.status, status.stderr).toBe(0);
    const report = JSON.parse(status.stdout);
    expect(report.initialized).toBe(true);
    expect(report.index.completeness).toBe('complete');
    expect(report.fileCount).toBe(1);
    expect(report.pendingChanges).toEqual({ added: 0, modified: 0, removed: 0 });
    const query = invoke('query', 'entry_rebuilt_symbol', '--path', root, '--json');
    expect(query.status, query.stderr).toBe(0);
    expect(query.stdout).toContain('entry_rebuilt_symbol');
    expect(queryNames(old, 'entry_original_symbol')).toContain('entry_original_symbol');
  }, 60_000);

  it('real native watcher updates CURRENT after publication while the retired reader stays unchanged', async () => {
    const old = CodeGraph.openReadOnlySync(root); readers.push(old);
    await prepareSyntheticRebuild();
    expect((await graph.sync()).complete).toBe(true);
    const generation = resolveGeneration(getCodeGraphDir(root)).id;
    expect(generation).not.toBeNull();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveSync!: (value: { filesChanged: number; durationMs: number }) => void;
    let rejectSync!: (error: Error) => void;
    const completed = new Promise<{ filesChanged: number; durationMs: number }>((resolve, reject) => {
      resolveSync = resolve; rejectSync = reject;
      timer = setTimeout(() => reject(new Error('native watcher did not sync within 10 seconds')), 10_000);
    });
    try {
      expect(graph.watch({ debounceMs: 50, onSyncComplete: resolveSync, onSyncError: rejectSync })).toBe(true);
      await graph.waitUntilWatcherReady();
      // Actual fs.writeFile event, no synthetic watcher event injection.
      fs.writeFileSync(path.join(root, 'main.cpp'), 'int native_watcher_updated_symbol() { return 33333; }\n');
      const result = await completed;
      expect(result.filesChanged).toBeGreaterThan(0);
      expect(queryNames(graph, 'native_watcher_updated_symbol')).toContain('native_watcher_updated_symbol');
      expect(queryNames(old, 'entry_original_symbol')).toContain('entry_original_symbol');
      expect(queryNames(old, 'native_watcher_updated_symbol')).not.toContain('native_watcher_updated_symbol');
      expect(resolveGeneration(getCodeGraphDir(root)).id).toBe(generation);
      const lock = new GenerationWriterLock(getCodeGraphDir(root)); lock.acquire(); lock.release();
      const log = fs.readFileSync(path.join(getCodeGraphDir(root), 'adaptive-sync.log'), 'utf8');
      expect(log).toContain('scoped-watcher-sync');
    } finally { if (timer) clearTimeout(timer); graph.unwatch(); }
  }, 30_000);
});
