import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import type { QueryBuilder } from '../src/db/queries';
import type { UnresolvedReference } from '../src/types';

const REWIRE_PENDING = 'index_rewire_synthesis_pending';
const SYNTHESIS_PENDING = 'index_synthesis_pending';
const SYNTHESIS_PROOF = 'index_synthesis_completed_version';
const LEGACY_UNVERIFIED = 'index_legacy_synthesis_unverified';
const VERIFICATION_STARTED = 'index_synthesis_verification_started';
const roots: string[] = [];
const graphs: CodeGraph[] = [];
const modes = ['modern', 'legacy'] as const;
type Mode = typeof modes[number];

beforeEach(() => vi.stubEnv('CODEGRAPH_NO_APPEND_DELTA', '1'));
afterEach(() => {
  vi.restoreAllMocks();
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function internals(graph: CodeGraph) {
  const internal = graph as any;
  return { internal, q: internal.queries as QueryBuilder, raw: internal.db.getDb() };
}
async function fixture(mode: Mode = 'modern') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rewire-synthesis-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'provider.c'), 'int durable_target(void) { return 1; }\n');
  fs.writeFileSync(path.join(root, 'caller.c'), 'int caller(void) { return durable_target(); }\n');
  const graph = CodeGraph.initSync(root);
  graphs.push(graph);
  expect((await graph.indexAll()).complete).toBe(true);
  const { internal, q, raw } = internals(graph);
  expect(q.getIncomingCrossFileEdges('provider.c').filter(edge => edge.edgeKind === 'calls')).toHaveLength(1);
  expect(q.getMetadata(REWIRE_PENDING)).toBeNull();
  if (mode === 'legacy') {
    // Model known pre-proof provenance; this is not a historical database build.
    q.applyMetadataChanges({
      [SYNTHESIS_PROOF]: null, [VERIFICATION_STARTED]: null, [LEGACY_UNVERIFIED]: null,
      indexed_with_version: '1.1.1', indexed_with_extraction_version: '24',
      index_completeness: 'complete', index_diagnostics: '[]',
      'resolution:cpp-macro-evidence-v1': null,
      'resolution:cpp-macro-evidence-clean-v1': null,
    });
    expect(graph.getIndexCompleteness()).toMatchObject({ status: 'unknown', legacyUnverified: true });
  }
  return { root, graph, internal, q, raw };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function renameTarget(f: Fixture) {
  fs.writeFileSync(path.join(f.root, 'provider.c'), 'int renamed_target(void) { return 123; }\n');
}
function reopen(f: Fixture) {
  f.graph.close();
  graphs.splice(graphs.indexOf(f.graph), 1);
  const graph = CodeGraph.openSync(f.root);
  graphs.push(graph);
  return { root: f.root, graph, ...internals(graph) };
}
function reference(f: Fixture): UnresolvedReference {
  return {
    fromNodeId: f.graph.getNodesByName('caller')[0]!.id,
    referenceName: 'durable_target', referenceKind: 'calls',
    line: 1, column: 26, filePath: 'caller.c', language: 'c',
  };
}
async function replaceAndDrain(f: Fixture) {
  renameTarget(f);
  const result = await f.internal.orchestrator.indexFile('provider.c', { force: true });
  expect(result.stored).toBe(true);
  expect(result.resurrectedReferenceSourceFiles).toEqual(['caller.c']);
  expect(f.q.getMetadata(REWIRE_PENDING)).not.toBeNull();
  f.internal.resolver.clearCaches();
  await f.internal.resolver.resolveFilesAndPersist(['caller.c']);
  expect(f.graph.getPendingReferenceCount()).toBe(0);
  expect(f.q.getMetadata(REWIRE_PENDING)).not.toBeNull();
}

