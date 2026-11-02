import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import { QueryBuilder } from '../src/db/queries';
import { ToolHandler } from '../src/mcp/tools';
import { retrieveExploreContext } from '../src/mcp/explore-retrieval';
import { ExploreSemanticView } from '../src/mcp/explore-semantic';

describe('exact exploration and semantic traversal on real indexed source', () => {
  let root: string, cg: CodeGraph;
  beforeAll(async () => {
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
    vi.stubEnv('CODEGRAPH_RAW_EVIDENCE_BACKEND', 'ripgrep');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-p0-'));
    fs.writeFileSync(path.join(root, 'worker.h'), `namespace alpha { namespace detail {
class WorkerUnit {
public:
  int run(int value);
  int run(double value);
  int save();
  int unrelated();
};
} }
namespace beta { class WorkerUnit { public: int run(int value); }; }
`);
    fs.writeFileSync(path.join(root, 'worker.cpp'), `#include "worker.h"
using namespace alpha::detail;
int WorkerUnit::run(int value) { return save() + value; }
int WorkerUnit::run(double value) { return 22; }
int WorkerUnit::save() { return 91; }
namespace beta { int WorkerUnit::run(int value) { return 73; } }
int WorkerUnit::unrelated() { return 999; }
`);
    fs.writeFileSync(path.join(root, 'quota.cpp'), `int read_quota(Config *cfg) {
  return cfg->cache_batch_limit;
}
int read_prefix(Config *cfg) { return cfg->cache_batch_limit_extra; }
`);
    fs.writeFileSync(path.join(root, 'client.ts'), `export function consumeBudget(config: any) {
  return config.retry_window_ms + 17;
}
export function score() { return 500; }
export class Thread { run() { return 100; } }
`);
    cg = CodeGraph.initSync(root, { config: { include: ['**/*.cpp', '**/*.h', '**/*.ts'], exclude: [] } });
    await cg.indexAll();
  });
  afterAll(() => { cg?.close(); fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  function mutateFixture(write: (queries: QueryBuilder) => void) {
    cg.close();
    const writer = CodeGraph.openPortableRaw(root, path.join(root, '.codegraph-wx', 'codegraph.db'), false);
    try { write(new QueryBuilder(writer.getExploreQueryConnection())); }
    finally { writer.close(); cg = CodeGraph.openSync(root); }
    expect(() => cg.getExploreQueryConnection().prepare('UPDATE nodes SET name = name').run()).toThrow(/readonly|read.only/i);
  }

  it('maps unresolved C++ identifiers through ripgrep into a whole indexed function', async () => {
    expect(cg.getNodesBySymbolExact('cache_batch_limit')).toHaveLength(0);
    const r = await retrieveExploreContext(cg, 'cache_batch_limit');
    expect(r.evidence?.backend).toBe('ripgrep');
    expect(r.evidence?.states[0]?.matchingLines).toBe(1);
    const roots = r.graph.roots.map(id => r.graph.nodes.get(id)!);
    expect(roots.map(n => n.name)).toEqual(['read_quota']);
    expect(roots[0]!.endLine - roots[0]!.startLine).toBe(2);
  });
  it('batches literal misses and maps TypeScript as well as C++ bodies', async () => {
    const r = await retrieveExploreContext(cg, 'cache_batch_limit retry_window_ms');
    expect(r.evidence?.states).toHaveLength(2);
    expect(r.graph.roots.map(id => r.graph.nodes.get(id)!.name).sort()).toEqual(['consumeBudget', 'read_quota']);
  });
  it('never turns fragments of an absent identifier into Thread/score roots', async () => {
    const r = await retrieveExploreContext(cg, 'missing_thread_score');
    expect(r.graph.nodes.size).toBe(0);
    expect(r.evidence?.states[0]?.matchingLines).toBe(0);
  });
  it('scopes common member names to the explicitly named type and merges declarations', async () => {
    const r = await retrieveExploreContext(cg, 'alpha::detail::WorkerUnit run');
    const runs = [...r.graph.nodes.values()].filter(n => n.name === 'run');
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.every(n => n.filePath === 'worker.cpp' && !n.isDeclaration)).toBe(true);
    expect(r.lookup('run').every(n => n.qualifiedName === 'alpha::detail::WorkerUnit::run')).toBe(true);
    expect(new Set(runs.map(n => n.id)).size).toBe(runs.length);
  });
  it('attaches out-of-line definitions to their source-supported type during traversal', async () => {
    const r = await retrieveExploreContext(cg, 'alpha::detail::WorkerUnit');
    const type = r.graph.nodes.get(r.graph.roots[0]!)!;
    const save = [...r.graph.nodes.values()].find(n => n.name === 'save' && n.filePath === 'worker.cpp');
    expect(save).toBeTruthy();
    expect(r.graph.edges.some(e => e.source === type.id && e.target === save!.id && e.kind === 'contains')).toBe(true);
    expect(r.graph.nodes.size).toBeLessThanOrEqual(200);
    expect(r.graph.edges.every(e => r.graph.nodes.has(e.source) && r.graph.nodes.has(e.target))).toBe(true);
  });
  it('does not expand unrequested class members when precise members were named', async () => {
    const broad = await retrieveExploreContext(cg, 'alpha::detail::WorkerUnit');
    expect([...broad.graph.nodes.values()].some(n => n.name === 'unrelated')).toBe(true);
    const precise = await retrieveExploreContext(cg, 'alpha::detail::WorkerUnit run');
    expect([...precise.graph.nodes.values()].some(n => n.name === 'unrelated')).toBe(false);
    // A real callee remains useful evidence even though it was not a named member.
    expect([...precise.graph.nodes.values()].some(n => n.name === 'save' && !n.isDeclaration)).toBe(true);
  });
  it('corrects legacy namespace metadata using source, without updating stored rows', () => {
    const original = cg.getNodesByName('WorkerUnit').find(n => n.kind === 'class' && n.qualifiedName === 'alpha::detail::WorkerUnit')!;
    expect(original).toBeTruthy();
    mutateFixture(q => q.insertNodes([{ ...original, qualifiedName: 'alpha::WorkerUnit' }]));
    try {
      const old = cg.getNode(original.id)!;
      const view = new ExploreSemanticView(cg);
      expect(view.normalize(old).qualifiedName).toBe('alpha::detail::WorkerUnit');
      expect(view.members(old).some(n => n.name === 'save' && n.filePath === 'worker.cpp')).toBe(true);
      expect(cg.getNode(original.id)!.qualifiedName).toBe('alpha::WorkerUnit');
    } finally { mutateFixture(q => q.insertNodes([original])); }
  });
  it('retains overloads and does not merge definitions from another namespace', () => {
    const view = new ExploreSemanticView(cg);
    const declarations = cg.getNodesByName('run').filter(n => n.isDeclaration && n.qualifiedName.startsWith('alpha::detail::'));
    expect(declarations).toHaveLength(2);
    const defs = declarations.map(n => view.resolve(n));
    expect(new Set(defs.map(n => n.id)).size).toBe(2);
    expect(defs.map(n => [n.qualifiedName, !!n.isDeclaration])).toEqual([['alpha::detail::WorkerUnit::run', false], ['alpha::detail::WorkerUnit::run', false]]);
  });
  it('recovers display-truncated signatures from source before comparing overloads', () => {
    const original = cg.getNodesByName('run').find(n => n.filePath === 'worker.cpp' && n.startLine === 3)!;
    mutateFixture(q => q.insertNodes([{ ...original, signature: 'int WorkerUnit::run(int val...' }]));
    try {
      const declaration = cg.getNodesByName('run').find(n => n.isDeclaration && n.filePath === 'worker.h' && n.startLine === 4)!;
      const result = new ExploreSemanticView(cg).resolve(declaration);
      expect(result.id).toBe(original.id);
      expect(result.signature).toContain('int value)');
      expect(cg.getNode(original.id)!.signature).toContain('...');
    } finally { mutateFixture(q => q.insertNodes([original])); }
  });
  it('counts independent literal identifiers, not repeated occurrences, as file evidence', async () => {
    const r = await retrieveExploreContext(cg, 'cache_batch_limit cache_batch_limit retry_window_ms');
    expect(r.fileEvidence.get('quota.cpp')).toBe(1);
    expect(r.fileEvidence.get('client.ts')).toBe(1);
  });
  it('does not promise complete source just because a flow exists', async () => {
    const r = await new ToolHandler(cg).execute('explore', { query: 'alpha::detail::WorkerUnit run save', maxFiles: 12 });
    const text = r.content[0]!.text;
    expect(text).not.toMatch(/Full source for these|Complete source for|already Read|Explore budget:/);
    expect(text).toContain('return 91;');
  });
  it('does not map current text hits onto stale indexed function spans', async () => {
    const file = path.join(root, 'quota.cpp'); const original = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, '\n\n\n' + original);
      const r = await retrieveExploreContext(cg, 'cache_batch_limit');
      expect(r.evidence?.states[0]?.matchingLines).toBe(1);
      expect(r.graph.nodes.size).toBe(0);
      expect(r.note).toContain('quota.cpp:5');
    } finally { fs.writeFileSync(file, original); }
  });
  it('reports incomplete fallback scans instead of claiming absence', async () => {
    vi.stubEnv('CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS', '0');
    try {
      const r = await retrieveExploreContext(cg, 'never_present_identifier');
      expect(r.note).toContain('Scan incomplete; absence is not established.');
    } finally { vi.unstubAllEnvs(); vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1'); }
  });
});

