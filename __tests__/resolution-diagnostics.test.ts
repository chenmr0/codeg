import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { ReferenceResolver } from '../src/resolution';
import { ResolutionDiagnostics } from '../src/resolution/diagnostics';
import type { Node, UnresolvedReference } from '../src/types';

describe('changed-file reference phase diagnostics', () => {
  let root: string;
  const connections: DatabaseConnection[] = [];
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-refs-detail-')); });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const connection of connections.splice(0)) connection.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const node = (id: string): Node => ({ id, name: id, qualifiedName: id, kind: 'function', language: 'c',
    filePath: 'a.c', startLine: 1, endLine: 2, startColumn: 0, endColumn: 1, updatedAt: 1 });
  const fixture = () => {
    const connection = DatabaseConnection.initialize(path.join(root, `test${connections.length}.db`));
    connections.push(connection);
    const queries = new QueryBuilder(connection.getDb());
    queries.insertNodes([node('caller'), node('target')]);
    queries.upsertFile({ path: 'a.c', contentHash: 'fixture', language: 'c', size: 1, modifiedAt: 1, indexedAt: 1, nodeCount: 2 });
    const refs: UnresolvedReference[] = ['target', 'missing_target'].map((referenceName, i) => ({
      fromNodeId: 'caller', referenceName, referenceKind: 'calls', filePath: 'a.c', language: 'c', line: i + 1, column: 0,
    }));
    queries.insertUnresolvedRefsBatch(refs);
    return { connection, queries, resolver: new ReferenceResolver(root, queries) };
  };
  it('preserves query sequence, progress, resolution and persisted graph with diagnostics on/off', () => {
    const exercise = (detail?: ResolutionDiagnostics) => {
      const { connection, queries, resolver } = fixture();
      const prepare = vi.spyOn(connection.getDb(), 'prepare');
      const progress: number[][] = [];
      const refs = queries.getUnresolvedReferencesByFiles(['a.c']);
      const result = resolver.resolveAndPersist(refs, (n, total) => progress.push([n, total]), detail);
      const sql = prepare.mock.calls.map(([query]) => query);
      prepare.mockRestore();
      return { result, sql, progress, edges: queries.getOutgoingEdges('caller'),
        pending: queries.getUnresolvedReferencesCount(), failed: queries.getFailedReferenceRetryPlan(['missing_target']) };
    };
    const baseline = exercise();
    const detail = new ResolutionDiagnostics();
    expect(exercise(detail)).toEqual(baseline);
    expect(detail).toMatchObject({ refs: 2, resolved: 1, unresolved: 1, edges: 1,
      cache: 'cold', knownFiles: 1, knownNames: 2, failedPhase: 'none' });
    for (const value of Object.values(detail.timings)) expect(value).toBeGreaterThanOrEqual(0);
  });
  it('reports warm caches without issuing extra global queries, and resets after clearCaches', () => {
    const { queries, resolver } = fixture();
    const files = vi.spyOn(queries, 'getAllFilePaths');
    const names = vi.spyOn(queries, 'getAllNodeNames');
    resolver.warmCaches();
    const warm = new ResolutionDiagnostics();
    resolver.resolveAll([], undefined, warm);
    expect(warm).toMatchObject({ refs: 0, cache: 'warm', knownFiles: 1, knownNames: 2 });
    expect(warm.timings.symbolNamesLoadMs).toBe(0);
    expect(names).toHaveBeenCalledTimes(1); expect(files).toHaveBeenCalledTimes(1);
    queries.insertNodes([node('new_target')]); resolver.clearCaches();
    const cold = new ResolutionDiagnostics(); resolver.resolveAll([], undefined, cold);
    expect(cold).toMatchObject({ cache: 'cold', knownNames: 3 });
    expect(names).toHaveBeenCalledTimes(2); expect(files).toHaveBeenCalledTimes(2);
  });
  it('attributes prewarming even for an empty list without changing its existing behavior', () => {
    const { resolver } = fixture(); const detail = new ResolutionDiagnostics();
    expect(resolver.resolveAndPersist([], undefined, detail).stats.total).toBe(0);
    expect(detail).toMatchObject({ refs: 0, cache: 'cold', knownNames: 2, edges: 0 });
  });
  it('preserves failures and reports the failed global name-load phase', () => {
    const { queries, resolver } = fixture(); const detail = new ResolutionDiagnostics();
    const error = new Error('fixture-name-query-failed');
    vi.spyOn(queries, 'getAllNodeNames').mockImplementation(() => { throw error; });
    expect(() => resolver.resolveAndPersist([], undefined, detail)).toThrow(error);
    expect(detail.failedPhase).toBe('symbolNamesLoadMs');
    expect(detail.format()).toContain('complete=false');
  });
  it('attributes progress callback failures without running persistence', () => {
    const { queries, resolver } = fixture(); const detail = new ResolutionDiagnostics();
    const insert = vi.spyOn(queries, 'insertEdges');
    expect(() => resolver.resolveAndPersist(queries.getUnresolvedReferences(), () => { throw new Error('progress'); }, detail)).toThrow('progress');
    expect(detail.failedPhase).toBe('matchMs'); expect(insert).not.toHaveBeenCalled();
  });
  it('never prints source names or paths in the formatted summary', () => {
    const detail = new ResolutionDiagnostics(); detail.files = 2; detail.complete = true;
    expect(detail.format()).toMatch(/^scope=changed complete=true failedPhase=none files=2 refs=0 /);
    expect(detail.format()).toMatch(/symbolNamesLoadMs=\d+ms .*totalMs=\d+ms$/);
  });
});
