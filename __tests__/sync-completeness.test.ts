import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph, { SyncIncompleteError } from '../src/index';
import type { QueryBuilder } from '../src/db/queries';
import * as treeSitter from '../src/extraction/tree-sitter';

const pressureState = vi.hoisted(() => ({ afterAdmissions: null as number | null, calls: 0 }));
vi.mock('v8', async importOriginal => {
  const original = await importOriginal<typeof import('v8')>();
  return { ...original, getHeapStatistics: () => {
    const stats = original.getHeapStatistics();
    if (pressureState.afterAdmissions === null) return stats;
    return { ...stats, heap_size_limit: pressureState.calls++ < pressureState.afterAdmissions ? 16 * 1024 ** 3 : 1 };
  } };
});

const PENDING = 'index_synthesis_pending';
const VERSION = 'index_synthesis_completed_version';
let directory: string;
let cg: CodeGraph | undefined;
const queries = () => (cg as unknown as { queries: QueryBuilder }).queries;
const internal = () => cg as any;
const raw = () => internal().db.getDb();
const graph = () => raw().prepare(`SELECT source,target,kind,line,col,metadata,provenance
  FROM edges ORDER BY source,target,kind,line,col,metadata,provenance`).all();
const seedOrphan = () => {
  const caller = cg!.getNodesByName('caller')[0]!;
  raw().prepare(`INSERT INTO unresolved_refs
    (from_node_id,reference_name,reference_kind,line,col,file_path,language,status,name_tail)
    VALUES (?, 'missing', 'calls', 99, 0, 'caller.c', 'c', 'pending', 'missing')`).run(caller.id);
};
async function setup() {
  fs.writeFileSync(path.join(directory, 'api.h'), 'int target(int value);\n');
  fs.writeFileSync(path.join(directory, 'api.c'), '#include "api.h"\nint target(int value) { return value + 1; }\n');
  fs.writeFileSync(path.join(directory, 'caller.c'), '#include "api.h"\nint caller(void) { return target(3); }\n');
  cg = CodeGraph.initSync(directory);
  const result = await cg.indexAll();
  expect(result.complete).toBe(true);
  expect(cg.getIndexCompleteness()).toEqual({ status: 'complete', diagnostics: [] });
}
function memoryPressure(afterAdmissions = 0) {
  pressureState.afterAdmissions = afterAdmissions;
  pressureState.calls = 0;
  return { mockRestore: () => { pressureState.afterAdmissions = null; } };
}

beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-completeness-')); });
afterEach(() => {
  pressureState.afterAdmissions = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cg?.close(); cg = undefined;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('sync synthesis completeness and recovery', () => {
  it.each([
    ['skip', 0, 'synthesis_skipped_memory'],
    ['early stop', 1, 'synthesis_stopped_memory'],
  ] as const)('persists a real memory %s through reopen and retries without file changes', async (_name, admitted, code) => {
    await setup();
    const expected = graph();
    // Remove a derived edge to prove the retry performs real work.
    raw().prepare("DELETE FROM edges WHERE json_extract(metadata, '$.synthesizedBy') = 'c-decl-def'").run();
    seedOrphan();
    const pressure = memoryPressure(admitted);
    const result = await cg!.sync();
    expect(result.complete).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code }));
    expect(queries().getMetadata(PENDING)).toBe('complete');
    expect(cg!.getPendingReferenceCount()).toBe(0);
    cg!.close(); cg = await CodeGraph.open(directory);
    expect(cg.getIndexCompleteness()).toEqual({ status: 'incomplete', diagnostics: [expect.objectContaining({ code })] });
    const again = await cg.sync();
    expect(again.filesModified).toBe(0);
    expect(again.complete).toBe(false);
    expect(queries().getMetadata(PENDING)).not.toBeNull();
    pressure.mockRestore();
    const reindex = vi.spyOn(internal().orchestrator, 'indexAll');
    const recovered = await cg.sync();
    expect(recovered).toMatchObject({ complete: true, filesModified: 0, filesAdded: 0 });
    expect(reindex).not.toHaveBeenCalled();
    expect(queries().getMetadata(PENDING)).toBeNull();
    expect(cg.getIndexCompleteness()).toEqual({ status: 'complete', diagnostics: [] });
    expect(graph()).toEqual(expected);
    const full = vi.spyOn(cg, 'resolveReferencesBatched');
    expect((await cg.sync()).complete).toBe(true);
    expect(full).not.toHaveBeenCalled();
  });

  it.each(['pass', 'outer'] as const)('persists a %s synthesis exception and clears it only after successful retry', async kind => {
    await setup(); seedOrphan();
    const fault = kind === 'pass'
      ? vi.spyOn(queries(), 'iterateNodesByKind').mockImplementationOnce(() => { throw new Error('injected pass failure'); })
      : vi.spyOn(queries(), 'beginSynthesisEdgeStaging').mockImplementationOnce(() => { throw new Error('injected outer failure'); });
    const result = await cg!.sync();
    expect(result.complete).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: kind === 'pass' ? 'synthesis_pass_failed' : 'synthesis_failed' }));
    expect(cg!.getIndexCompleteness().status).toBe('incomplete');
    fault.mockRestore();
    expect((await cg!.sync()).complete).toBe(true);
    expect(queries().getMetadata(PENDING)).toBeNull();
  });

  it('keeps scoped failures usable while preserving changed-file retry journals', async () => {
    await setup();
    fs.appendFileSync(path.join(directory, 'api.c'), '\n/* retry me */\n');
    vi.spyOn(internal().resolver, 'synthesizeIncrementalCCpp').mockRejectedValueOnce(new Error('scoped failure'));
    const result = await cg!.sync({ paths: ['api.c'] });
    expect(result).toMatchObject({ complete: false, filesModified: 1 });
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'synthesis_incremental_failed' }));
    expect(queries().getMetadataByPrefix('sync-retry:pending:')).not.toHaveLength(0);
    cg!.close(); cg = await CodeGraph.open(directory);
    expect((await cg.sync()).complete).toBe(true);
    expect(queries().getMetadataByPrefix('sync-retry:pending:')).toHaveLength(0);
    expect(queries().getMetadata(PENDING)).toBeNull();
  });

  it.each([null, 'corrupt', '0'])('repairs an unverified legacy completion version %s without re-extracting', async version => {
    await setup();
    const expected = graph();
    queries().applyMetadataChanges({ [VERSION]: version });
    raw().prepare("DELETE FROM edges WHERE json_extract(metadata, '$.synthesizedBy') = 'c-decl-def'").run();
    expect(cg!.getIndexCompleteness()).toEqual({ status: 'incomplete', diagnostics: [expect.objectContaining({ code: 'synthesis_unverified' })] });
    cg!.close(); cg = await CodeGraph.open(directory);
    const reindex = vi.spyOn(internal().orchestrator, 'indexAll');
    const parse = vi.spyOn(treeSitter, 'extractFromSource');
    const store = vi.spyOn(internal().orchestrator, 'storeExtractionResult');
    const beforeFiles = queries().getAllFiles();
    const recovered = await cg.sync();
    expect(recovered).toMatchObject({ complete: true, filesModified: 0, filesAdded: 0 });
    expect(reindex).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(queries().getAllFiles()).toEqual(beforeFiles);
    expect(graph()).toEqual(expected);
    expect(queries().getMetadata(VERSION)).toBe('1');
  });

  it('retains a write-ahead marker after an interrupted resolver and recovers on reopen', async () => {
    await setup(); seedOrphan();
    vi.spyOn(internal().resolver, 'resolveAndPersistBatched').mockImplementationOnce(async () => {
      expect(queries().getMetadata(PENDING)).not.toBeNull();
      expect(cg!.getIndexCompleteness().status).toBe('incomplete');
      throw new Error('interrupted resolver');
    });
    await expect(cg!.sync()).rejects.toThrow('interrupted resolver');
    cg!.close(); cg = await CodeGraph.open(directory);
    expect(cg.getIndexCompleteness().status).toBe('incomplete');
    expect((await cg.sync()).complete).toBe(true);
  });

  it.each(['complete', 'corrupt', ''])('recovers a simulated kill marker %s even if stale metadata still claims complete', async marker => {
    await setup();
    queries().applyMetadataChanges({ [PENDING]: marker, index_completeness: 'complete', index_diagnostics: '[]' });
    expect(cg!.getIndexCompleteness().status).toBe('incomplete');
    expect((await cg!.sync()).complete).toBe(true);
    expect(queries().getMetadata(PENDING)).toBeNull();
  });

  it('does not clear independent framework diagnostics when synthesis is repaired', async () => {
    await setup();
    const unrelated = { code: 'framework_post_extract_failed', severity: 'error', message: 'framework coverage missing' };
    queries().applyMetadataChanges({ index_completeness: 'incomplete', [PENDING]: 'incomplete',
      index_diagnostics: JSON.stringify([unrelated, { code: 'synthesis_failed', severity: 'error', message: 'synthesis missing' }]) });
    expect((await cg!.sync()).complete).toBe(false);
    expect(cg!.getIndexCompleteness()).toEqual({ status: 'incomplete', diagnostics: [unrelated] });
    expect(queries().getMetadata(PENDING)).toBeNull();
    const full = vi.spyOn(cg!, 'resolveReferencesBatched');
    expect((await cg!.sync()).complete).toBe(false);
    expect(full).not.toHaveBeenCalled();
  });

  it('keeps a skipped initial index usable and retries only synthesis in sync', async () => {
    fs.writeFileSync(path.join(directory, 'api.c'), 'int api(void) { return 1; }\n');
    cg = CodeGraph.initSync(directory);
    const pressure = memoryPressure();
    const index = await cg.indexAll();
    expect(index).toMatchObject({ success: true, complete: false, filesIndexed: 1 });
    expect(cg.isIndexStale()).toBe(false);
    expect(queries().getMetadata('language_scope_pending')).toBeNull();
    pressure.mockRestore();
    const reindex = vi.spyOn(internal().orchestrator, 'indexAll');
    const result = await cg.sync();
    expect(result).toMatchObject({ complete: true, filesModified: 0 });
    expect(reindex).not.toHaveBeenCalled();
    expect(cg.getIndexCompleteness().status).toBe('complete');
  });

  it('plain index retries skipped synthesis even when every file hash is unchanged', async () => {
    await setup(); seedOrphan();
    const pressure = memoryPressure();
    expect((await cg!.sync()).complete).toBe(false);
    expect((await cg!.indexAll()).complete).toBe(false);
    pressure.mockRestore();
    expect(await cg!.indexAll()).toMatchObject({ complete: true });
    expect(cg!.getIndexCompleteness().status).toBe('complete');
  });

  it('keeps healthy scoped sync complete without invoking full synthesis', async () => {
    await setup();
    fs.appendFileSync(path.join(directory, 'api.c'), '\n/* normal scoped change */\n');
    const full = vi.spyOn(cg!, 'resolveReferencesBatched');
    expect(await cg!.sync({ paths: ['api.c'] })).toMatchObject({ complete: true, filesModified: 1 });
    expect(full).not.toHaveBeenCalled();
    expect(cg!.getIndexCompleteness()).toEqual({ status: 'complete', diagnostics: [] });
  });

  it('recovers an exception at the synthesis progress boundary without reparsing', async () => {
    await setup(); seedOrphan();
    await expect(cg!.sync({ onProgress: progress => {
      if (progress.phase === 'synthesizing') throw new Error('cancel at synthesis boundary');
    } })).rejects.toThrow('cancel at synthesis boundary');
    expect(cg!.getIndexCompleteness().status).toBe('incomplete');
    cg!.close(); cg = await CodeGraph.open(directory);
    const parse = vi.spyOn(treeSitter, 'extractFromSource');
    expect((await cg.sync()).complete).toBe(true);
    expect(parse).not.toHaveBeenCalled();
  });

  it.each(['[null]', '[{"code":1,"message":"bad","severity":"error"}]', '{}', 'invalid json'])(
    'keeps corrupt diagnostics %s visible and never throws on a no-op sync', async value => {
      await setup();
      queries().setMetadata('index_diagnostics', value);
      cg!.close(); cg = await CodeGraph.open(directory);
      expect(cg.getIndexCompleteness()).toEqual({ status: 'incomplete', diagnostics: [
        expect.objectContaining({ code: 'index_diagnostics_invalid' }),
      ] });
      expect((await cg.sync()).complete).toBe(false);
      expect((await cg.indexAll()).complete).toBe(true);
      expect(cg.getIndexCompleteness()).toEqual({ status: 'complete', diagnostics: [] });
    },
  );

  it('does not certify a newly failed file when pending synthesis succeeds', async () => {
    await setup();
    queries().applyMetadataChanges({ [PENDING]: 'complete' });
    fs.writeFileSync(path.join(directory, 'broken.c'), 'int later(void) { return 4; }\n');
    const extract = treeSitter.extractFromSource;
    const failure = vi.spyOn(treeSitter, 'extractFromSource').mockImplementation((file, ...args) => {
      if (file === 'broken.c') throw new Error('injected new-file parse failure');
      return extract(file, ...args);
    });
    await expect(cg!.sync()).rejects.toBeInstanceOf(SyncIncompleteError);
    expect(queries().getMetadata(PENDING)).toBeNull();
    expect(cg!.getIndexCompleteness()).toEqual({ status: 'incomplete', diagnostics: [
      expect.objectContaining({ code: 'sync_file_failed', filePath: 'broken.c' }),
    ] });
    expect(queries().getFileByPath('broken.c')).toBeNull();
    expect((await cg!.sync({ paths: ['api.c'] })).complete).toBe(false);
    expect(cg!.getIndexCompleteness().status).toBe('incomplete');
    failure.mockRestore();
    cg!.close(); cg = await CodeGraph.open(directory);
    expect((await cg.sync()).complete).toBe(true);
    expect(cg.getIndexCompleteness()).toEqual({ status: 'complete', diagnostics: [] });
  });

  it('keeps a scope migration with only synthesis failure usable', async () => {
    await setup();
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', undefined);
    const pressure = memoryPressure();
    expect(await cg!.sync()).toMatchObject({ complete: false, filesErrored: 0 });
    expect(queries().getMetadata('language_scope_pending')).toBeNull();
    pressure.mockRestore();
    const parse = vi.spyOn(treeSitter, 'extractFromSource');
    expect((await cg!.sync()).complete).toBe(true);
    expect(parse).not.toHaveBeenCalled();
  });

  it.each(['full', 'scoped'] as const)('retains completion work when the %s conformance tail throws', async mode => {
    await setup();
    if (mode === 'full') queries().applyMetadataChanges({ [VERSION]: null });
    else fs.appendFileSync(path.join(directory, 'api.c'), '\n/* tail retry */\n');
    vi.spyOn(internal().resolver, 'resolveChainedCallsViaConformance').mockImplementationOnce(() => {
      expect(queries().getMetadata(PENDING)).not.toBeNull();
      throw new Error('injected conformance failure');
    });
    await expect(cg!.sync()).rejects.toThrow('injected conformance failure');
    expect(cg!.getIndexCompleteness().status).toBe('incomplete');
    expect(queries().getMetadata(PENDING)).not.toBeNull();
    cg!.close(); cg = await CodeGraph.open(directory);
    expect((await cg.sync()).complete).toBe(true);
  });

  it('writes deferred conformance row IDs ahead of matching so an interruption survives reopen', async () => {
    await setup();
    const caller = cg!.getNodesByName('caller')[0]!;
    const inserted = raw().prepare(`INSERT INTO unresolved_refs
      (from_node_id,reference_name,reference_kind,line,col,file_path,language,status,name_tail)
      VALUES (?, 'Factory.create().run', 'calls', 99, 0, 'caller.c', 'java', 'failed', 'run')`).run(caller.id);
    internal().resolver.appendDeferredFromWorkers([{
      rowId: Number(inserted.lastInsertRowid), fromNodeId: caller.id,
      referenceName: 'Factory.create().run', referenceKind: 'calls',
      filePath: 'caller.c', language: 'java', line: 99, column: 0,
    }]);
    vi.spyOn(internal().resolver, 'clearCaches').mockImplementationOnce(() => { throw new Error('matching interrupted'); });
    expect(() => internal().resolver.resolveChainedCallsViaConformance()).toThrow('matching interrupted');
    expect(cg!.getPendingReferenceCount()).toBe(1);
    cg!.close(); cg = await CodeGraph.open(directory);
    expect((await cg.sync()).complete).toBe(true);
    expect(cg.getPendingReferenceCount()).toBe(0);
  });

  it.each([['modify', 0], ['delete', 1]] as const)(
    'retracts stale third-file registrations after %s and converges to a fresh four-table graph', async (change, admitted) => {
      const sources: Record<string, string> = {
        'dispatcher.py': "def dispatch():\n    bus.emit('ready')\n",
        'handler.py': 'def on_ready():\n    pass\n',
        'registration.py': "bus.on('ready', on_ready)\n",
      };
      for (const [file, content] of Object.entries(sources)) fs.writeFileSync(path.join(directory, file), content);
      cg = CodeGraph.initSync(directory);
      expect((await cg.indexAll()).complete).toBe(true);
      const owned = () => raw().prepare(`SELECT COUNT(*) AS n FROM edges
        WHERE metadata LIKE '%event-emitter%' AND provenance='heuristic'`).get().n;
      expect(owned()).toBe(1);
      const addProtectedEdges = (instance: CodeGraph) => {
        const source = instance.getNodesByName('dispatch')[0]!.id;
        const target = instance.getNodesByName('on_ready')[0]!.id;
        const db = (instance as any).db.getDb();
        // Neither an unowned producer, malformed metadata, nor a direct call
        // carrying an ownership-looking label belongs to this replay.
        for (const [line, metadata, provenance] of [
          [1001, '{"synthesizedBy":"another-producer"}', 'heuristic'],
          [1002, 'invalid json', 'heuristic'],
          [1003, '{"synthesizedBy":"event-emitter"}', null],
        ]) db.prepare('INSERT INTO edges(source,target,kind,line,col,metadata,provenance) VALUES (?,?,?, ?,0,?,?)')
          .run(source, target, 'calls', line, metadata, provenance);
      };
      addProtectedEdges(cg);
      queries().applyMetadataChanges({ [VERSION]: null });
      if (change === 'modify') {
        sources['registration.py'] = 'pass\n';
        fs.writeFileSync(path.join(directory, 'registration.py'), sources['registration.py']);
      } else {
        delete sources['registration.py'];
        fs.unlinkSync(path.join(directory, 'registration.py'));
      }
      const pressure = memoryPressure(admitted);
      expect((await cg.sync()).complete).toBe(false);
      expect(owned()).toBe(admitted === 0 ? 1 : 0);
      expect(cg.getIndexCompleteness().status).toBe('incomplete');
      pressure.mockRestore();
      cg.close(); cg = await CodeGraph.open(directory);
      expect((await cg.sync()).complete).toBe(true);
      expect(owned()).toBe(0);

      const freshDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-synthesis-fresh-'));
      let fresh: CodeGraph | undefined;
      try {
        for (const [file, content] of Object.entries(sources)) fs.writeFileSync(path.join(freshDirectory, file), content);
        fresh = CodeGraph.initSync(freshDirectory);
        expect((await fresh.indexAll()).complete).toBe(true);
        addProtectedEdges(fresh);
        const semanticTables = (instance: CodeGraph) => {
          const db = (instance as any).db.getDb();
          return Object.fromEntries(['nodes', 'edges', 'files', 'unresolved_refs'].map(table => [table,
            db.prepare(`SELECT * FROM ${table}`).all().map((row: Record<string, unknown>) =>
              JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) =>
                !['updated_at', 'modified_at', 'indexed_at'].includes(key) &&
                !(key === 'id' && (table === 'edges' || table === 'unresolved_refs')),
              )))).sort(),
          ]));
        };
        expect(semanticTables(cg)).toEqual(semanticTables(fresh));
      } finally { fresh?.close(); fs.rmSync(freshDirectory, { recursive: true, force: true }); }
    },
  );

  it.each(['batch-progress', 'synthesis-progress', 'memory-skip'] as const)(
    'recovers real inherited chained calls after %s, before conformance has run', async interruption => {
      const source = `class Base { void draw() {} }
class Widget extends Base {}
class Decoy { void draw() {} }
class Factory { static Widget create() { return new Widget(); } }
class Caller { void run() { Factory.create().draw(); } }
`;
      fs.writeFileSync(path.join(directory, 'Main.java'), source);
      cg = CodeGraph.initSync(directory);
      expect((await cg.indexAll()).complete).toBe(true);
      fs.writeFileSync(path.join(directory, 'Main.java'), source + '// force a replacement\n');
      const pressure = interruption === 'memory-skip' ? memoryPressure() : undefined;
      const work = cg.indexAll({ onProgress: progress => {
        if ((interruption === 'batch-progress' && progress.phase === 'resolving' && progress.current > 0) ||
            (interruption === 'synthesis-progress' && progress.phase === 'synthesizing')) {
          throw new Error('interrupt before conformance');
        }
      } });
      if (pressure) expect((await work).complete).toBe(false);
      else await expect(work).rejects.toThrow('interrupt before conformance');
      expect(queries().getMetadataByPrefix('resolution-deferred:').length).toBeGreaterThan(0);
      expect(cg.getIndexCompleteness().status).toBe('incomplete');
      pressure?.mockRestore();
      cg.close(); cg = await CodeGraph.open(directory);
      const parse = vi.spyOn(treeSitter, 'extractFromSource');
      expect((await cg.sync()).complete).toBe(true);
      expect(parse).not.toHaveBeenCalled();
      expect(queries().getMetadataByPrefix('resolution-deferred:')).toHaveLength(0);
      expect(queries().getMetadata('index_conformance_pending')).toBeNull();
      const draw = cg.getNodesByKind('method').find(node => node.qualifiedName === 'Base::draw')!;
      const callers = cg.getIncomingEdges(draw.id).filter(edge => edge.kind === 'calls')
        .map(edge => cg!.getNode(edge.source)?.name);
      expect(callers).toContain('run');
      parse.mockRestore();
      const freshDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-conformance-fresh-'));
      let fresh: CodeGraph | undefined;
      try {
        fs.writeFileSync(path.join(freshDirectory, 'Main.java'), source + '// force a replacement\n');
        fresh = CodeGraph.initSync(freshDirectory);
        expect((await fresh.indexAll()).complete).toBe(true);
        const freshEdges = (fresh as any).db.getDb().prepare(`SELECT source,target,kind,line,col,metadata,provenance
          FROM edges ORDER BY source,target,kind,line,col,metadata,provenance`).all();
        expect(graph()).toEqual(freshEdges);
      } finally { fresh?.close(); fs.rmSync(freshDirectory, { recursive: true, force: true }); }
    },
  );

  it('does not delete synthesized edges when the index was provably fresh before extraction', async () => {
    fs.writeFileSync(path.join(directory, 'api.c'), 'int api(void) { return 3; }\n');
    cg = CodeGraph.initSync(directory);
    const deletion = vi.spyOn(queries(), 'deleteSynthesizedEdges');
    expect((await cg.indexAll()).complete).toBe(true);
    expect(deletion).not.toHaveBeenCalled();
    queries().applyMetadataChanges({ [VERSION]: null });
    expect((await cg.sync()).complete).toBe(true);
    expect(deletion).toHaveBeenCalledOnce();
  });

  it('establishes a trusted complete result for an empty index', async () => {
    cg = CodeGraph.initSync(directory);
    expect((await cg.indexAll()).complete).toBe(true);
    expect(cg.getIndexCompleteness()).toEqual({ status: 'complete', diagnostics: [] });
  });
});
