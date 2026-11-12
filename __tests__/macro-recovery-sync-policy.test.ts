import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import CodeGraph, { SyncIncompleteError } from '../src';
import { QueryBuilder } from '../src/db/queries';
import { DatabaseConnection } from '../src/db';
import { getCodeGraphDir } from '../src/directory';
import { PortableCoordinator, type PortableLease } from '../src/sync/portable/protocol';
import { DECLARATION_MACRO_RECOVERY_SKIPPED_CODE } from '../src/extraction/diagnostics';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';
import * as treeSitter from '../src/extraction/tree-sitter';
import * as planning from '../src/sync/rebuild-controller';
import * as publisher from '../src/sync/portable/publisher-client';
import { SEMANTIC_CONFIG_KEY, SEMANTIC_REINDEX_PENDING } from '../src/sync/index-policy';
import type { AdaptiveDecision, AdaptivePlan } from '../src/sync/adaptive-plan';
import type { ExtractionError } from '../src/types';

let root: string, graph: CodeGraph, leases: PortableLease[];
const internal = () => graph as any;
const queries = (): QueryBuilder => internal().queries;
const recovery: ExtractionError = {
  severity: 'warning', code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
  filePath: 'recovery.cpp', message: 'Base AST stored; declaration-macro recovery timed out.',
};
const thresholds = { minChangedFiles: 1, minChangedFraction: 0.01, minWorkFraction: 0.01 };

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-macro-retry-policy-'));
  fs.writeFileSync(path.join(root, 'healthy.c'), 'int healthy(void) { return 1; }\n');
  fs.writeFileSync(path.join(root, 'recovery.cpp'), [
    '#define DECLARE_RECORD(Name) struct Name { int field; };',
    'DECLARE_RECORD(RecoveredRecord)',
    'int ordinary() { return 2; }',
  ].join('\n'));
  graph = CodeGraph.initSync(root); graph.close(); await graph.whenIdle();
  const coordinator = new PortableCoordinator(getCodeGraphDir(root));
  leases = [coordinator.acquireWriter(), coordinator.acquireReader()];
  graph = CodeGraph.openPortableRaw(root, coordinator.active, false);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  graph?.close(); await graph?.whenIdle();
  for (const lease of leases ?? []) lease.release();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Preserve actual extraction/resolution and only inject the worker fallback's
 * persisted file record and result, without a real timeout or a huge fixture. */
async function baseOnlyIndex(filePaths = ['recovery.cpp']) {
  const orchestrator = internal().orchestrator;
  const original = orchestrator.indexAll.bind(orchestrator);
  const injection = vi.spyOn(orchestrator, 'indexAll').mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    for (const filePath of filePaths) {
      const diagnostic = { ...recovery, filePath };
      queries().upsertFile({ ...queries().getFileByPath(filePath)!, errors: [diagnostic] });
      result.errors.push(diagnostic);
    }
    return result;
  });
  try { expect(await graph.indexAll()).toMatchObject({ success: true, complete: false, filesErrored: 0 }); }
  finally { injection.mockRestore(); }
}

async function reopenRaw() {
  graph.close(); await graph.whenIdle();
  graph = CodeGraph.openPortableRaw(root, new PortableCoordinator(getCodeGraphDir(root)).active, false);
}
async function openFacade() {
  graph.close(); await graph.whenIdle();
  for (const lease of leases.splice(0)) lease.release();
  graph = CodeGraph.openSync(root);
}

