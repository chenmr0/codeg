import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { DatabaseConnection, DatabaseOpenError } from '../src/db';
import { getCodeGraphDir } from '../src/directory';
import { PortableCoordinator, PortableBusyError, type PortableLease } from '../src/sync/portable/protocol';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
const retained = (CodeGraph as any).failedPortableInitializations as Map<PortableLease, DatabaseConnection>;
const baseline = new Set(retained.keys());
afterEach(async () => {
  // Remove the injected close failure first. Do not release a fence while even
  // the test's real SQLite handle remains open.
  vi.restoreAllMocks();
  for (const graph of graphs.splice(0)) { await graph.whenIdle(); graph.close(); await graph.whenIdle(); }
  for (const [lease, connection] of retained) {
    if (baseline.has(lease)) continue;
    connection.close(); await connection.whenIdle();
    expect(connection.isOpen()).toBe(false);
    lease.release(); retained.delete(lease);
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-portable-init-lifetime-'));
  roots.push(dir); return dir;
}

it.each([
  ['sync', 'initialize'], ['async', 'initialize'], ['sync', 'close'], ['async', 'close'],
] as const)('%s init retains its writer fence after native %s failure', async (mode, failure) => {
  const directory = root();
  const initialize = DatabaseConnection.initialize.bind(DatabaseConnection);
  let native: DatabaseConnection | undefined;
  let idle: ReturnType<typeof vi.spyOn> | undefined;
  vi.spyOn(DatabaseConnection, 'initialize').mockImplementation(file => {
    native = initialize(file);
    idle = vi.spyOn(native, 'whenIdle');
    vi.spyOn(native, 'close').mockImplementation(() => { throw new Error('injected native close failure'); });
    if (failure === 'initialize') throw new DatabaseOpenError(native, new Error('injected schema failure'), new Error('injected close failure'));
    return native;
  });
  if (mode === 'sync') expect(() => CodeGraph.initSync(directory)).toThrow();
  else await expect(CodeGraph.init(directory)).rejects.toThrow();
  expect(native!.isOpen()).toBe(true);
  expect([...retained.values()]).toContain(native);
  const competitor = new PortableCoordinator(getCodeGraphDir(directory));
  expect(() => competitor.acquireWriter()).toThrow(PortableBusyError);
  if (mode === 'async' && failure === 'close') expect(idle).toHaveBeenCalledOnce();
});

it.each(['sync', 'async'] as const)('%s init can release its fence when close throws after actually closing', async mode => {
  const directory = root();
  const initialize = DatabaseConnection.initialize.bind(DatabaseConnection);
  vi.spyOn(DatabaseConnection, 'initialize').mockImplementation(file => {
    const native = initialize(file), close = native.close.bind(native);
    vi.spyOn(native, 'close').mockImplementation(() => { close(); throw new Error('after-close diagnostic'); });
    return native;
  });
  if (mode === 'sync') expect(() => CodeGraph.initSync(directory)).toThrow('after-close diagnostic');
  else await expect(CodeGraph.init(directory)).rejects.toThrow('after-close diagnostic');
  const lease = new PortableCoordinator(getCodeGraphDir(directory)).acquireWriter();
  lease.release();
});

it('normal initSync permits immediate synchronous mutation without a deferred unlock', () => {
  const directory = root();
  const graph = CodeGraph.initSync(directory); graphs.push(graph);
  expect(graph).not.toBeInstanceOf(Promise);
  const lease = new PortableCoordinator(getCodeGraphDir(directory)).acquireWriter();
  lease.release();
  expect(() => graph.clear()).not.toThrow();
  expect(graph.getStats().nodeCount).toBe(0);
});
