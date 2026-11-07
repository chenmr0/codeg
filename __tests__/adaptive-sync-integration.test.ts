/** Real child-process publication tests with explicit structural thresholds. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { CodeGraph as CodeGraphInstance } from '../src';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { getCodeGraphDir } = require('../dist/directory') as typeof import('../src/directory');
const { GenerationWriterLock, resolveGeneration, createGeneration, publishInitialGeneration, cleanupGenerationCandidate, drainGenerationCollections } =
  require('../dist/sync/generation-store') as typeof import('../src/sync/generation-store');

const { PortableCoordinator } = require('../dist/sync/portable/protocol') as typeof import('../src/sync/portable/protocol');
const { createDirectory } = require('../dist/directory') as typeof import('../src/directory');

let root: string;
let initialGeneration: string | null;
let graph: CodeGraphInstance;
let originalArgv: string[];
let originalNodeOptions: string | undefined;
const readers: CodeGraphInstance[] = [];

beforeEach(async context => {
  originalArgv = process.execArgv;
  originalNodeOptions = process.env.NODE_OPTIONS;
  // Test harness loaders are not child build runtime flags.
  process.execArgv = ['--liftoff-only'];
  delete process.env.NODE_OPTIONS;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-real-adaptive-'));
  fs.writeFileSync(path.join(root, 'main.cpp'), 'int original_symbol() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'other.cpp'), 'int untouched_symbol() { return 2; }\n');
  graph = context.task.name.startsWith('[legacy]')
    ? await legacyFixture(root) : await CodeGraph.init(root, { index: true });
  initialGeneration = storageIdentity();
  expect(graph.getBackend()).toBe('node-sqlite');
  expect(graph.getIndexCompleteness().status).toBe('complete');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const reader of readers.splice(0)) { await reader.whenIdle(); reader.close(); await reader.whenIdle(); }
  if (graph) { await graph.whenIdle(); graph.close(); await graph.whenIdle(); }
  await drainGenerationCollections();
  process.execArgv = originalArgv;
  if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = originalNodeOptions;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Explicit compatibility fixture for tests whose contract is CURRENT/retired
 * generations or the legacy parent-side validator. Default fixtures above use
 * the portable production initializer; no feature flag silently changes it. */
async function legacyFixture(project: string): Promise<CodeGraphInstance> {
  createDirectory(project);
  const data = getCodeGraphDir(project), lock = new GenerationWriterLock(data);
  lock.acquire(); const candidate = createGeneration(data, lock);
  let shadow: CodeGraphInstance | undefined;
  try {
    shadow = await CodeGraph.createShadow(project, candidate.databasePath);
    expect((await shadow.indexAll()).complete).toBe(true);
    shadow.close(); await shadow.whenIdle(); shadow = undefined;
    await publishInitialGeneration(data, candidate, { lock, validate: () => true });
  } finally {
    if (shadow) { shadow.close(); await shadow.whenIdle(); }
    cleanupGenerationCandidate(data, candidate); lock.release();
  }
  // Match legacy init's writable owner, not openSync's read-only generation facade.
  return (CodeGraph as any).openCurrent(project, false, false, data, true);
}
function storageIdentity(): string | null {
  if (!graph.isPortableStorage()) return resolveGeneration(getCodeGraphDir(root)).id;
  const stat = fs.statSync(graph.getDatabaseFilePath());
  return JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs]);
}
async function prepareRebuild(writer = graph, functionName = 'replacement_symbol') {
  fs.writeFileSync(path.join(root, 'main.cpp'), `int ${functionName}() { return 333; }\n`);
  if (writer.isPortableStorage()) {
    for (let i = 0; i < 127; i++) {
      fs.writeFileSync(path.join(root, `branch-${i}.c`), `int ${functionName}_${i}(void) { return ${i}; }\n`);
    }
    return;
  }
  fs.writeFileSync(path.join(root, '.codegraphrc.json'), JSON.stringify({
    sync: { adaptive: { rules: { fileScale: { minChangedFiles: 1 } } } },
  }));
}
function assertRootLocked(): void {
  if (graph.isPortableStorage()) {
    const coordinator = new PortableCoordinator(graph.getDataDirectory());
    expect(() => { const lease = coordinator.acquireWriter(); lease.release(); }).toThrow(/busy/i);
  } else {
    expect(() => { const lock = new GenerationWriterLock(getCodeGraphDir(root)); lock.acquire(); lock.release(); }).toThrow(/locked/);
  }
}
async function assertRootReleased(): Promise<void> {
  await graph.whenIdle();
  if (graph.isPortableStorage()) {
    const lease = new PortableCoordinator(graph.getDataDirectory()).acquireWriter(); lease.release();
  } else { const lock = new GenerationWriterLock(getCodeGraphDir(root)); lock.acquire(); lock.release(); }
}
function names(reader: CodeGraphInstance, query: string): string[] {
  return reader.searchNodes(query).map(result => result.node.name);
}

