import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { ReferenceResolver } from '../src/resolution';

const projects: Array<{ root: string; graph: CodeGraph }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { root, graph } of projects.splice(0)) {
    await graph.whenIdle(); graph.close(); await graph.whenIdle();
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

const header = `namespace atlas {
namespace storage {
struct Base { int read(int value) const; };
struct Store : Base {};
}
namespace service {
class Manager {
  storage::Store store_;
public:
  int run(int value);
};
}
}
`;
const caller = `#include "types.h"
using namespace atlas;
using namespace service;
int Manager::run(int value) {
  return store_.read(value);
}
`;

function createProject(files: Record<string, string>) {
  for (const key of ['CODEGRAPH_RUST_SCAN', 'CODEGRAPH_RUST_MACROS', 'CODEGRAPH_RUST_GIT_IGNORE']) vi.stubEnv(key, '0');
  vi.stubEnv('CODEGRAPH_PARSE_WORKERS', '1'); vi.stubEnv('CODEGRAPH_RESOLVE_WORKERS', '1');
  vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-relative-member-'));
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, file), text);
  const graph = CodeGraph.initSync(root);
  projects.push({ root, graph });
  return { root, graph };
}

function targets(graph: CodeGraph) {
  return graph.getExploreQueryConnection().prepare(`SELECT t.qualified_name name, t.file_path file, t.is_declaration declaration
    FROM edges e JOIN nodes s ON e.source=s.id JOIN nodes t ON e.target=t.id
    WHERE s.file_path='caller.cpp' AND s.name='run' AND e.kind='calls' AND e.line=5
    ORDER BY t.id`).all();
}

it('fresh indexing resolves the inherited receiver on the first resolution pass', async () => {
  const { graph } = createProject({ 'types.h': header, 'caller.cpp': caller });
  const admissions: string[][] = [];
  const original = ReferenceResolver.prototype.resolveAll;
  vi.spyOn(ReferenceResolver.prototype, 'resolveAll').mockImplementation(function (...args) {
    const result = original.apply(this, args);
    if (args[0].some(r => r.filePath === 'caller.cpp' && r.referenceName === 'store_.read')) {
      admissions.push(result.resolved.filter(r => r.original.filePath === 'caller.cpp'
        && r.original.referenceName === 'store_.read').map(r => r.targetNodeId));
    }
    return result;
  });
  const result = await graph.indexAll();
  expect(result.complete).toBe(true); expect(result.filesErrored).toBe(0);
  const target = graph.getExploreQueryConnection().prepare(`SELECT id FROM nodes
    WHERE qualified_name='atlas::storage::Base::read' AND is_declaration=1`).get() as { id: string };
  expect(admissions[0]).toEqual([target.id]);
  expect(targets(graph)).toEqual([{ name: 'atlas::storage::Base::read', file: 'types.h', declaration: 1 }]);
});

it('sync invalidates recovered identities when namespace imports change and restores them', async () => {
  const { root, graph } = createProject({ 'types.h': header, 'caller.cpp': caller });
  expect((await graph.indexAll()).complete).toBe(true);
  expect(targets(graph)).toHaveLength(1);
  fs.writeFileSync(path.join(root, 'caller.cpp'), caller.replace('using namespace service;', '// removed namespace import'));
  await graph.sync();
  expect(targets(graph)).toEqual([]);
  fs.writeFileSync(path.join(root, 'caller.cpp'), caller);
  await graph.sync();
  expect(targets(graph)).toEqual([{ name: 'atlas::storage::Base::read', file: 'types.h', declaration: 1 }]);
});
