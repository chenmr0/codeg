/** Real child-process publication tests. Injected history selects the branch;
 * invented timing observations are NOT performance evidence or calibration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { CodeGraph as CodeGraphInstance } from '../src';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { getCodeGraphDir } = require('../dist/directory') as typeof import('../src/directory');
import type { AdaptiveCostHistory, AdaptiveCostSample } from '../src/sync/adaptive-plan';
const { adaptiveRuntimeKey, createAdaptivePlan, chooseAdaptiveStrategy } =
  require('../dist/sync/adaptive-plan') as typeof import('../src/sync/adaptive-plan');
const { GenerationWriterLock, resolveGeneration } =
  require('../dist/sync/generation-store') as typeof import('../src/sync/generation-store');

let root: string;
let initialGeneration: string | null;
let graph: CodeGraphInstance;
let originalArgv: string[];
let originalNodeOptions: string | undefined;
const readers: CodeGraphInstance[] = [];

beforeEach(async () => {
  originalArgv = process.execArgv;
  originalNodeOptions = process.env.NODE_OPTIONS;
  // Test harness loaders are not child build runtime flags.
  process.execArgv = ['--liftoff-only'];
  delete process.env.NODE_OPTIONS;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-real-adaptive-'));
  fs.writeFileSync(path.join(root, 'main.cpp'), 'int original_symbol() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'other.cpp'), 'int untouched_symbol() { return 2; }\n');
  graph = await CodeGraph.init(root, { index: true });
  initialGeneration = resolveGeneration(getCodeGraphDir(root)).id;
  expect(graph.getBackend()).toBe('node-sqlite');
  expect(graph.getIndexCompleteness().status).toBe('complete');
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const reader of readers.splice(0)) reader.close();
  graph?.close();
  process.execArgv = originalArgv;
  if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = originalNodeOptions;
  fs.rmSync(root, { recursive: true, force: true });
});

async function prepareRebuild(writer = graph, functionName = 'replacement_symbol') {
  fs.writeFileSync(path.join(root, 'main.cpp'), `int ${functionName}() { return 333; }\n`);
  const plan = await createAdaptivePlan(root, writer.getFiles(), {
    runtimeKey: adaptiveRuntimeKey(root, writer.getBackend()),
  });
  const sample: AdaptiveCostSample = {
    kind: 'incremental', runtimeKey: plan.runtimeKey, configFingerprint: plan.snapshot.configFingerprint,
    totalFiles: plan.totalFiles, totalBytes: plan.totalBytes, totalNodes: plan.totalNodes,
    durationMs: 100_000, changedFiles: plan.changedFiles, affectedOldNodes: plan.affectedOldNodes,
    changedBytes: plan.changedBytes, addedFiles: plan.added.length, modifiedFiles: plan.modified.length,
    removedFiles: plan.removed.length, shape: plan.shape, recordedAt: Date.now(),
  };
  const history: AdaptiveCostHistory = { version: 1,
    samples: [{ ...sample, kind: 'full', durationMs: 1_000 }, sample, { ...sample }, { ...sample }],
  };
  expect(chooseAdaptiveStrategy(plan, history).strategy).toBe('rebuild');
  fs.writeFileSync(path.join(getCodeGraphDir(root), 'adaptive-cost-history.json'), JSON.stringify(history));
}
function assertRootLocked(): void {
  expect(() => new GenerationWriterLock(getCodeGraphDir(root)).acquire()).toThrow(/locked/);
}
function assertRootReleased(): void {
  const lock = new GenerationWriterLock(getCodeGraphDir(root)); lock.acquire(); lock.release();
}
function names(reader: CodeGraphInstance, query: string): string[] {
  return reader.searchNodes(query).map(result => result.node.name);
}

describe('adaptive sync real child lifecycle', () => {
  it('rescans normally after the negative-gate diagnostic callback changes source and ignores', async () => {
    const baseline = await createAdaptivePlan(root, graph.getFiles(), { runtimeKey: adaptiveRuntimeKey(root, graph.getBackend()) });
    const sample: AdaptiveCostSample = { kind: 'incremental', runtimeKey: baseline.runtimeKey,
      configFingerprint: baseline.snapshot.configFingerprint, totalFiles: baseline.totalFiles,
      totalBytes: baseline.totalBytes, totalNodes: baseline.totalNodes, durationMs: 100_000,
      changedFiles: 100, affectedOldNodes: 100, changedBytes: 1000,
      addedFiles: 0, modifiedFiles: 100, removedFiles: 0, shape: 'modified-only', recordedAt: Date.now() };
    const history: AdaptiveCostHistory = { version: 1, samples: [
      { ...sample, kind: 'full', durationMs: 1_000 }, sample, { ...sample }, { ...sample }] };
    fs.writeFileSync(path.join(getCodeGraphDir(root), 'adaptive-cost-history.json'), JSON.stringify(history));
    const reasons: string[] = [];
    const result = await graph.sync({ onAdaptiveDecision: decision => {
      reasons.push(decision.reason);
      if (decision.reason === 'no-content-changes') {
        fs.writeFileSync(path.join(root, 'callback.cpp'), 'int callback_created_symbol() { return 4; }\n');
        fs.writeFileSync(path.join(root, '.gitignore'), 'main.cpp\n');
      }
    } });
    expect(reasons).toContain('no-content-changes');
    expect(result.complete).toBe(true);
    expect(graph.getFiles().map(file => file.path).sort()).toEqual(['callback.cpp', 'other.cpp']);
    expect(names(graph, 'callback_created_symbol')).toContain('callback_created_symbol');
    expect(names(graph, 'original_symbol')).not.toContain('original_symbol');
    expect(resolveGeneration(getCodeGraphDir(root)).id).toBe(initialGeneration);
    assertRootReleased();
  }, 30_000);

  it('builds independently, keeps old readers, publishes new queries and forwards a stale writer', async () => {
    const oldPath = graph.getDatabaseFilePath();
    const oldReader = CodeGraph.openReadOnlySync(root); readers.push(oldReader);
    await prepareRebuild();
    let observedBuild = false;
    const decisions: string[] = [];
    const result = await graph.sync({ onAdaptiveDecision: decision => decisions.push(decision.strategy),
      onProgress: () => {
        observedBuild = true; assertRootLocked();
        expect(names(oldReader, 'original_symbol')).toContain('original_symbol');
        expect(resolveGeneration(getCodeGraphDir(root)).id).toBe(initialGeneration);
      } });
    expect(result.complete).toBe(true);
    expect(observedBuild).toBe(true);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every(value => value === 'rebuild')).toBe(true);
    const current = resolveGeneration(getCodeGraphDir(root));
    expect(current.id).not.toBeNull();
    expect(current.databasePath).not.toBe(oldPath);
    expect(graph.getDatabaseFilePath()).toBe(oldPath);
    expect(names(graph, 'replacement_symbol')).toContain('replacement_symbol');
    expect(names(graph, 'original_symbol')).not.toContain('original_symbol');
    expect(names(oldReader, 'original_symbol')).toContain('original_symbol');
    const latest = CodeGraph.openReadOnlySync(root); readers.push(latest);
    expect(names(latest, 'replacement_symbol')).toContain('replacement_symbol');
    expect(names(latest, 'original_symbol')).not.toContain('original_symbol');
    assertRootReleased();

    // The same old CodeGraph object must write CURRENT, never its retired DB.
    fs.writeFileSync(path.join(root, 'main.cpp'), 'int forwarded_symbol_longer() { return 4444; }\n');
    const forwarded = await graph.sync({ adaptive: false });
    expect(forwarded.complete).toBe(true);
    const after = CodeGraph.openReadOnlySync(root); readers.push(after);
    expect(names(after, 'forwarded_symbol_longer')).toContain('forwarded_symbol_longer');
    expect(names(graph, 'forwarded_symbol_longer')).toContain('forwarded_symbol_longer');
    expect(names(oldReader, 'original_symbol')).toContain('original_symbol');
    expect(resolveGeneration(getCodeGraphDir(root)).id).toBe(current.id);
    assertRootReleased();
  }, 60_000);

  it('routes SDK clear to CURRENT under the root lock without touching a retired generation', async () => {
    const oldReader = CodeGraph.openReadOnlySync(root); readers.push(oldReader);
    const oldPath = oldReader.getDatabaseFilePath();
    await prepareRebuild();
    expect((await graph.sync()).complete).toBe(true);
    const published = resolveGeneration(getCodeGraphDir(root));
    expect(published.databasePath).not.toBe(oldPath);
    expect(graph.getFiles()).toHaveLength(2);
    const concurrentWriter = new GenerationWriterLock(getCodeGraphDir(root));
    concurrentWriter.acquire();
    try {
      expect(() => graph.clear()).toThrow(/locked/);
      expect(graph.getFiles()).toHaveLength(2);
      expect(oldReader.getFiles()).toHaveLength(2);
    } finally { concurrentWriter.release(); }
    graph.clear();
    expect(graph.getFiles()).toHaveLength(0);
    const activeReader = CodeGraph.openReadOnlySync(root); readers.push(activeReader);
    expect(activeReader.getFiles()).toHaveLength(0);
    expect(oldReader.getFiles()).toHaveLength(2);
    expect(names(oldReader, 'original_symbol')).toContain('original_symbol');
    expect(resolveGeneration(getCodeGraphDir(root)).id).toBe(published.id);
    assertRootReleased();
  }, 60_000);

  it('pins a legacy instance to its data root when a preferred index appears later', async () => {
    const project = path.join(root, 'pinned-project'); fs.mkdirSync(project);
    const source = path.join(project, 'main.cpp');
    fs.writeFileSync(source, 'int pinned_original_symbol() { return 1; }\n');
    const previousDirectory = process.env.CODEGRAPH_DIR;
    let legacy: CodeGraphInstance;
    let preferred: CodeGraphInstance;
    try {
      process.env.CODEGRAPH_DIR = '.codegraph';
      legacy = await CodeGraph.init(project, { index: true }); readers.push(legacy);
      process.env.CODEGRAPH_DIR = '.codegraph-wx';
      preferred = await CodeGraph.init(project, { index: true }); readers.push(preferred);
    } finally {
      if (previousDirectory === undefined) delete process.env.CODEGRAPH_DIR;
      else process.env.CODEGRAPH_DIR = previousDirectory;
    }
    const legacyRoot = path.join(project, '.codegraph');
    const preferredRoot = path.join(project, '.codegraph-wx');
    expect(legacy!.getDataDirectory()).toBe(legacyRoot);
    expect(preferred!.getDataDirectory()).toBe(preferredRoot);
    const preferredLock = new GenerationWriterLock(preferredRoot);
    preferredLock.acquire();
    try {
      fs.writeFileSync(source, 'int pinned_updated_symbol_longer() { return 222; }\n');
      let observedLegacyWrite = false;
      const decisions: string[] = [];
      const result = await legacy!.sync({ onAdaptiveDecision: decision => decisions.push(decision.reason), onProgress: () => {
        observedLegacyWrite = true;
        expect(() => new GenerationWriterLock(legacyRoot).acquire()).toThrow(/locked/);
      } });
      expect(result.complete).toBe(true);
      expect(observedLegacyWrite).toBe(true);
      expect(decisions).toContain('data-directory-selection-changed');
      expect(names(legacy!, 'pinned_updated_symbol_longer')).toContain('pinned_updated_symbol_longer');
      expect(names(preferred!, 'pinned_original_symbol')).toContain('pinned_original_symbol');
      expect(names(preferred!, 'pinned_updated_symbol_longer')).not.toContain('pinned_updated_symbol_longer');
      expect(legacy!.getDatabaseFilePath()).toBe(resolveGeneration(legacyRoot).databasePath);
      const legacyLock = new GenerationWriterLock(legacyRoot); legacyLock.acquire(); legacyLock.release();
      preferredLock.assertHeld();
    } finally { preferredLock.release(); }
    expect(process.env.CODEGRAPH_DIR).toBe(previousDirectory);
  }, 60_000);

  it('waits for child cancellation before releasing the root lock and never publishes', async () => {
    await prepareRebuild();
    const abort = new AbortController();
    let sawProgress = false;
    await expect(graph.sync({ signal: abort.signal, onProgress: () => {
      sawProgress = true; assertRootLocked(); abort.abort(); assertRootLocked();
    } })).rejects.toThrow(/cancelled/);
    expect(sawProgress).toBe(true);
    expect(resolveGeneration(getCodeGraphDir(root)).id).toBe(initialGeneration);
    expect(names(graph, 'original_symbol')).toContain('original_symbol');
    assertRootReleased();
  }, 60_000);

  it('keeps the old database after a real child run is failed by a progress callback', async () => {
    await prepareRebuild();
    await expect(graph.sync({ onProgress: () => {
      assertRootLocked(); throw new Error('injected progress-consumer failure');
    } })).rejects.toThrow('injected progress-consumer failure');
    expect(resolveGeneration(getCodeGraphDir(root)).id).toBe(initialGeneration);
    expect(names(graph, 'original_symbol')).toContain('original_symbol');
    assertRootReleased();
  }, 60_000);

  it('does not publish if the source changes during the child build', async () => {
    await prepareRebuild();
    let changed = false;
    await expect(graph.sync({ onProgress: () => {
      assertRootLocked();
      if (!changed) { changed = true; fs.writeFileSync(path.join(root, 'main.cpp'), 'int concurrently_edited_symbol() { return 55555; }\n'); }
    } })).rejects.toThrow(/validation failed|Source changed/);
    expect(changed).toBe(true);
    expect(resolveGeneration(getCodeGraphDir(root)).id).toBe(initialGeneration);
    expect(names(graph, 'original_symbol')).toContain('original_symbol');
    assertRootReleased();
  }, 60_000);

  it('does not report a published generation as failed when a diagnostic observer throws', async () => {
    await prepareRebuild();
    const result = await graph.sync({ onAdaptiveDecision: decision => {
      if (decision.reason.startsWith('rebuild-published:')) throw new Error('diagnostic consumer failed after commit');
    } });
    expect(result.complete).toBe(true);
    expect(resolveGeneration(getCodeGraphDir(root)).id).not.toBeNull();
    assertRootReleased();
  }, 60_000);

  it('releases its root lock when CURRENT resolution fails before planning', async () => {
    fs.writeFileSync(path.join(getCodeGraphDir(root), 'CURRENT'), '{}');
    await expect(graph.sync()).rejects.toThrow(/manifest/);
    assertRootReleased();
  });

  it('rechecks cancellation after asynchronous final source validation', async () => {
    await prepareRebuild();
    const controller = require('../dist/sync/rebuild-controller') as typeof import('../src/sync/rebuild-controller');
    const run = controller.runAdaptiveReadWorker;
    const abort = new AbortController();
    vi.spyOn(controller, 'runAdaptiveReadWorker').mockImplementation(async (job, options) => {
      const result = await run(job, options);
      // Deterministic abort after the actual off-thread validation has exited.
      if (job.type === 'validate') abort.abort();
      return result as any;
    });
    await expect(graph.sync({ signal: abort.signal })).rejects.toThrow(/Source changed|cancelled/);
    expect(resolveGeneration(getCodeGraphDir(root)).id).toBe(initialGeneration);
    assertRootReleased();
  }, 60_000);

  it.each(['parent-runtime', 'parent-database', 'parent-schema'] as const)('rejects %s changes while off-thread validation awaits', async mutation => {
    await prepareRebuild();
    const controller = require('../dist/sync/rebuild-controller') as typeof import('../src/sync/rebuild-controller');
    const run = controller.runAdaptiveReadWorker;
    const previous = process.env.CODEGRAPH_PARSE_TIMEOUT_MS;
    vi.spyOn(controller, 'runAdaptiveReadWorker').mockImplementation(async (job, options) => {
      const result = await run(job, options);
      if (job.type === 'validate') {
        if (mutation === 'parent-runtime') process.env.CODEGRAPH_PARSE_TIMEOUT_MS = '12345';
        else if (mutation === 'parent-schema') (graph as any).db.getDb().exec('CREATE TABLE custom_while_validating (value TEXT)');
        else (graph as any).queries.setMetadata('custom:changed-during-validation', 'keep');
      }
      return result as any;
    });
    try {
      await expect(graph.sync()).rejects.toThrow(/Source changed/);
      expect(resolveGeneration(getCodeGraphDir(root)).id).toBe(initialGeneration);
      expect(names(graph, 'original_symbol')).toContain('original_symbol');
      assertRootReleased();
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_PARSE_TIMEOUT_MS;
      else process.env.CODEGRAPH_PARSE_TIMEOUT_MS = previous;
    }
  }, 60_000);

  it('SDK queries do not revert to an older generation during a forwarded rebuild', async () => {
    await prepareRebuild();
    expect((await graph.sync()).complete).toBe(true);
    const latest = CodeGraph.openReadOnlySync(root); readers.push(latest);
    await prepareRebuild(latest, 'second_generation_symbol');
    let observed = false;
    const result = await graph.sync({ onProgress: () => {
      observed = true;
      expect(names(graph, 'replacement_symbol')).toContain('replacement_symbol');
      expect(names(graph, 'original_symbol')).not.toContain('original_symbol');
    } });
    expect(observed).toBe(true);
    expect(result.complete).toBe(true);
    expect(names(graph, 'second_generation_symbol')).toContain('second_generation_symbol');
    assertRootReleased();
  }, 60_000);

  it('closing a stale forwarding graph also cancels its active child', async () => {
    await prepareRebuild();
    expect((await graph.sync()).complete).toBe(true);
    const first = resolveGeneration(getCodeGraphDir(root));
    const latest = CodeGraph.openReadOnlySync(root); readers.push(latest);
    await prepareRebuild(latest, 'second_generation_symbol');
    let closed = false;
    await expect(graph.sync({ onProgress: () => {
      if (!closed) { closed = true; graph.close(); assertRootLocked(); }
    } })).rejects.toThrow(/cancelled/);
    expect(closed).toBe(true);
    expect(resolveGeneration(getCodeGraphDir(root)).id).toBe(first.id);
    const reader = CodeGraph.openReadOnlySync(root); readers.push(reader);
    expect(names(reader, 'replacement_symbol')).toContain('replacement_symbol');
    assertRootReleased();
  }, 60_000);

  it('closing the owning graph cancels an active child without early unlock', async () => {
    await prepareRebuild();
    let closed = false;
    await expect(graph.sync({ onProgress: () => {
      if (!closed) { closed = true; graph.close(); assertRootLocked(); }
    } })).rejects.toThrow(/cancelled/);
    expect(closed).toBe(true);
    expect(resolveGeneration(getCodeGraphDir(root)).id).toBe(initialGeneration);
    const old = CodeGraph.openReadOnlySync(root); readers.push(old);
    expect(names(old, 'original_symbol')).toContain('original_symbol');
    assertRootReleased();
  }, 60_000);
});
