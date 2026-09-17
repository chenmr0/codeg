import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import CodeGraph from '../src/index';
import { createDatabase, ensureSqlJsReady } from '../src/db/sqlite-adapter';
import { QueryBuilder } from '../src/db/queries';

const graphs: CodeGraph[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const graph of graphs.splice(0)) graph.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-node-retention-'));
  directories.push(directory);
  fs.writeFileSync(path.join(directory, 'defs.c'), 'int alpha(void) { return 1; }\nint bravo(void) { return 2; }\n');
  fs.writeFileSync(path.join(directory, 'provider.c'), 'int target(void) { return alpha(); }\n');
  fs.writeFileSync(path.join(directory, 'caller.c'), 'int caller(void) { return target(); }\n');
  const graph = CodeGraph.initSync(directory); graphs.push(graph);
  await graph.indexAll();
  const db = (graph as any).db.db;
  const queries = (graph as any).queries;
  const write = (text: string) => fs.writeFileSync(path.join(directory, 'provider.c'), text);
  const incoming = () => db.prepare("SELECT e.* FROM edges e JOIN nodes s ON s.id=e.source WHERE s.name='caller' AND e.kind='calls' ORDER BY e.id").all();
  const outgoing = () => db.prepare("SELECT t.name FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE s.name='target' AND e.kind='calls' ORDER BY t.name").all().map((n: any) => n.name);
  return { directory, graph, db, queries, write, incoming, outgoing };
}

describe('sync retains stable target nodes', () => {
  it('keeps incoming rows while rebuilding changed calls and failed refs', async () => {
    const f = await fixture();
    const before = f.incoming();
    expect(before).toHaveLength(1);
    const target = f.graph.getNodesByName('target')[0]!;
    f.graph.getNode(target.id); // Populate the pre-update node cache.
    f.queries.insertUnresolvedRefsBatch([{ fromNodeId: target.id, referenceName: 'old_missing',
      referenceKind: 'calls', line: 1, column: 0, filePath: 'provider.c', language: 'c' }]);
    const refresh = vi.spyOn(f.queries, 'refreshFileNodes');
    const snapshot = vi.spyOn(f.queries, 'getIncomingCrossFileEdges');
    f.write('int target(void) { return bravo(); }\n');
    await f.graph.sync({ paths: ['provider.c'] });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(snapshot).not.toHaveBeenCalled();
    expect(f.incoming()).toEqual(before); // Includes original edge row IDs.
    expect(f.outgoing()).toEqual(['bravo']);
    expect(f.db.prepare("SELECT count(*) n FROM unresolved_refs WHERE reference_name='old_missing'").get().n).toBe(0);
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('supports node refresh on the WASM storage backend', async () => {
    vi.stubGlobal('fetch', undefined); await ensureSqlJsReady(); vi.unstubAllGlobals();
    vi.stubEnv('CODEGRAPH_FORCE_WASM', '1');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-retention-wasm-'));
    directories.push(directory);
    const { db } = createDatabase(path.join(directory, 'graph.db'));
    try {
      db.exec(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
      const queries = new QueryBuilder(db);
      const node = { id: 'target', name: 'target', qualifiedName: 'target', kind: 'function' as const,
        language: 'c' as const, filePath: 'provider.c', startLine: 1, endLine: 1,
        startColumn: 0, endColumn: 1, updatedAt: 1 };
      queries.insertNodes([node, { ...node, id: 'caller', name: 'caller', filePath: 'caller.c' }]);
      queries.insertEdges([{ source: 'caller', target: 'target', kind: 'calls' },
        { source: 'target', target: 'caller', kind: 'calls' }]);
      queries.insertUnresolvedRefsBatch([{ fromNodeId: 'target', referenceName: 'missing', referenceKind: 'calls', line: 1, column: 0 }]);
      const before = db.prepare("SELECT * FROM edges WHERE source='caller'").all();
      queries.getNodeById('target');
      queries.refreshFileNodes('provider.c', [{ ...node, endLine: 3 }]);
      expect(db.prepare("SELECT * FROM edges WHERE source='caller'").all()).toEqual(before);
      expect(db.prepare("SELECT * FROM edges WHERE source='target'").all()).toEqual([]);
      expect(queries.getNodeById('target')!.endLine).toBe(3);
      expect(queries.getUnresolvedReferencesCount()).toBe(0);
    } finally { db.close(); }
  });

  it('falls back when a signature changes at a reused node ID', async () => {
    const f = await fixture();
    const refresh = vi.spyOn(f.queries, 'refreshFileNodes');
    const snapshot = vi.spyOn(f.queries, 'getIncomingCrossFileEdges');
    const previousId = f.graph.getNodesByName('target')[0]!.id;
    f.write('int target(int value) { return value; }\n');
    await f.graph.sync({ paths: ['provider.c'] });
    expect(f.graph.getNodesByName('target')[0]!.id).toBe(previousId);
    expect(refresh).not.toHaveBeenCalled();
    expect(snapshot).toHaveBeenCalledWith('provider.c');
  });

  it('rolls back a failed refresh and retries the file', async () => {
    const f = await fixture();
    const before = f.incoming();
    const hash = f.graph.getFile('provider.c')!.contentHash;
    f.db.exec("CREATE TRIGGER fail_refresh BEFORE UPDATE ON nodes WHEN NEW.name='target' BEGIN SELECT RAISE(ABORT,'refresh failed'); END");
    f.write('int target(void) { return bravo(); }\n');
    await expect(f.graph.sync({ paths: ['provider.c'] })).rejects.toThrow('refresh failed');
    expect(f.graph.getFile('provider.c')!.contentHash).toBe(hash);
    expect(f.incoming()).toEqual(before);
    expect(f.outgoing()).toEqual(['alpha']);
    f.db.exec('DROP TRIGGER fail_refresh');
    await f.graph.sync({ paths: ['provider.c'] });
    expect(f.outgoing()).toEqual(['bravo']);
  });

  it('matches the full graph of the old replacement path through successive edits', async () => {
    async function run(retain: boolean) {
      const f = await fixture();
      if (!retain) vi.spyOn((f.graph as any).orchestrator, 'tryRetainFileNodes').mockReturnValue(false);
      const results = [];
      for (const text of ['int target(void) { return bravo(); }\n',
        'int target(void) { return bravo(); }\n/* note */\n',
        '\nint target(void) { return alpha(); }\n',
        'int renamed(void) { return bravo(); }\n', 'int target(void) { return alpha(); }\n']) {
        f.write(text); await f.graph.sync({ paths: ['provider.c'] });
        results.push({
          nodes: f.db.prepare('SELECT id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,signature,is_declaration,return_type FROM nodes ORDER BY id').all(),
          edges: f.db.prepare('SELECT source,target,kind,line,col,metadata,provenance FROM edges ORDER BY source,target,kind,line,col,metadata,provenance').all(),
          refs: f.db.prepare('SELECT from_node_id,reference_name,reference_kind,line,col,candidates,file_path,language,status,name_tail FROM unresolved_refs ORDER BY from_node_id,reference_name,reference_kind,line,col').all(),
        });
      }
      return results;
    }
    expect(await run(true)).toEqual(await run(false));
  });
});
