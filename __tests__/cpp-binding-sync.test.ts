import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { QueryBuilder } from '../src/db/queries';
import { createDatabase } from '../src/db/sqlite-adapter';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';
import * as bindingInvalidation from '../src/resolution/cpp-binding-invalidation';

interface Target { path: string; name: string; qualifiedName?: string }
interface Site { path: string; line: number; sourceName: string; refName: string }
interface SyncCase {
  id: string; files: Record<string, string>; changedPath: string; changedSource: string;
  site: Site; before: Target; after: Target[];
}
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/cpp-binding-cases.json'), 'utf8')) as {
  syncCases: SyncCase[];
};
const roots: string[] = [], graphs: CodeGraph[] = [];
beforeEach(() => {
  for (const [name, value] of Object.entries({ CODEGRAPH_RUST_SCAN: '0', CODEGRAPH_RUST_MACROS: '0',
    CODEGRAPH_RUST_GIT_IGNORE: '0', CODEGRAPH_PARSE_WORKERS: '1', CODEGRAPH_RESOLVE_WORKERS: '1',
    CODEGRAPH_ALL_LANGUAGES: '1' })) vi.stubEnv(name, value);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const graph of graphs.splice(0)) {
    await graph.whenIdle(); graph.close(); await graph.whenIdle();
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-binding-sync-')); roots.push(root);
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), source);
  }
  const graph = CodeGraph.initSync(root); graphs.push(graph); return { root, graph };
}
function db(graph: CodeGraph) { return graph.getExploreQueryConnection(); }
function targets(graph: CodeGraph, site: Site) {
  return db(graph).prepare(`SELECT t.id, t.file_path path, t.name, t.qualified_name qualifiedName FROM edges e
    JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
    WHERE s.file_path=? AND s.name=? AND e.line=? AND e.kind='calls' ORDER BY t.id`)
    .all(site.path, site.sourceName, site.line) as Array<Target & { id: string }>;
}
function matches(actual: Target, expected: Target) {
  return actual.path === expected.path && actual.name === expected.name
    && (!expected.qualifiedName || actual.qualifiedName === expected.qualifiedName);
}
function semanticSnapshot(graph: CodeGraph) {
  return Object.fromEntries(['nodes', 'edges', 'unresolved_refs', 'files'].map(table => [table,
    db(graph).prepare(`SELECT * FROM ${table}`).all().map((row: Record<string, unknown>) =>
      Object.fromEntries(Object.keys(row).sort()
        .filter(key => !['updated_at', 'modified_at', 'indexed_at'].includes(key)
          && !(['edges', 'unresolved_refs'].includes(table) && key === 'id'))
        .map(key => [key, row[key]]))).sort((a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
}
async function freshEquals(graph: CodeGraph, files: Record<string, string>) {
  const fresh = project(files).graph;
  const result = await fresh.indexAll(); expect(result.complete).toBe(true); expect(result.errors).toEqual([]);
  expect(semanticSnapshot(graph)).toEqual(semanticSnapshot(fresh));
  expect(db(graph).prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

for (const mode of ['sync', 'indexAll'] as const) for (const c of fixture.syncCases)
  it(`${mode} rechecks successful edges after ${c.id} with stable target identities`, async () => {
  const files = { ...c.files }, { root, graph } = project(files);
  expect((await graph.indexAll()).complete).toBe(true);
  const before = targets(graph, c.site);
  const diagnostic = before.length ? undefined : JSON.stringify({ id: c.id,
    nodes: db(graph).prepare('SELECT name,qualified_name,kind,language,file_path,signature FROM nodes').all(),
    refs: db(graph).prepare('SELECT reference_name,reference_kind,file_path,language,line,col FROM unresolved_refs').all() });
  expect(before, diagnostic).toHaveLength(1); expect(matches(before[0]!, c.before)).toBe(true);
  const stableTargetId = before[0]!.id;
  const callerHash = graph.getFile(c.site.path)!.contentHash;
  files[c.changedPath] = c.changedSource; fs.writeFileSync(path.join(root, c.changedPath), c.changedSource);
  const result = mode === 'indexAll' ? await graph.indexAll() : await graph.sync({ adaptive: false, paths: [c.changedPath] });
  expect(result.complete).toBe(true); expect(result.errors ?? []).toEqual([]);
  expect(graph.getFile(c.site.path)!.contentHash).toBe(callerHash);
  // The former target still exists with the same identity. A missing-node
  // repair cannot explain removal of the previously successful call edge.
  expect(db(graph).prepare('SELECT id FROM nodes WHERE id=?').get(stableTargetId)?.id).toBe(stableTargetId);
  const after = targets(graph, c.site);
  expect(after.some(node => node.id === stableTargetId)).toBe(false);
  expect(after).toHaveLength(1); expect(c.after.some(target => matches(after[0]!, target))).toBe(true);
  await freshEquals(graph, files);
  // Reverse evidence change also recovers a previously invalidated caller.
  files[c.changedPath] = c.files[c.changedPath]!; fs.writeFileSync(path.join(root, c.changedPath), files[c.changedPath]!);
  expect((mode === 'indexAll' ? await graph.indexAll() : await graph.sync({ adaptive: false, paths: [c.changedPath] })).complete).toBe(true);
  expect(targets(graph, c.site).map(node => node.id)).toEqual([stableTargetId]);
  await freshEquals(graph, files);
}, 45_000);

it('unchanged indexAll preserves the binding baseline without rebuilding source snapshots', async () => {
  const { graph } = project(fixture.syncCases[0]!.files);
  expect((await graph.indexAll()).complete).toBe(true);
  const baseline = () => db(graph).prepare(`SELECT key,value,updated_at FROM project_metadata
    WHERE key LIKE 'resolution:cpp-binding-%' ORDER BY key`).all();
  const before = baseline();
  expect(before.length).toBeGreaterThan(0);
  const rebuild = vi.spyOn(bindingInvalidation, 'establishCppBindingBaseline');
  const result = await graph.indexAll();
  expect(result.complete).toBe(true);
  expect(rebuild).not.toHaveBeenCalled();
  expect(baseline()).toEqual(before);
}, 45_000);

it('scoped sync replaces a persisted v40 wrong success across every policy file before stamping the new version', async () => {
  const files = {
    'api.h': 'extern int route(int);\n',
    'main.cpp': '#include "api.h"\nint invoke(int value) {\n  return route(value);\n}\n',
    'private.cpp': 'static int route(int value) { return value + 99; }\n',
    'other.cpp': 'int leaf(int value) { return value; }\nint ordinary(int value) { return leaf(value); }\n',
  };
  const initial = project(files), root = initial.root;
  let graph = initial.graph;
  expect((await graph.indexAll()).complete).toBe(true);
  const caller = graph.getNodesByName('invoke')[0]!;
  const wrong = graph.getNodesByName('route').find(node => node.filePath === 'private.cpp')!;
  const databasePath = graph.getDatabaseFilePath();
  await graph.whenIdle(); graph.close(); await graph.whenIdle();
  graphs.splice(graphs.indexOf(graph), 1);
  // Public facades expose readonly query connections. Seed historical state
  // only after their leases and asynchronous workers have completely drained.
  const writer = createDatabase(databasePath);
  try {
    writer.db.transaction(() => {
      writer.db.prepare("DELETE FROM edges WHERE source=? AND kind='calls'").run(caller.id);
      writer.db.prepare("DELETE FROM unresolved_refs WHERE from_node_id=? AND reference_kind='calls'").run(caller.id);
      writer.db.prepare("INSERT INTO edges(source,target,kind,line,col,metadata) VALUES(?,?,'calls',3,9,?)")
        .run(caller.id, wrong.id, JSON.stringify({ confidence: 0.9, resolvedBy: 'exact-match', refName: 'route' }));
      new QueryBuilder(writer.db).setMetadata('indexed_with_extraction_version', '40');
    })();
  } finally { writer.db.close(); }
  graph = CodeGraph.openSync(root); graphs.push(graph);
  expect(graph.isIndexStale()).toBe(true);
  expect(targets(graph, { path: 'main.cpp', sourceName: 'invoke', line: 3, refName: 'route' })[0]!.id).toBe(wrong.id);
  const originalFiles = (db(graph).prepare('SELECT path FROM files ORDER BY path').all() as Array<{ path: string }>).map(file => file.path);
  const result = await graph.sync({ adaptive: false, paths: ['other.cpp'] });
  expect(result.complete).toBe(true); expect(result.errors ?? []).toEqual([]);
  expect(EXTRACTION_VERSION).toBeGreaterThanOrEqual(41);
  expect(result.filesModified).toBe(originalFiles.length);
  expect(graph.getIndexBuildInfo().extractionVersion).toBe(EXTRACTION_VERSION);
  expect(graph.isIndexStale()).toBe(false);
  expect(targets(graph, { path: 'main.cpp', sourceName: 'invoke', line: 3, refName: 'route' })
    .some(node => node.id === wrong.id)).toBe(false);
  await freshEquals(graph, files);
  expect((await graph.sync({ adaptive: false, paths: ['other.cpp'] })).filesModified).toBe(0);
  expect(fs.readFileSync(path.join(root, 'main.cpp'), 'utf8')).toBe(files['main.cpp']);
}, 45_000);
