import { afterEach, it, expect, vi } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import CodeGraph from '../src/index';
import { getCodeGraphDir } from '../src/directory';
import { isSourceOwned } from '../src/sync/source-ownership';
import { PortableCoordinator, type PortableLease } from '../src/sync/portable/protocol';
const roots: string[] = [], graphs: CodeGraph[] = [], leases: PortableLease[] = [];
afterEach(async () => {
  // Native maintenance must exit before releasing the enclosing connection lease.
  for (const graph of graphs.splice(0)) { await graph.whenIdle(); graph.close(); await graph.whenIdle(); }
  for (const lease of leases.splice(0).reverse()) lease.release();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function fixture(rawCore = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-owner-regression-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'main.c'), 'int first(void) { return 1; }\n');
  let graph = CodeGraph.initSync(root);
  if (rawCore) {
    // These unit tests inject a partial orchestrator result. The public facade
    // deliberately hides its private state and creates a fresh core per write.
    // Hold the same real leases as production while testing the core scope.
    graph.close(); await graph.whenIdle();
    const coordinator = new PortableCoordinator(getCodeGraphDir(root));
    leases.push(coordinator.acquireWriter(), coordinator.acquireReader());
    graph = CodeGraph.openPortableRaw(root, coordinator.active, false);
  }
  graphs.push(graph);
  expect((await graph.indexAll()).complete).toBe(true);
  expect(owned(graph, rawCore)).toBe(true);
  return { root, graph };
}
function owned(graph: CodeGraph, rawCore: boolean): boolean {
  if (rawCore) return isSourceOwned((graph as any).db.getDb());
  // Read ownership through a supported public pin, never a facade private stub.
  const pin = graph.acquirePortableRead();
  try { return isSourceOwned((pin.graph as any).db.getDb()); }
  finally { pin.release(); }
}
it('raw core retains source ownership after complete indexFiles and a subsequent edit', async () => {
  const { root, graph } = await fixture();
  fs.writeFileSync(path.join(root, 'main.c'), 'int updated(void) { return 222; }\n');
  const result = await graph.indexFiles(['main.c']);
  expect(result.success).toBe(true); expect(result.complete).toBe(true);
  expect(owned(graph, true)).toBe(true);
});
it('raw core does not restore source ownership for partial indexFiles', async () => {
  const { graph } = await fixture();
  vi.spyOn((graph as any).orchestrator, 'indexFiles').mockResolvedValue({ success: true, complete: false,
    filesIndexed: 1, filesErrored: 1, filesSkipped: 0, nodesCreated: 1, edgesCreated: 0, errors: [], durationMs: 1 });
  expect((await graph.indexFiles(['main.c'])).complete).toBe(false);
  expect(owned(graph, true)).toBe(false);
});
it('raw core keeps exactly one ownership write scope during complete language-scope fallback rebuild', async () => {
  vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
  const { graph } = await fixture();
  vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', undefined);
  const result = await graph.sync({ adaptive: false });
  expect(result.complete).toBe(true);
  expect(owned(graph, true)).toBe(true);
});
it('public portable facade preserves ownership after real targeted indexing and sync', async () => {
  const { root, graph } = await fixture(false);
  fs.writeFileSync(path.join(root, 'main.c'), 'int updated(void) { return 222; }\n');
  const result = await graph.indexFiles(['main.c']);
  expect(result.success).toBe(true); expect(result.complete).toBe(true);
  expect(owned(graph, false)).toBe(true);
  fs.writeFileSync(path.join(root, 'main.c'), 'int changed_again(void) { return 333; }\n');
  expect((await graph.sync({ adaptive: false })).complete).toBe(true);
  expect(owned(graph, false)).toBe(true);
});
it('public portable facade does not restore ownership after real partial targeted indexing', async () => {
  const { root, graph } = await fixture(false);
  fs.writeFileSync(path.join(root, 'main.c'), 'int updated(void) { return 222; }\n');
  const result = await graph.indexFiles(['main.c', 'missing.c']);
  expect(result.success).toBe(true); expect(result.complete).toBe(false);
  expect(result.filesErrored).toBe(1);
  expect(owned(graph, false)).toBe(false);
});
it('public portable language-scope fallback preserves ownership', async () => {
  vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
  const { graph } = await fixture(false);
  vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', undefined);
  expect((await graph.sync({ adaptive: false })).complete).toBe(true);
  expect(owned(graph, false)).toBe(true);
});