it('persists applied policy separately from coverage and retries only the failed file across reopen', async () => {
  await baseOnlyIndex();
  expect(graph.isIndexStale()).toBe(false);
  expect(queries().getMetadata('indexed_with_extraction_version')).toBe(String(EXTRACTION_VERSION));
  expect(queries().getMetadata(SEMANTIC_CONFIG_KEY)).not.toBeNull();
  expect(queries().getMetadata(SEMANTIC_REINDEX_PENDING)).toBeNull();
  const healthy = queries().getFileByPath('healthy.c');
  await reopenRaw();
  expect(graph.getIndexCompleteness()).toEqual({ status: 'incomplete', diagnostics: [recovery] });

  const extract = treeSitter.extractFromSource;
  const parse = vi.spyOn(treeSitter, 'extractFromSource').mockImplementation((file, ...args) => {
    if (file === 'recovery.cpp') throw new Error('repeated macro recovery failure');
    return extract(file, ...args);
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    parse.mockClear();
    await expect(graph.sync({ adaptive: false })).rejects.toBeInstanceOf(SyncIncompleteError);
    expect(parse.mock.calls.map(([file]) => file)).toEqual(['recovery.cpp']);
    expect(queries().getFileByPath('healthy.c')).toEqual(healthy);
    expect(queries().getFileByPath('recovery.cpp')!.errors).toContainEqual(recovery);
    expect(queries().getMetadata(SEMANTIC_REINDEX_PENDING)).toBeNull();
    expect(graph.getIndexCompleteness().status).toBe('incomplete');
    await reopenRaw();
  }
  parse.mockRestore();
  expect(await graph.sync({ adaptive: false })).toMatchObject({
    complete: true, filesModified: 1, changedFilePaths: ['recovery.cpp'],
  });
  expect(queries().getFileByPath('healthy.c')).toEqual(healthy);
  expect(queries().getFileByPath('recovery.cpp')!.errors ?? []).toEqual([]);
  expect(graph.getIndexCompleteness()).toEqual({ status: 'complete', diagnostics: [] });
  expect(await graph.sync({ adaptive: false })).toMatchObject({ complete: true, filesModified: 0 });
});

it('does not hide an omitted recovery file during a scoped sync', async () => {
  await baseOnlyIndex();
  const parse = vi.spyOn(treeSitter, 'extractFromSource');
  expect(await graph.sync({ adaptive: false, paths: ['healthy.c'] })).toMatchObject({
    complete: false, filesModified: 0,
  });
  expect(parse).not.toHaveBeenCalled();
  expect(graph.getIndexCompleteness().diagnostics).toContainEqual(recovery);
  expect(queries().getFileByPath('recovery.cpp')!.errors).toContainEqual(recovery);
});

it('does not retry already recovered files when another macro recovery keeps failing', async () => {
  fs.writeFileSync(path.join(root, 'still-broken.cpp'), 'int still_broken() { return 3; }\n');
  await baseOnlyIndex(['recovery.cpp', 'still-broken.cpp']);
  const extract = treeSitter.extractFromSource;
  const parse = vi.spyOn(treeSitter, 'extractFromSource').mockImplementation((file, ...args) => {
    if (file === 'still-broken.cpp') throw new Error('macro recovery still failing');
    return extract(file, ...args);
  });
  await expect(graph.sync({ adaptive: false })).rejects.toBeInstanceOf(SyncIncompleteError);
  expect(parse.mock.calls.map(([file]) => file).sort()).toEqual(['recovery.cpp', 'still-broken.cpp']);
  expect(queries().getFileByPath('recovery.cpp')!.errors ?? []).toEqual([]);
  await reopenRaw();
  parse.mockClear();
  await expect(graph.sync({ adaptive: false })).rejects.toBeInstanceOf(SyncIncompleteError);
  expect(parse.mock.calls.map(([file]) => file)).toEqual(['still-broken.cpp']);
  expect(graph.getIndexCompleteness().status).toBe('incomplete');
  parse.mockRestore();
  expect(await graph.sync({ adaptive: false })).toMatchObject({ complete: true, filesModified: 1,
    changedFilePaths: ['still-broken.cpp'] });
  expect(graph.getIndexCompleteness()).toEqual({ status: 'complete', diagnostics: [] });
});

it('does not include unchanged recovery files as global work in the real adaptive planner', async () => {
  await baseOnlyIndex();
  const evaluation = await planning.runAdaptiveReadWorker<{ plan: AdaptivePlan; decision: AdaptiveDecision }>({
    type: 'evaluate', root, databasePath: graph.getDatabaseFilePath(), portable: true,
    eligibility: { upgradeRequired: graph.isIndexStale(), fallback: thresholds },
  });
  expect(evaluation.plan.modified).toEqual([]);
  expect(evaluation.plan.changedFiles).toBe(0);
  expect(evaluation.decision).toMatchObject({ strategy: 'incremental', reason: 'no-content-changes' });
  await openFacade();
  const rebuild = vi.spyOn(publisher, 'runPortableRebuild');
  expect(await graph.sync({ adaptiveFallback: thresholds })).toMatchObject({ complete: true, filesModified: 1 });
  expect(rebuild).not.toHaveBeenCalled();
});

it.each(['extractor', 'semantic'] as const)('still refreshes every file after a genuine %s change', async change => {
  await baseOnlyIndex();
  if (change === 'extractor') queries().setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION - 1));
  else fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":"."}}');
  const parse = vi.spyOn(treeSitter, 'extractFromSource');
  expect(await graph.sync({ adaptive: false, paths: ['recovery.cpp'] })).toMatchObject({ complete: true, filesModified: 2 });
  expect(parse.mock.calls.map(([file]) => file).sort()).toEqual(['healthy.c', 'recovery.cpp']);
  expect(queries().getMetadata(SEMANTIC_REINDEX_PENDING)).toBeNull();
});

it.each(['extractor', 'semantic'] as const)('retires an applied %s upgrade despite a remaining macro fallback', async change => {
  await graph.indexAll();
  if (change === 'extractor') queries().setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION - 1));
  else fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":"."}}');
  await baseOnlyIndex();
  expect(graph.isIndexStale()).toBe(false);
  expect(queries().getMetadata(SEMANTIC_REINDEX_PENDING)).toBeNull();
  expect(await graph.sync({ adaptive: false })).toMatchObject({ complete: true, filesModified: 1 });
});