describe('semantic ownership ambiguity', () => {
  it('retains ambiguous imports and distinguishes const overloads', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-owners-'));
    let cg: CodeGraph | undefined;
    try {
      fs.writeFileSync(path.join(root, 'types.h'), `namespace left {
class Unit {
public:
  int pick(int v);
  int read();
  int read() const;
};
}
namespace right { class Unit { public: int pick(int v); }; }
`);
      fs.writeFileSync(path.join(root, 'ambiguous.cpp'), `#include "types.h"
using namespace left;
using namespace right;
int Unit::pick(int v) { return v; }
namespace left {
int Unit::read() { return 31; }
int Unit::read() const { return 47; }
}
`);
      cg = CodeGraph.initSync(root, { config: { include: ['**/*.cpp', '**/*.h'], exclude: [] } });
      await cg.indexAll();
      const view = new ExploreSemanticView(cg);
      const declarations = cg.getNodesByName('pick').filter(n => n.isDeclaration);
      expect(declarations).toHaveLength(2);
      expect(declarations.map(n => view.resolve(n).id)).toEqual(declarations.map(n => n.id));
      const reads = cg.getNodesByName('read').filter(n => n.isDeclaration).map(n => view.resolve(n));
      expect(reads).toHaveLength(2);
      expect(reads.every(n => !n.isDeclaration && n.filePath === 'ambiguous.cpp')).toBe(true);
      expect(new Set(reads.map(n => n.id)).size).toBe(2);
    } finally { cg?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