describe('adaptive sync real child lifecycle', () => {
  it('rescans normally after the negative-gate diagnostic callback changes source and ignores', async () => {
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
    expect(storageIdentity()).toBe(initialGeneration);
    await assertRootReleased();
  }, 30_000);

  it('[legacy] builds independently, keeps old readers, publishes new queries and forwards a stale writer', async () => {
    const oldPath = graph.getDatabaseFilePath();
    const oldReader = CodeGraph.openReadOnlySync(root); readers.push(oldReader);
    await prepareRebuild();
    let observedBuild = false;
    const decisions: string[] = [];
    const result = await graph.sync({ onAdaptiveDecision: decision => decisions.push(decision.strategy),
      onProgress: () => {
        observedBuild = true; assertRootLocked();
        expect(names(oldReader, 'original_symbol')).toContain('original_symbol');
        expect(storageIdentity()).toBe(initialGeneration);
      } });
    expect(result.complete).toBe(true);
    expect(observedBuild).toBe(true);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every(value => value === 'rebuild')).toBe(true);
    const current = resolveGeneration(getCodeGraphDir(root));
    expect(current.id).not.toBeNull();
    expect(current.databasePath).not.toBe(oldPath);
    expect(oldReader.getDatabaseFilePath()).toBe(oldPath);
    expect(names(graph, 'replacement_symbol')).toContain('replacement_symbol');
    expect(graph.getDatabaseFilePath()).toBe(current.databasePath);
    expect(names(graph, 'original_symbol')).not.toContain('original_symbol');
    expect(names(oldReader, 'original_symbol')).toContain('original_symbol');
    const latest = CodeGraph.openReadOnlySync(root); readers.push(latest);
    expect(names(latest, 'replacement_symbol')).toContain('replacement_symbol');
    expect(names(latest, 'original_symbol')).not.toContain('original_symbol');
    await assertRootReleased();

    // The same old CodeGraph object must write CURRENT, never its retired DB.
    fs.writeFileSync(path.join(root, 'main.cpp'), 'int forwarded_symbol_longer() { return 4444; }\n');
    const forwarded = await graph.sync({ adaptive: false });
    expect(forwarded.complete).toBe(true);
    const after = CodeGraph.openReadOnlySync(root); readers.push(after);
    expect(names(after, 'forwarded_symbol_longer')).toContain('forwarded_symbol_longer');
    expect(names(graph, 'forwarded_symbol_longer')).toContain('forwarded_symbol_longer');
    expect(names(oldReader, 'original_symbol')).toContain('original_symbol');
    expect(resolveGeneration(getCodeGraphDir(root)).id).toBe(current.id);
    await assertRootReleased();
  }, 60_000);

  it('[legacy] routes SDK clear to CURRENT under the root lock without touching a retired generation', async () => {
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
    await assertRootReleased();
  }, 60_000);

  it('[legacy] pins a legacy instance to its data root when a preferred index appears later', async () => {
    const project = path.join(root, 'pinned-project'); fs.mkdirSync(project);
    const source = path.join(project, 'main.cpp');
    fs.writeFileSync(source, 'int pinned_original_symbol() { return 1; }\n');
    const previousDirectory = process.env.CODEGRAPH_DIR;
    let legacy: CodeGraphInstance;
    let preferred: CodeGraphInstance;
    try {
      process.env.CODEGRAPH_DIR = '.codegraph';
      legacy = await legacyFixture(project); readers.push(legacy);
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
    } })).rejects.toThrow(/cancelled|aborted/i);
    expect(sawProgress).toBe(true);
    expect(storageIdentity()).toBe(initialGeneration);
    expect(names(graph, 'original_symbol')).toContain('original_symbol');
    await assertRootReleased();
  }, 60_000);

  it('keeps the old database after a real child run is failed by a progress callback', async () => {
    await prepareRebuild();
    await expect(graph.sync({ onProgress: () => {
      assertRootLocked(); throw new Error('injected progress-consumer failure');
    } })).rejects.toThrow('injected progress-consumer failure');
    expect(storageIdentity()).toBe(initialGeneration);
    expect(names(graph, 'original_symbol')).toContain('original_symbol');
    await assertRootReleased();
  }, 60_000);

  it.each(['[portable]', '[legacy]'])('%s publishes a usable candidate when source changes during construction', async () => {
    await prepareRebuild();
    let changed = false;
    const result = await graph.sync({ onProgress: () => {
      if (!changed) {
        assertRootLocked();
        changed = true;
        fs.writeFileSync(path.join(root, 'main.cpp'), 'int concurrently_edited_symbol() { return 55555; }\n');
      }
    } });
    expect(changed).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.adaptive?.strategy, result.adaptive?.reason).toBe('rebuild');
    expect(storageIdentity()).not.toBe(initialGeneration);
    expect(names(graph, 'concurrently_edited_symbol')).toContain('concurrently_edited_symbol');
    expect(names(graph, 'replacement_symbol')).not.toContain('replacement_symbol');
    expect(names(graph, 'original_symbol')).not.toContain('original_symbol');
    await assertRootReleased();
  }, 60_000);

  it('reports the published rebuild when another portable writer completes its catch-up first', async () => {
    await prepareRebuild();
    const publisher = require('../dist/sync/portable/publisher-client') as typeof import('../src/sync/portable/publisher-client');
    const publish = publisher.runPortableRebuild;
    vi.spyOn(publisher, 'runPortableRebuild').mockImplementationOnce(async (...args) => {
      const result = await publish(...args);
      const other = CodeGraph.openSync(root);
      try {
        expect(other.getPortableCatchup()).toBeTruthy();
        expect((await other.sync({ adaptive: false })).complete).toBe(true);
        expect(other.getPortableCatchup()).toBeNull();
      } finally { other.close(); await other.whenIdle(); }
      return result;
    });
    const result = await graph.sync();
    expect(result.adaptive?.strategy, result.adaptive?.reason).toBe('rebuild');
    expect(storageIdentity()).not.toBe(initialGeneration);
    await assertRootReleased();
  }, 60_000);

  it('[legacy] resumes published source reconciliation on the next scoped sync after cancellation', async () => {
    await prepareRebuild();
    const controller = new AbortController();
    await expect(graph.sync({ signal: controller.signal, onAdaptiveDecision: decision => {
      if (decision.reason.startsWith('rebuild-published:')) {
        fs.renameSync(path.join(root, 'other.cpp'), path.join(root, 'late.cpp'));
        fs.writeFileSync(path.join(root, 'late.cpp'), 'int renamed_after_publish() { return 8; }\n');
        controller.abort();
      }
    } })).rejects.toThrow(/aborted|cancel/i);
    const published = storageIdentity();
    expect(published).not.toBe(initialGeneration);
    expect(graph.getPortableCatchup()).toBeTruthy();
    graph.close(); await graph.whenIdle();
    graph = CodeGraph.openSync(root);
    const result = await graph.sync({ adaptive: false, paths: ['main.cpp'] });
    expect(result.complete).toBe(true);
    expect(storageIdentity()).toBe(published);
    expect(graph.getPortableCatchup()).toBeNull();
    expect(graph.getFiles().map(file => file.path).sort()).toEqual(['late.cpp', 'main.cpp']);
    expect(names(graph, 'renamed_after_publish')).toContain('renamed_after_publish');
    expect(names(graph, 'untouched_symbol')).not.toContain('untouched_symbol');
    await assertRootReleased();
  }, 60_000);

  it('[legacy] does not report a published generation as failed when a diagnostic observer throws', async () => {
    await prepareRebuild();
    const result = await graph.sync({ onAdaptiveDecision: decision => {
      if (decision.reason.startsWith('rebuild-published:')) throw new Error('diagnostic consumer failed after commit');
    } });
    expect(result.complete).toBe(true);
    expect(resolveGeneration(getCodeGraphDir(root)).id).not.toBeNull();
    await assertRootReleased();
  }, 60_000);

  it('[legacy] releases its root lock when CURRENT resolution fails before planning', async () => {
    fs.writeFileSync(path.join(getCodeGraphDir(root), 'CURRENT'), '{}');
    await expect(graph.sync()).rejects.toThrow(/manifest/);
    await assertRootReleased();
  });

  it('[legacy] rechecks cancellation after asynchronous final source validation', async () => {
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
    await expect(graph.sync({ signal: abort.signal })).rejects.toThrow(/Publication validation|cancelled/);
    expect(storageIdentity()).toBe(initialGeneration);
    await assertRootReleased();
  }, 60_000);

  it.each(['parent-runtime', 'parent-database', 'parent-schema'] as const)('[legacy] rejects %s changes while off-thread validation awaits', async mutation => {
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
      await expect(graph.sync()).rejects.toThrow(/Publication validation/);
      expect(storageIdentity()).toBe(initialGeneration);
      expect(names(graph, 'original_symbol')).toContain('original_symbol');
      await assertRootReleased();
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
    await assertRootReleased();
  }, 60_000);

  it('[legacy] closing a stale forwarding graph also cancels its active child', async () => {
    await prepareRebuild();
    expect((await graph.sync()).complete).toBe(true);
    const first = resolveGeneration(getCodeGraphDir(root));
    const latest = CodeGraph.openReadOnlySync(root); readers.push(latest);
    await prepareRebuild(latest, 'second_generation_symbol');
    let closed = false;
    await expect(graph.sync({ onProgress: () => {
      if (!closed) { closed = true; graph.close(); assertRootLocked(); }
    } })).rejects.toThrow(/cancelled|aborted/i);
    expect(closed).toBe(true);
    expect(resolveGeneration(getCodeGraphDir(root)).id).toBe(first.id);
    const reader = CodeGraph.openReadOnlySync(root); readers.push(reader);
    expect(names(reader, 'replacement_symbol')).toContain('replacement_symbol');
    await assertRootReleased();
  }, 60_000);

  it('explicitly aborting the owning graph waits for its child before close or unlock', async () => {
    await prepareRebuild();
    let closed = false;
    await expect(graph.sync({ onProgress: () => {
      if (!closed) { closed = true; graph.abortActiveWork(); assertRootLocked(); }
    } })).rejects.toThrow(/cancelled|aborted/i);
    expect(closed).toBe(true);
    expect(storageIdentity()).toBe(initialGeneration);
    const old = CodeGraph.openReadOnlySync(root); readers.push(old);
    expect(names(old, 'original_symbol')).toContain('original_symbol');
    await assertRootReleased();
  }, 60_000);
});