it('preserves global retry evidence when configuration drifts during a base-only index', async () => {
  await graph.indexAll();
  const previous = queries().getMetadata(SEMANTIC_CONFIG_KEY);
  const orchestrator = internal().orchestrator;
  const original = orchestrator.indexAll.bind(orchestrator);
  vi.spyOn(orchestrator, 'indexAll').mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    queries().upsertFile({ ...queries().getFileByPath('recovery.cpp')!, errors: [recovery] });
    result.errors.push(recovery);
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":"later"}}');
    return result;
  });
  expect((await graph.indexAll()).complete).toBe(false);
  expect(queries().getMetadata(SEMANTIC_CONFIG_KEY)).toBe(previous);
  expect(queries().getMetadata(SEMANTIC_REINDEX_PENDING)).not.toBeNull();
  expect(await graph.sync({ adaptive: false })).toMatchObject({ complete: true, filesModified: 2 });
});

it.each(['abort', 'whole-file-failure'] as const)('does not stamp a globally incomplete refresh after %s', async failure => {
  await graph.indexAll();
  const oldSemantic = queries().getMetadata(SEMANTIC_CONFIG_KEY);
  queries().setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION - 1));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":"changed"}}');
  const controller = new AbortController();
  const orchestrator = internal().orchestrator;
  const original = orchestrator.indexAll.bind(orchestrator);
  vi.spyOn(orchestrator, 'indexAll').mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    queries().upsertFile({ ...queries().getFileByPath('recovery.cpp')!, errors: [recovery] });
    result.errors.push(recovery);
    if (failure === 'abort') controller.abort();
    else result.filesErrored = 1;
    return result;
  });
  expect((await graph.indexAll({ signal: controller.signal })).complete).toBe(false);
  expect(graph.isIndexStale()).toBe(true);
  expect(queries().getMetadata(SEMANTIC_CONFIG_KEY)).toBe(oldSemantic);
  expect(queries().getMetadata(SEMANTIC_REINDEX_PENDING)).not.toBeNull();
  // A new full index must still replace healthy same-content files. The
  // aggregate full-index failure diagnostic is not a file-local retry proof.
  expect(await graph.indexAll()).toMatchObject({ complete: true, filesIndexed: 2 });
  expect(queries().getMetadata(SEMANTIC_REINDEX_PENDING)).toBeNull();
});

it.each(['synthesis_skipped_memory', 'framework_post_extract_failed'] as const)(
  'keeps %s retry evidence independent of macro recovery', async code => {
    const resolver = internal().resolver;
    const original = resolver.resolveAndPersistBatched.bind(resolver);
    vi.spyOn(resolver, 'resolveAndPersistBatched').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      return { ...result, diagnostics: [...(result.diagnostics ?? []), {
        code, severity: 'error', message: 'Injected incomplete derived work.',
      }] };
    });
    await baseOnlyIndex();
    expect(graph.getIndexCompleteness().diagnostics).toContainEqual(expect.objectContaining({ code }));
    if (code === 'synthesis_skipped_memory') {
      expect(graph.isIndexStale()).toBe(false);
      expect(queries().getMetadata(SEMANTIC_REINDEX_PENDING)).toBeNull();
      expect(queries().getMetadata('index_synthesis_pending')).not.toBeNull();
      expect(await graph.sync({ adaptive: false })).toMatchObject({ complete: true, filesModified: 1 });
      expect(queries().getMetadata('index_synthesis_pending')).toBeNull();
    } else {
      expect(graph.isIndexStale()).toBe(true);
      expect(queries().getMetadata(SEMANTIC_CONFIG_KEY)).toBeNull();
      expect(queries().getMetadata(SEMANTIC_REINDEX_PENDING)).not.toBeNull();
      expect(await graph.indexAll()).toMatchObject({ complete: true, filesIndexed: 2 });
    }
  },
);

it.each([false, true])('does not fabricate catch-up after a failed private candidate (already published=%s)', async published => {
  await graph.indexAll();
  await openFacade();
  fs.writeFileSync(path.join(root, 'healthy.c'), 'int changed(void) { return 300; }\n');
  const rebuild = vi.spyOn(publisher, 'runPortableRebuild').mockImplementationOnce(async () => {
    if (published) {
      // Simulate the durable publication marker surviving a late child error.
      const db = DatabaseConnection.open(graph.getDatabaseFilePath());
      try { new QueryBuilder(db.getDb()).setMetadata('portable:source-catchup-v1', 'published-before-error'); }
      finally { db.close(); }
    }
    throw new Error('candidate failed');
  });
  const planner = vi.spyOn(planning, 'runAdaptiveReadWorker');
  const result = await graph.sync({ adaptiveFallback: thresholds });
  expect(rebuild).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ complete: true, filesModified: 1,
    adaptive: { strategy: 'incremental', reason: expect.stringContaining('rebuild-fallback') } });
  expect(planner.mock.calls.some(([job]) => job.type === 'evaluate' && job.fullHash)).toBe(published);
  expect(graph.getPortableCatchup()).toBeNull();
  expect(graph.getNodesByName('changed')).toHaveLength(1);
});
