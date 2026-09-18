import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph, { SyncIncompleteError } from '../src/index';

function rawDb(cg: CodeGraph): any {
  const handle = (cg as any).db?.db;
  if (handle && typeof handle.prepare === 'function') return handle;
  throw new Error('raw DB handle not accessible');
}

function hasCall(cg: CodeGraph, callerName: string, targetName: string): boolean {
  const caller = cg
    .getNodesByName(callerName)
    .find((node) => node.kind === 'function');
  const target = cg
    .getNodesByName(targetName)
    .find((node) => node.kind === 'function');
  if (!caller || !target) return false;
  return cg
    .getOutgoingEdges(caller.id)
    .some((edge) => edge.kind === 'calls' && edge.target === target.id);
}

function incomingEdgeCount(
  cg: CodeGraph,
  targetName: string,
  kind: 'calls' | 'references',
): number {
  const targets = cg
    .getNodesByName(targetName)
    .filter((node) => node.kind === 'function');
  return targets.reduce(
    (total, target) =>
      total + cg.getIncomingEdges(target.id).filter((edge) => edge.kind === kind).length,
    0,
  );
}

describe('C/C++ sync cross-file reference recovery', () => {
  let directory: string;
  let cg: CodeGraph | null;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-ref-recovery-'));
    cg = null;
  });

  afterEach(() => {
    try {
      cg?.destroy();
    } catch {
      // Already closed by a failed assertion path.
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('retries a call in an unchanged C file when another file adds the symbol', async () => {
    fs.writeFileSync(
      path.join(directory, 'caller.c'),
      'int caller(void) { return late_api(); }\n'
    );
    fs.writeFileSync(
      path.join(directory, 'provider.c'),
      'int existing_api(void) { return 1; }\n'
    );

    cg = CodeGraph.initSync(directory);
    await cg.indexAll();

    expect(hasCall(cg, 'caller', 'late_api')).toBe(false);
    const failedBefore = rawDb(cg)
      .prepare(
        "SELECT status, name_tail FROM unresolved_refs WHERE reference_name = 'late_api'"
      )
      .get() as { status: string; name_tail: string } | undefined;
    expect(failedBefore).toEqual({ status: 'failed', name_tail: 'late_api' });

    const callerIndexedAt = cg.getFile('caller.c')!.indexedAt;
    fs.writeFileSync(
      path.join(directory, 'provider.c'),
      'int existing_api(void) { return 1; }\nint late_api(void) { return 2; }\n'
    );

    const result = await cg.sync({ paths: ['provider.c'] });

    expect(result.filesModified).toBe(1);
    expect(result.filesChecked).toBe(1);
    expect(hasCall(cg, 'caller', 'late_api')).toBe(true);
    expect(cg.getFile('caller.c')!.indexedAt).toBe(callerIndexedAt);
    expect(
      rawDb(cg)
        .prepare("SELECT COUNT(*) AS count FROM unresolved_refs WHERE reference_name = 'late_api'")
        .get().count
    ).toBe(0);
  });

  it('parks a dropped C target and heals the unchanged caller when it returns', async () => {
    fs.writeFileSync(
      path.join(directory, 'caller.c'),
      'int caller(void) { return recoverable_api(); }\n'
    );
    fs.writeFileSync(
      path.join(directory, 'provider.c'),
      'int recoverable_api(void) { return 7; }\n'
    );

    cg = CodeGraph.initSync(directory);
    await cg.indexAll();
    expect(hasCall(cg, 'caller', 'recoverable_api')).toBe(true);
    const callerIndexedAt = cg.getFile('caller.c')!.indexedAt;

    fs.unlinkSync(path.join(directory, 'provider.c'));
    const removal = await cg.sync({ paths: ['provider.c'] });

    expect(removal.filesRemoved).toBe(1);
    expect(removal.filesChecked).toBe(1);
    expect(cg.getNodesByName('recoverable_api')).toHaveLength(0);
    const parked = rawDb(cg)
      .prepare(
        "SELECT status, name_tail FROM unresolved_refs WHERE reference_name = 'recoverable_api'"
      )
      .get() as { status: string; name_tail: string } | undefined;
    expect(parked).toEqual({ status: 'failed', name_tail: 'recoverable_api' });
    expect(cg.getFile('caller.c')!.indexedAt).toBe(callerIndexedAt);

    fs.writeFileSync(
      path.join(directory, 'provider.c'),
      'int recoverable_api(void) { return 9; }\n'
    );
    const addition = await cg.sync({ paths: ['provider.c'] });

    expect(addition.filesAdded).toBe(1);
    expect(addition.filesChecked).toBe(1);
    expect(hasCall(cg, 'caller', 'recoverable_api')).toBe(true);
    expect(cg.getFile('caller.c')!.indexedAt).toBe(callerIndexedAt);
  });

  it('matches the final segment of a qualified C++ reference', async () => {
    fs.writeFileSync(
      path.join(directory, 'caller.cpp'),
      'int caller() { return ns::late_cpp(); }\n'
    );
    fs.writeFileSync(
      path.join(directory, 'provider.cpp'),
      'namespace ns { int existing_cpp() { return 1; } }\n'
    );

    cg = CodeGraph.initSync(directory);
    await cg.indexAll();

    const parked = rawDb(cg)
      .prepare(
        "SELECT status, name_tail FROM unresolved_refs WHERE reference_name LIKE '%late_cpp'"
      )
      .get() as { status: string; name_tail: string } | undefined;
    expect(parked).toEqual({ status: 'failed', name_tail: 'late_cpp' });

    fs.writeFileSync(
      path.join(directory, 'provider.cpp'),
      'namespace ns { int existing_cpp() { return 1; } int late_cpp() { return 2; } }\n'
    );
    const result = await cg.sync({ paths: ['provider.cpp'] });

    expect(result.filesChecked).toBe(1);
    expect(hasCall(cg, 'caller', 'late_cpp')).toBe(true);
  });

  it('streams a same-name group at the retry ceiling and heals every unchanged C++ caller', async () => {
    // Qualified calls no longer emit a duplicate bare-name references row.
    // Exercise two 250-reference batches at the inclusive 500-row ceiling.
    // Larger groups are deliberately deferred (covered by sync-retry-filter).
    const callerCount = 500;
    fs.writeFileSync(
      path.join(directory, 'defs.h'),
      'namespace cg_retry { inline int cg_popular_target_v1() { return 1; } }\n'
    );
    for (let i = 0; i < callerCount; i++) {
      fs.writeFileSync(
        path.join(directory, `caller_${String(i).padStart(3, '0')}.cpp`),
        '#include "defs.h"\n' +
          `int cg_popular_caller_${i}() { return cg_retry::cg_popular_target_v1(); }\n`
      );
    }

    cg = CodeGraph.initSync(directory);
    await cg.indexAll();
    expect(incomingEdgeCount(cg, 'cg_popular_target_v1', 'calls')).toBe(callerCount);
    expect(incomingEdgeCount(cg, 'cg_popular_target_v1', 'references')).toBe(0);

    fs.writeFileSync(
      path.join(directory, 'defs.h'),
      'namespace cg_retry { inline int cg_popular_target_v2() { return 2; } }\n'
    );
    await cg.sync({ paths: ['defs.h'] });

    const failedCount = (): number =>
      rawDb(cg!)
        .prepare(
          "SELECT COUNT(*) AS count FROM unresolved_refs " +
            "WHERE status = 'failed' AND name_tail = 'cg_popular_target_v1'"
        )
        .get().count as number;
    expect(failedCount()).toBe(callerCount);

    // A same-named symbol in an incompatible language makes every row get a
    // real retry attempt but must not bind cross-language or loop forever.
    fs.writeFileSync(
      path.join(directory, 'wrong_language.py'),
      'def cg_popular_target_v1():\n    return 3\n'
    );
    let yieldedBetweenRetryBatches = false;
    let sawSecondRetryBatch = false;
    const incompatible = await cg.sync({
      paths: ['wrong_language.py'],
      onProgress: (progress) => {
        if (
          progress.phase === 'resolving' &&
          progress.total === callerCount &&
          progress.current === 250
        ) {
          setImmediate(() => {
            yieldedBetweenRetryBatches = true;
          });
        }
        if (
          progress.phase === 'resolving' &&
          progress.total === callerCount &&
          progress.current === callerCount
        ) {
          sawSecondRetryBatch = true;
          expect(yieldedBetweenRetryBatches).toBe(true);
        }
      },
    });
    expect(incompatible.complete).toBe(true);
    expect(sawSecondRetryBatch).toBe(true);
    expect(failedCount()).toBe(callerCount);

    fs.writeFileSync(
      path.join(directory, 'defs.h'),
      'namespace cg_retry { inline int cg_popular_target_v1() { return 4; } }\n'
    );
    const healed = await cg.sync({ paths: ['defs.h'] });

    expect(healed.complete).toBe(true);
    expect(failedCount()).toBe(0);
    expect(incomingEdgeCount(cg, 'cg_popular_target_v1', 'calls')).toBe(callerCount);
    expect(incomingEdgeCount(cg, 'cg_popular_target_v1', 'references')).toBe(0);
  }, 30_000);

  it('does not report an unstored co-importer fallback as successfully modified', async () => {
    fs.writeFileSync(
      path.join(directory, 'defs.h'),
      'namespace cg_ns { inline int cg_target_v1() { return 1; } }\n'
    );
    fs.writeFileSync(
      path.join(directory, 'caller.cpp'),
      '#include "defs.h"\nint cg_caller() { return cg_ns::cg_target_v1(); }\n'
    );

    cg = CodeGraph.initSync(directory);
    await cg.indexAll();
    expect(hasCall(cg, 'cg_caller', 'cg_target_v1')).toBe(true);
    const callerIndexedAt = cg.getFile('caller.cpp')!.indexedAt;

    const orchestrator = (cg as any).orchestrator;
    const originalIndexFile = orchestrator.indexFile.bind(orchestrator);
    const fallbackAttempts: string[] = [];
    // Legacy indexes can contain unstamped edges. These still require the
    // source re-index fallback; stamped references now survive directly.
    rawDb(cg).prepare(`UPDATE edges SET metadata = NULL WHERE source IN
      (SELECT id FROM nodes WHERE name = 'cg_caller') AND kind = 'calls'`).run();
    orchestrator.indexFile = async (
      filePath: string,
      options?: { force?: boolean },
    ) => {
      if (filePath !== 'caller.cpp') return originalIndexFile(filePath, options);
      fallbackAttempts.push(filePath);
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{
          message: 'synthetic main-process parser failure',
          filePath,
          severity: 'error' as const,
          code: 'parser_error',
        }],
        durationMs: 0,
        stored: false,
      };
    };

    fs.writeFileSync(
      path.join(directory, 'defs.h'),
      'namespace cg_ns { inline int cg_target_v2() { return 2; } }\n'
    );

    let failure: unknown;
    try {
      await cg.sync({ paths: ['defs.h'] });
    } catch (error) {
      failure = error;
    }

    expect(fallbackAttempts).toEqual(['caller.cpp']);
    expect(failure).toBeInstanceOf(SyncIncompleteError);
    const incomplete = (failure as SyncIncompleteError).result;
    expect(incomplete).toEqual(expect.objectContaining({
      complete: false,
      filesModified: 1,
      filesErrored: 1,
      failedFilePaths: ['caller.cpp'],
      changedFilePaths: ['defs.h'],
    }));
    expect(incomplete.errors).toContainEqual(expect.objectContaining({
      filePath: 'caller.cpp',
      code: 'parser_error',
      message: 'synthetic main-process parser failure',
    }));
    expect(cg.getFile('caller.cpp')!.indexedAt).toBe(callerIndexedAt);
    expect(cg.getNodesByName('cg_caller')).toHaveLength(1);
    expect(hasCall(cg, 'cg_caller', 'cg_target_v1')).toBe(false);
    expect(hasCall(cg, 'cg_caller', 'cg_target_v2')).toBe(false);
  });
});