describe.each(modes)('durable rewire synthesis state: %s', mode => {
  it('retries full synthesis after scoped refs drain, failure, and reopen', async () => {
    let f = await fixture(mode);
    const originalCaller = f.graph.getFile('caller.c');
    const caller = f.graph.getNodesByName('caller')[0]!;
    // A stale, independently derived edge proves recovery actually replays
    // synthesis instead of merely erasing the durable marker.
    f.raw.prepare(`INSERT INTO edges (source,target,kind,line,col,metadata,provenance)
      VALUES (?,?,'calls',999,0,?,'heuristic')`).run(caller.id, caller.id,
      JSON.stringify({ synthesizedBy: 'event-emitter' }));
    renameTarget(f);
    let drained = false;
    const originalScoped = f.internal.resolver.resolveFilesAndPersist.bind(f.internal.resolver);
    vi.spyOn(f.internal.resolver, 'resolveFilesAndPersist').mockImplementation(async (...args: any[]) => {
      const result = await originalScoped(...args);
      if (args[0].includes('caller.c')) {
        drained = true;
        expect(f.graph.getPendingReferenceCount()).toBe(0);
        expect(f.q.getMetadata(REWIRE_PENDING)).not.toBeNull();
      }
      return result;
    });
    const full = vi.spyOn(f.graph, 'resolveReferencesBatched');
    vi.spyOn(f.internal.resolver, 'resolveAndPersistBatched').mockImplementationOnce(async () => {
      expect(drained).toBe(true);
      expect(f.graph.getPendingReferenceCount()).toBe(0);
      expect(f.q.getMetadata(REWIRE_PENDING)).not.toBeNull();
      throw new Error('injected full synthesis failure after scoped drain');
    });

    await expect(f.graph.sync({ paths: ['provider.c'] }))
      .rejects.toThrow('injected full synthesis failure after scoped drain');

    expect(full).toHaveBeenCalledTimes(1);
    expect(drained).toBe(true);
    expect(f.graph.getPendingReferenceCount()).toBe(0);
    expect(f.q.getMetadata(REWIRE_PENDING)).not.toBeNull();
    expect(f.graph.getIndexCompleteness().status).toBe('incomplete');
    expect(f.graph.getFile('caller.c')).toEqual(originalCaller);
    vi.restoreAllMocks();
    f = reopen(f);
    expect(f.q.getMetadata(REWIRE_PENDING)).not.toBeNull();
    expect(f.graph.getPendingReferenceCount()).toBe(0);
    expect(f.graph.getIndexCompleteness().status).toBe('incomplete');
    const retry = vi.spyOn(f.graph, 'resolveReferencesBatched');

    const recovered = await f.graph.sync({ paths: ['provider.c'] });

    expect(recovered).toMatchObject({ complete: true, filesAdded: 0, filesModified: 0 });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(f.q.getMetadata(REWIRE_PENDING)).toBeNull();
    expect(f.q.getMetadata(SYNTHESIS_PENDING)).toBeNull();
    expect(f.q.getMetadata(SYNTHESIS_PROOF)).toBe('1');
    expect(f.graph.getIndexCompleteness()).toEqual({ status: 'complete', diagnostics: [] });
    expect(f.raw.prepare("SELECT id FROM edges WHERE line = 999 AND json_extract(metadata, '$.synthesizedBy') = 'event-emitter'").all()).toEqual([]);
    expect(f.graph.getFile('caller.c')).toEqual(originalCaller);
    expect(f.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    retry.mockClear();
    await f.graph.sync();
    expect(retry).not.toHaveBeenCalled();
    expect(f.q.getMetadata(REWIRE_PENDING)).toBeNull();
  });

  it.each(['synthesis_pass_failed', 'synthesis_skipped_memory'] as const)(
    'keeps dirty when a full pass returns %s', async code => {
      const f = await fixture(mode);
      await replaceAndDrain(f);
      const originalFull = f.internal.resolver.resolveAndPersistBatched.bind(f.internal.resolver);
      const fault = vi.spyOn(f.internal.resolver, 'resolveAndPersistBatched').mockImplementationOnce(async (...args: any[]) => {
        const result = await originalFull(...args);
        return { ...result, diagnostics: [...(result.diagnostics ?? []), {
          code, severity: 'error', message: 'injected incomplete synthesis pass',
        }] };
      });

      const incomplete = await f.graph.sync({ paths: ['provider.c'] });

      expect(incomplete.complete).toBe(false);
      expect(incomplete.errors).toContainEqual(expect.objectContaining({ code }));
      expect(f.graph.getPendingReferenceCount()).toBe(0);
      expect(f.q.getMetadata(REWIRE_PENDING)).not.toBeNull();
      expect(f.graph.getIndexCompleteness().status).toBe('incomplete');
      fault.mockRestore();
      expect((await f.graph.sync()).complete).toBe(true);
      expect(f.q.getMetadata(REWIRE_PENDING)).toBeNull();
    },
  );

  it('conservatively runs full synthesis when provider and caller both change in one batch', async () => {
    const f = await fixture(mode);
    const oldCaller = f.graph.getFile('caller.c')!;
    renameTarget(f);
    fs.writeFileSync(path.join(f.root, 'caller.c'), 'int caller(void) { return renamed_target(); }\n');
    const originalFull = f.graph.resolveReferencesBatched.bind(f.graph);
    const full = vi.spyOn(f.graph, 'resolveReferencesBatched').mockImplementation(async (...args) => {
      // The first store resurrects the old call. Replacing the caller later in
      // the same ordered batch drains it, but stage 1 deliberately stays dirty.
      expect(f.q.getMetadata(REWIRE_PENDING)).not.toBeNull();
      expect(f.graph.getPendingReferenceCount()).toBe(0);
      expect(f.raw.prepare(`SELECT t.name FROM edges e JOIN nodes s ON s.id = e.source
        JOIN nodes t ON t.id = e.target WHERE s.name = 'caller' AND e.kind = 'calls'`).all())
        .toEqual([{ name: 'renamed_target' }]);
      return originalFull(...args);
    });

    const result = await f.graph.sync({ paths: ['provider.c', 'caller.c'] });

    expect(result).toMatchObject({ complete: true, filesModified: 2 });
    expect(result.changedFilePaths).toEqual(['provider.c', 'caller.c']);
    expect(result.resurrectedReferenceSourceFiles).toEqual(['caller.c']);
    expect(full).toHaveBeenCalledTimes(1);
    expect(f.graph.getFile('caller.c')!.contentHash).not.toBe(oldCaller.contentHash);
    expect(f.graph.getNodesByName('durable_target')).toEqual([]);
    expect(f.raw.prepare("SELECT id FROM unresolved_refs WHERE reference_name = 'durable_target'").all()).toEqual([]);
    expect(f.q.getMetadata(REWIRE_PENDING)).toBeNull();
    expect(f.graph.getIndexCompleteness()).toEqual({ status: 'complete', diagnostics: [] });
    expect(f.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('keeps dirty after successful scoped synthesis and clears only after successful full synthesis', async () => {
    const f = await fixture(mode);
    await replaceAndDrain(f);
    f.internal.beginSynthesis();
    f.internal.finishSynthesis([], false);
    expect(f.q.getMetadata(REWIRE_PENDING)).not.toBeNull();
    expect(f.graph.getIndexCompleteness().status).toBe('incomplete');

    await f.graph.resolveReferencesBatched();

    expect(f.q.getMetadata(REWIRE_PENDING)).toBeNull();
    expect(f.graph.getIndexCompleteness()).toEqual({ status: 'complete', diagnostics: [] });
  });

  it.each(['unknown', 'incomplete'] as const)('does not promote independent raw %s coverage to complete', async status => {
    const f = await fixture(mode);
    f.q.applyMetadataChanges({ index_completeness: status, index_diagnostics: '[]' });
    await replaceAndDrain(f);
    const full = vi.spyOn(f.graph, 'resolveReferencesBatched');

    await f.graph.sync({ paths: ['provider.c'] });

    expect(full).toHaveBeenCalledTimes(1);
    expect(f.q.getMetadata(REWIRE_PENDING)).toBeNull();
    expect(f.q.getMetadata('index_completeness')).toBe(status);
    expect(f.graph.getIndexCompleteness()).toEqual({ status, diagnostics: [] });
    expect(f.q.getMetadata(SYNTHESIS_PROOF)).toBe('1');
  });

  it('does not create a new dirty marker or invoke full synthesis for unchanged indexes', async () => {
    let f = await fixture(mode);
    const beforeFiles = f.q.getAllFiles();
    const full = vi.spyOn(f.graph, 'resolveReferencesBatched');
    await f.graph.sync();
    await f.graph.sync();
    expect(full).not.toHaveBeenCalled();
    expect(f.q.getMetadata(REWIRE_PENDING)).toBeNull();
    expect(f.q.getMetadata(SYNTHESIS_PENDING)).toBeNull();
    expect(f.q.getAllFiles()).toEqual(beforeFiles);
    if (mode === 'legacy') {
      expect(f.q.getMetadata(SYNTHESIS_PROOF)).toBeNull();
      expect(f.q.getMetadata(VERIFICATION_STARTED)).toBeNull();
      expect(f.graph.getIndexCompleteness()).toMatchObject({ status: 'unknown', legacyUnverified: true });
    }
    vi.restoreAllMocks();
    f = reopen(f);
    const reopenedFull = vi.spyOn(f.graph, 'resolveReferencesBatched');
    await f.graph.sync();
    expect(reopenedFull).not.toHaveBeenCalled();
    expect(f.q.getMetadata(REWIRE_PENDING)).toBeNull();
    expect(f.q.getMetadata(SYNTHESIS_PENDING)).toBeNull();
  });
});

describe('rewired reference and dirty-marker atomicity', () => {
  it('does not mark a clean graph dirty for an empty reference batch', async () => {
    const f = await fixture();
    f.q.insertRewiredReferences([]);
    expect(f.q.getMetadata(REWIRE_PENDING)).toBeNull();
    expect(f.graph.getPendingReferenceCount()).toBe(0);
  });

  it('deduplicates identical pending facts within a batch and across replay', async () => {
    const f = await fixture();
    const ref = reference(f);
    f.q.insertRewiredReferences([ref, { ...ref }]);
    expect(f.graph.getPendingReferenceCount()).toBe(1);
    f.q.insertRewiredReferences([{ ...ref }, ref]);
    expect(f.graph.getPendingReferenceCount()).toBe(1);
    expect(f.q.getMetadata(REWIRE_PENDING)).not.toBeNull();
  });

  it('retains an old failed fact while admitting one fresh pending replay', async () => {
    const f = await fixture();
    const ref = reference(f);
    f.q.insertRewiredReferences([ref]);
    f.raw.prepare("UPDATE unresolved_refs SET status = 'failed' WHERE reference_name = 'durable_target'").run();

    f.q.insertRewiredReferences([ref, { ...ref }]);

    expect(f.raw.prepare("SELECT status FROM unresolved_refs WHERE reference_name = 'durable_target' ORDER BY id").all())
      .toEqual([{ status: 'failed' }, { status: 'pending' }]);
    expect(f.q.getMetadata(REWIRE_PENDING)).not.toBeNull();
  });

  it('keeps distinct source, target, kind, position, candidates, file, and language facts', async () => {
    const f = await fixture();
    const ref = reference(f);
    const facts: UnresolvedReference[] = [
      ref,
      { ...ref, fromNodeId: f.graph.getNodesByName('durable_target')[0]!.id },
      { ...ref, referenceName: 'different_target' },
      { ...ref, referenceKind: 'references' },
      { ...ref, line: ref.line + 1 },
      { ...ref, column: ref.column + 1 },
      { ...ref, candidates: ['candidate-a'] },
      { ...ref, candidates: [] },
      { ...ref, filePath: 'provider.c' },
      { ...ref, language: 'cpp' },
    ];

    f.q.insertRewiredReferences([...facts, ...facts]);

    expect(f.raw.prepare(`SELECT from_node_id, reference_name, reference_kind, line, col,
      candidates, file_path, language FROM unresolved_refs ORDER BY id`).all()).toEqual(
      facts.map(fact => ({
        from_node_id: fact.fromNodeId, reference_name: fact.referenceName,
        reference_kind: fact.referenceKind, line: fact.line, col: fact.column,
        candidates: fact.candidates ? JSON.stringify(fact.candidates) : null,
        file_path: fact.filePath, language: fact.language,
      })),
    );
    expect(f.graph.getPendingReferenceCount()).toBe(facts.length);
  });

  it.each(['marker', 'references'] as const)('rolls back both writes when inserting %s fails', async failure => {
    const f = await fixture();
    const refsBefore = f.raw.prepare('SELECT * FROM unresolved_refs ORDER BY id').all();
    if (failure === 'marker') {
      f.raw.exec(`CREATE TRIGGER fail_rewire_marker BEFORE INSERT ON project_metadata
        WHEN NEW.key = '${REWIRE_PENDING}' BEGIN
          SELECT RAISE(ABORT, 'injected rewire marker write failure');
        END`);
    } else {
      f.raw.exec(`CREATE TRIGGER fail_rewire_refs BEFORE INSERT ON unresolved_refs BEGIN
        SELECT RAISE(ABORT, 'injected rewired reference write failure');
      END`);
    }

    expect(() => f.q.insertRewiredReferences([reference(f)])).toThrow('injected');

    expect(f.raw.prepare('SELECT * FROM unresolved_refs ORDER BY id').all()).toEqual(refsBefore);
    expect(f.q.getMetadata(REWIRE_PENDING)).toBeNull();
    expect(f.graph.getIndexCompleteness()).toEqual({ status: 'complete', diagnostics: [] });
    expect(f.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

it.each(['', 'corrupt'])('treats marker value %j as dirty despite modern completion proof', async value => {
  let f = await fixture();
  expect(f.q.getMetadata(SYNTHESIS_PROOF)).toBe('1');
  f.q.setMetadata(REWIRE_PENDING, value);
  expect(f.graph.getPendingReferenceCount()).toBe(0);
  expect(f.graph.getIndexCompleteness().status).toBe('incomplete');
  f = reopen(f);
  expect(f.q.getMetadata(REWIRE_PENDING)).toBe(value);
  expect(f.graph.getIndexCompleteness().status).toBe('incomplete');
  const full = vi.spyOn(f.graph, 'resolveReferencesBatched');

  const recovered = await f.graph.sync({ paths: ['provider.c'] });

  expect(recovered).toMatchObject({ complete: true, filesModified: 0 });
  expect(full).toHaveBeenCalledTimes(1);
  expect(f.q.getMetadata(REWIRE_PENDING)).toBeNull();
  expect(f.graph.getIndexCompleteness()).toEqual({ status: 'complete', diagnostics: [] });
});
