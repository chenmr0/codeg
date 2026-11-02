/** Failure paths for the initial private build, using the actual SDK lifecycle. */
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import CodeGraph from '../src/index';
import { DatabaseConnection } from '../src/db';
import { getCodeGraphDir } from '../src/directory';
import { PortableCoordinator, PortableBusyError, type PortableLease } from '../src/sync/portable/protocol';

const roots: string[] = [], graphs: CodeGraph[] = [];
const retained = (CodeGraph as any).failedPortableBuilds as Map<PortableLease, CodeGraph | DatabaseConnection>;
const baseline = new Set(retained.keys());
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const graph of graphs.splice(0)) { await graph.whenIdle(); graph.close(); await graph.whenIdle(); }
  for (const [lease, resource] of retained) {
    if (baseline.has(lease)) continue;
    const connection = resource instanceof DatabaseConnection ? resource : (resource as any).db;
    if (connection.isOpen()) resource.close();
    await resource.whenIdle();
    expect(connection.isOpen()).toBe(false);
    lease.release(); retained.delete(lease);
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fast-init-extra-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'main.c'), 'int lifecycle_symbol(void) { return 3; }\n');
  vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
  return root;
}
function assertActiveEmpty(root: string) {
  const reader = CodeGraph.openReadOnlySync(root); graphs.push(reader);
  expect(reader.getStats().nodeCount).toBe(0);
  expect(reader.searchNodes('lifecycle_symbol')).toEqual([]);
  return reader;
}

it.each(['close', 'drain'] as const)('retains writer ownership after candidate factory %s failure', async failure => {
  const root = fixture(), initialize = DatabaseConnection.initialize.bind(DatabaseConnection);
  let candidate: DatabaseConnection | undefined;
  vi.spyOn(DatabaseConnection, 'initialize').mockImplementation(file => {
    const db = initialize(file);
    if (path.basename(file) === 'candidate.db') {
      candidate = db;
      if (failure === 'close') vi.spyOn(db, 'close').mockImplementation(() => { throw new Error('injected candidate close failure'); });
      else vi.spyOn(db, 'whenIdle').mockRejectedValue(new Error('injected candidate drain failure'));
    }
    return db;
  });
  await expect(CodeGraph.init(root, { index: true })).rejects.toThrow();
  expect(candidate).toBeDefined();
  expect([...retained.values()].some(value => value === candidate)).toBe(true);
  const competitor = new PortableCoordinator(getCodeGraphDir(root));
  expect(() => competitor.acquireWriter()).toThrow(PortableBusyError);
  assertActiveEmpty(root);
}, 30000);

it('retains the complete candidate graph and writer when final native close fails', async () => {
  const root = fixture(), create = CodeGraph.createPortableCandidate.bind(CodeGraph);
  let candidate: CodeGraph | undefined;
  vi.spyOn(CodeGraph, 'createPortableCandidate').mockImplementation(async (root, file) => {
    const graph = candidate = await create(root, file);
    vi.spyOn((graph as any).db, 'close').mockImplementation(() => { throw new Error('injected final candidate close failure'); });
    return graph;
  });
  await expect(CodeGraph.init(root, { index: true })).rejects.toThrow('injected final candidate close failure');
  expect([...retained.values()].some(value => value === candidate)).toBe(true);
  expect(() => new PortableCoordinator(getCodeGraphDir(root)).acquireWriter()).toThrow(PortableBusyError);
  assertActiveEmpty(root);
}, 30000);

it('cancellation before publication leaves a recoverable active schema and permits a later durable index', async () => {
  const root = fixture(), controller = new AbortController();
  await expect(CodeGraph.init(root, {
    index: true, signal: controller.signal,
    onProgress: () => controller.abort(),
  })).rejects.toThrow();
  const coordinator = new PortableCoordinator(getCodeGraphDir(root)); coordinator.recover();
  const lease = coordinator.acquireWriter(); lease.release();
  const reader = assertActiveEmpty(root);
  reader.close(); await reader.whenIdle(); graphs.splice(graphs.indexOf(reader), 1);
  const graph = CodeGraph.openSync(root); graphs.push(graph);
  expect((await graph.indexAll()).success).toBe(true);
  expect(graph.searchNodes('lifecycle_symbol').length).toBeGreaterThan(0);
}, 30000);

it('preserves the initial full-cost sample after publishing the candidate', async () => {
  const root = fixture(), graph = await CodeGraph.init(root, { index: true }); graphs.push(graph);
  const history = JSON.parse(graph.getPortableCostHistory()!);
  expect(history.version).toBe(1);
  expect(history.samples.some((sample: any) => sample.kind === 'full' && sample.durationMs > 0)).toBe(true);
}, 30000);

it('continues to publish and return success with explicitly incomplete coverage', async () => {
  const root = fixture(), create = CodeGraph.createPortableCandidate.bind(CodeGraph);
  vi.spyOn(CodeGraph, 'createPortableCandidate').mockImplementation(async (root, file) => {
    const graph = await create(root, file), indexAll = graph.indexAll.bind(graph);
    vi.spyOn(graph, 'indexAll').mockImplementation(async options => {
      const result = await indexAll(options);
      (graph as any).queries.setMetadata('index_completeness', 'incomplete');
      return { ...result, success: true, complete: false };
    });
    return graph;
  });
  const observed = vi.fn();
  const graph = await CodeGraph.init(root, { index: true, onIndexResult: observed }); graphs.push(graph);
  expect(observed).toHaveBeenCalledOnce();
  expect(observed.mock.calls[0][0]).toMatchObject({ success: true, complete: false });
  expect(graph.getIndexCompleteness().status).toBe('incomplete');
  expect(graph.searchNodes('lifecycle_symbol').length).toBeGreaterThan(0);
}, 30000);


it('recovers cancelled initial indexing through the real CLI index command without deleting active storage', async () => {
  const root = fixture(), controller = new AbortController();
  await expect(CodeGraph.init(root, {
    index: true, signal: controller.signal, onProgress: () => controller.abort(),
  })).rejects.toThrow();
  const active = path.join(getCodeGraphDir(root), 'codegraph.db'), inode = fs.statSync(active).ino;
  const cli = path.resolve(__dirname, '../dist/bin/codegraph.js');
  const options = {
    cwd: root, encoding: 'utf8' as const, input: '', timeout: 30000,
    env: { ...process.env, CI: '1', CODEGRAPH_ALLOW_UNSAFE_NODE: '1', CODEGRAPH_NO_WATCH: '1', CODEGRAPH_NO_DAEMON: '1' },
  };
  const init = spawnSync(process.execPath, ['--liftoff-only', cli, 'init', root], options);
  expect(init.status, init.stdout + init.stderr).toBe(0);
  expect(init.stdout + init.stderr).toMatch(/Already initialized/i);
  expect(fs.statSync(active).ino).toBe(inode);
  const index = spawnSync(process.execPath, ['--liftoff-only', cli, 'index', root, '--quiet'], options);
  expect(index.status, index.stdout + index.stderr).toBe(0);
  expect(fs.statSync(active).ino).toBe(inode);
  const graph = CodeGraph.openReadOnlySync(root); graphs.push(graph);
  expect(graph.searchNodes('lifecycle_symbol').length).toBeGreaterThan(0);
  expect(graph.getIndexCompleteness().status).toBe('complete');
}, 60000);
