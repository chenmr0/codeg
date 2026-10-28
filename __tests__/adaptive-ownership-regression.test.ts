import { afterEach, it, expect, vi } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import CodeGraph from '../src/index';
import { isSourceOwned } from '../src/sync/source-ownership';
const roots: string[] = [], graphs: CodeGraph[] = [];
afterEach(() => { for (const graph of graphs.splice(0)) graph.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-owner-regression-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'main.c'), 'int first(void) { return 1; }\n');
  const graph = CodeGraph.initSync(root); graphs.push(graph);
  expect((await graph.indexAll()).complete).toBe(true);
  expect(isSourceOwned((graph as any).db.getDb())).toBe(true);
  return { root, graph };
}
it('retains source ownership after complete indexFiles and a subsequent edit', async () => {
  const { root, graph } = await fixture();
  fs.writeFileSync(path.join(root, 'main.c'), 'int updated(void) { return 222; }\n');
  const result = await graph.indexFiles(['main.c']);
  expect(result.success).toBe(true); expect(result.complete).toBe(true);
  expect(isSourceOwned((graph as any).db.getDb())).toBe(true);
});
it('does not restore source ownership for partial indexFiles', async () => {
  const { graph } = await fixture();
  vi.spyOn((graph as any).orchestrator, 'indexFiles').mockResolvedValue({ success: true, complete: false,
    filesIndexed: 1, filesErrored: 1, filesSkipped: 0, nodesCreated: 1, edgesCreated: 0, errors: [], durationMs: 1 });
  expect((await graph.indexFiles(['main.c'])).complete).toBe(false);
  expect(isSourceOwned((graph as any).db.getDb())).toBe(false);
});
it('keeps exactly one ownership write scope during complete language-scope fallback rebuild', async () => {
  vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
  const { graph } = await fixture();
  vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', undefined);
  const result = await graph.sync({ adaptive: false });
  expect(result.complete).toBe(true);
  expect(isSourceOwned((graph as any).db.getDb())).toBe(true);
});
