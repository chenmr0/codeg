import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import { retrieveExploreContext } from '../src/mcp/explore-retrieval';

describe('explicit explore targets on real C++ and TypeScript indexes', () => {
  let root: string, cg: CodeGraph;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-targets-p2-'));
    for (const folder of ['left', 'right']) fs.mkdirSync(path.join(root, folder));
    fs.writeFileSync(path.join(root, 'left', 'worker.h'), `namespace alpha {
class PacketWorker {
public:
  int run(int value);
  int run(double value);
  int save();
  int capacity;
  ~PacketWorker();
};
}
`);
    fs.writeFileSync(path.join(root, 'left', 'worker.cpp'), `#include "worker.h"
namespace alpha {
int PacketWorker::run(int value) {
  return save() + value;
}
int PacketWorker::run(double value) {
  return 7;
}
int PacketWorker::save() { return 91; }
PacketWorker::~PacketWorker() { }
}
`);
    fs.writeFileSync(path.join(root, 'right', 'worker.h'), `namespace beta {
class PacketWorker { public: int run(int value); };
}
`);
    fs.writeFileSync(path.join(root, 'right', 'worker.cpp'), `#include "worker.h"
namespace beta {
int PacketWorker::run(int value) { return value; }
}
`);
    fs.writeFileSync(path.join(root, 'plain.ts'), '// no callable on this line\nexport const MAX_SIZE = 5;\n');
    fs.writeFileSync(path.join(root, 'limits.ts'), 'export class QueueLimits {\n  threshold = 17;\n}\n');
    fs.writeFileSync(path.join(root, 'global.cpp'), 'class ScopedWorker { public: int run(int value) { return value; } };\n');
    fs.writeFileSync(path.join(root, 'left', 'scoped.cpp'), 'namespace alpha { class ScopedWorker { public: int run(int value) { return value; } }; }\n');
    fs.writeFileSync(path.join(root, 'incidental.ts'), 'export class FakeAnchor { run() { return 1; } }\n');
    fs.mkdirSync(path.join(root, 'FakeAnchor'));
    fs.writeFileSync(path.join(root, 'FakeAnchor', 'other.cpp'), 'int isolated_path_target() { return 19; }\n');
    fs.writeFileSync(path.join(root, 'callee.ts'), 'export function externalStep() { return 13; }\n');
    fs.writeFileSync(path.join(root, 'range.ts'), `import { externalStep } from './callee';
export function requestedBody() {
  return externalStep();
}
export function unrelatedSibling() { return externalStep(); }
`);
    fs.writeFileSync(path.join(root, 'many.cpp'), `namespace stress {
${Array.from({ length: 40 }, (_, i) => `int task${i}(){ return ${i}; }`).join('\n')}
}
`);
    cg = CodeGraph.initSync(root, { config: { include: ['**/*.ts', '**/*.cpp', '**/*.h'], exclude: [] } });
    await cg.indexAll();
  });
  afterAll(() => { cg?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const exact = (r: Awaited<ReturnType<typeof retrieveExploreContext>>) => [...r.targets.exactNodeIds].map(id => r.graph.nodes.get(id)!);

  it('removes whole path spans before identifier seeding and does not name every member', async () => {
    const r = await retrieveExploreContext(cg, 'left/worker.cpp');
    expect(r.targets.pinnedFiles).toEqual(['left/worker.cpp']);
    expect(r.targets.matchQuery).toBe('');
    expect(r.targets.exactNodeIds.size).toBe(0);
    expect(r.namedNodeIds.size).toBe(0);
    expect(r.diagnostics.seeds.every(s => s.kind === 'path')).toBe(true);
    expect([...r.graph.nodes.values()].some(n => n.qualifiedName === 'alpha::PacketWorker::run')).toBe(true);
  });
  it.each(['left/worker.cpp:4', 'left/worker.cpp#L4', 'left/worker.cpp line 4', 'L4 of left/worker.cpp'])('maps a line to the innermost callable: %s', async query => {
    const r = await retrieveExploreContext(cg, query);
    expect(r.targets.spans.get('left/worker.cpp')).toEqual([{ start: 4, end: 4 }]);
    expect(exact(r)).toHaveLength(1);
    expect(exact(r)[0]!.qualifiedName).toBe('alpha::PacketWorker::run');
    expect(exact(r)[0]!.signature).toContain('int value');
  });
  it('canonicalizes a declaration line to the matching overload definition', async () => {
    const r = await retrieveExploreContext(cg, 'left/worker.h:5');
    expect(exact(r)).toHaveLength(1);
    expect(exact(r)[0]!.isDeclaration).toBeFalsy();
    expect(exact(r)[0]!.filePath).toBe('left/worker.cpp');
    expect(exact(r)[0]!.signature).toContain('double value');
    expect(r.targets.pinnedFiles).toEqual(['left/worker.h']);
  });
  it('protects multi-line ranges and non-callable source without inventing a function', async () => {
    const r = await retrieveExploreContext(cg, 'left/worker.cpp#L4-L8 plain.ts:1-2');
    expect(r.targets.spans.get('left/worker.cpp')).toEqual([{ start: 4, end: 8 }]);
    expect(r.targets.spans.get('plain.ts')).toEqual([{ start: 1, end: 2 }]);
    expect(r.targets.exactNodeIds.size).toBe(0);
  });
  it('resolves Windows absolute paths without seeding drive or directory words', async () => {
    const r = await retrieveExploreContext(cg, 'C:\\checkout\\left\\worker.cpp:4');
    expect(r.targets.pinnedFiles).toEqual(['left/worker.cpp']);
    expect(r.targets.matchQuery).toBe('');
    expect(exact(r)).toHaveLength(1);
  });
  it('reports ambiguous basenames and invalid ranges without selecting an arbitrary file', async () => {
    const ambiguous = await retrieveExploreContext(cg, 'worker.cpp:4');
    expect(ambiguous.targets.pinnedFiles).toEqual([]);
    expect(ambiguous.targets.issues.join(' ')).toContain('ambiguous');
    expect(ambiguous.targets.matchQuery).toBe('');
    const outside = await retrieveExploreContext(cg, 'left/worker.cpp:900-999');
    expect(outside.targets.spans.size).toBe(0);
    expect(outside.targets.issues.join(' ')).toContain('exceeds');
  });
  it('keeps every overload but rejects an owner suffix shared across namespaces', async () => {
    const qualified = await retrieveExploreContext(cg, 'alpha::PacketWorker::run');
    expect(exact(qualified)).toHaveLength(2);
    expect(exact(qualified).every(n => n.filePath === 'left/worker.cpp' && !n.isDeclaration)).toBe(true);
    const ambiguous = await retrieveExploreContext(cg, 'PacketWorker::run');
    expect(exact(ambiguous)).toEqual([]);
    expect(ambiguous.graph.nodes.size).toBe(0);
    expect(ambiguous.targets.issues.join(' ')).toContain('ambiguous across namespaces');
    const scoped = await retrieveExploreContext(cg, 'left/worker.h PacketWorker::run');
    expect(exact(scoped)).toHaveLength(2);
    expect(exact(scoped).every(n => n.filePath === 'left/worker.cpp')).toBe(true);
  });
  it('lets a qualified symbol disambiguate a shared basename', async () => {
    const r = await retrieveExploreContext(cg, 'worker.cpp alpha::PacketWorker::run');
    expect(r.targets.pinnedFiles).toEqual(['left/worker.cpp']);
    expect(exact(r)).toHaveLength(2);
    expect(r.targets.issues.join(' ')).toContain('set aside right/worker.cpp');
  });
  it('protects qualified C++ fields and TypeScript properties using their indexed source range', async () => {
    const field = await retrieveExploreContext(cg, 'alpha::PacketWorker::capacity');
    expect(exact(field)).toHaveLength(1);
    expect(exact(field)[0]!.qualifiedName).toBe('alpha::PacketWorker::capacity');
    expect(field.targets.spans.get('left/worker.h')).toEqual([{ start: 7, end: 7 }]);
    const property = await retrieveExploreContext(cg, 'QueueLimits.threshold');
    expect(exact(property)).toHaveLength(1);
    // This indexer represents this TypeScript property as a one-line method;
    // it already enters complete-body selection through the exact-node set.
    expect(exact(property)[0]!.filePath).toBe('limits.ts');
    expect(exact(property)[0]!.startLine).toBe(2);
    expect(exact(property)[0]!.endLine).toBe(2);
  });
  it('retains explicit targets after the 32-root base limit and admits no dangling edges', async () => {
    const r = await retrieveExploreContext(cg, Array.from({ length: 40 }, (_, i) => `stress::task${i}`).join(' '));
    expect(exact(r)).toHaveLength(40);
    expect(r.diagnostics.targets.baseNodes).toBeLessThanOrEqual(200);
    expect(r.diagnostics.targets.addedNodes).toBeGreaterThanOrEqual(8);
    expect(r.graph.edges.every(e => r.graph.nodes.has(e.source) && r.graph.nodes.has(e.target))).toBe(true);
  });
  it('does not map index coordinates after source drift', async () => {
    const file = path.join(root, 'plain.ts');
    const saved = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, '// inserted\n' + saved);
      const r = await retrieveExploreContext(cg, 'plain.ts:2');
      expect(r.sources.get('plain.ts').status).toBe('changed');
      expect(r.targets.spans.size).toBe(0);
      expect(r.targets.issues.join(' ')).toContain('cannot be mapped safely');
    } finally { fs.writeFileSync(file, saved); }
  });
  it('does not seed path fragments after the pin or path-scan limit', async () => {
    const capped = await retrieveExploreContext(cg, 'plain.ts FakeAnchor/other.cpp line 1', { maxFiles: 1 });
    expect(capped.targets.matchQuery).toBe('');
    expect(capped.targets.pinnedFiles).toEqual(['plain.ts']);
    expect(capped.targets.spans.size).toBe(0);
    expect(capped.targets.issues.join(' ')).toContain('path-scan limit');
    expect([...capped.graph.nodes.values()].some(n => n.name === 'FakeAnchor')).toBe(false);
    const scan = await retrieveExploreContext(cg, `${Array.from({ length: 8 }, (_, i) => `abs${i}/missing.cpp`).join(' ')} FakeAnchor/other.cpp`, { maxFiles: 12 });
    expect(scan.targets.matchQuery).toBe('');
    expect(scan.graph.nodes.size).toBe(0);
    expect(scan.targets.issues.join(' ')).toContain('path-scan limit');
  });
  it('does not silently release an unresolved scoped path to a whole-repository member target', async () => {
    const r = await retrieveExploreContext(cg, 'missing/worker.cpp alpha::PacketWorker::run');
    expect(exact(r)).toEqual([]);
    expect(r.graph.nodes.size).toBe(0);
    expect(r.targets.issues.join(' ')).toContain('not widened to the whole repository');
  });
  it('applies file scope before preferring an exact global qualified name', async () => {
    const r = await retrieveExploreContext(cg, 'left/scoped.cpp ScopedWorker::run');
    expect(exact(r)).toHaveLength(1);
    expect(exact(r).every(n => n.qualifiedName === 'alpha::ScopedWorker::run')).toBe(true);
  });
  it('does not promote a callable before detecting an out-of-bounds line constraint', async () => {
    const r = await retrieveExploreContext(cg, 'left/worker.cpp:999 alpha::PacketWorker::run');
    expect(exact(r)).toEqual([]);
    expect(r.graph.nodes.size).toBe(0);
    expect(r.targets.issues.join(' ')).toContain('exceeds');
  });
  it.each(['left/worker.cpp:0', 'left/worker.cpp:-2', 'left/worker.cpp lines 0-4', 'left/worker.cpp#L1000001'])('reports invalid lines without converting them to a whole-file answer: %s', async query => {
    const r = await retrieveExploreContext(cg, query);
    expect(r.targets.spans.size).toBe(0);
    expect(r.graph.nodes.size).toBe(0);
    expect(r.targets.issues.join(' ')).toContain('Invalid line target');
  });
  it('reports the upstream reversed-range normalization explicitly', async () => {
    const r = await retrieveExploreContext(cg, 'left/worker.cpp:8-4');
    expect(r.targets.spans.get('left/worker.cpp')).toEqual([{ start: 4, end: 8 }]);
    expect(r.targets.issues.join(' ')).toContain('normalized to ascending');
  });
  it('treats a qualified destructor as one member target, not constructor or class fragments', async () => {
    const r = await retrieveExploreContext(cg, 'alpha::PacketWorker::~PacketWorker');
    expect(exact(r)).toHaveLength(1);
    expect(exact(r)[0]!.name).toBe('~PacketWorker');
    expect(exact(r)[0]!.isDeclaration).toBeFalsy();
    expect(r.diagnostics.seeds.map(s => s.token)).toEqual(['alpha::PacketWorker::~PacketWorker']);
  });
  it('reports unsupported qualified operators without seeding owner fragments', async () => {
    const r = await retrieveExploreContext(cg, 'alpha::PacketWorker::operator<<');
    expect(r.targets.matchQuery).toBe('');
    expect(r.graph.nodes.size).toBe(0);
    expect(r.targets.issues.join(' ')).toContain('requires a file and line reference');
  });
  it('does not expand a pure multi-line source range into siblings or cross-file callees', async () => {
    const r = await retrieveExploreContext(cg, 'range.ts:2-4');
    expect(r.targets.rangeOnly).toBe(true);
    expect(r.targets.spans.get('range.ts')).toEqual([{ start: 2, end: 4 }]);
    expect(r.diagnostics.targets.baseNodes).toBe(0);
    expect([...r.graph.nodes.values()].map(n => n.name)).toEqual(['requestedBody']);
    expect([...r.graph.nodes.values()].every(n => n.filePath === 'range.ts')).toBe(true);
    expect(r.graph.roots).toEqual([]);
    const header = await retrieveExploreContext(cg, 'left/worker.h:4-5');
    expect(header.targets.rangeOnly).toBe(true);
    expect([...header.graph.nodes.values()].every(n => n.filePath === 'left/worker.h' && !!n.isDeclaration)).toBe(true);
    const nonCallable = await retrieveExploreContext(cg, 'plain.ts:1-2');
    expect(nonCallable.targets.rangeOnly).toBe(true);
    expect(nonCallable.graph.nodes.size).toBe(0);
    expect(nonCallable.targets.spans.get('plain.ts')).toEqual([{ start: 1, end: 2 }]);
    expect((await retrieveExploreContext(cg, 'range.ts')).targets.rangeOnly).toBe(false);
    expect((await retrieveExploreContext(cg, 'range.ts:3')).targets.rangeOnly).toBe(false);
    expect((await retrieveExploreContext(cg, 'range.ts:2-4 requestedBody')).targets.rangeOnly).toBe(false);
    expect((await retrieveExploreContext(cg, 'range.ts:2-4 plain.ts')).targets.rangeOnly).toBe(false);
  });
});
