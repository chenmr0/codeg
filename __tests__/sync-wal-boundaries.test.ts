import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection } from '../src/db';
import { WalCheckpointValve, WalValveAbortError } from '../src/db/wal-valve';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const graph of graphs.splice(0)) { try { graph.close(); } catch {} }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-boundary-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'api.c'), 'int api(void) { return 1; }\n');
  fs.writeFileSync(path.join(root, 'caller.c'), 'int api(void); int caller(void) { return api(); }\n');
  fs.writeFileSync(path.join(root, 'gone.c'), 'int gone(void) { return 2; }\n');
  const graph = CodeGraph.initSync(root); graphs.push(graph);
  const connection = (graph as unknown as { db: DatabaseConnection }).db;
  return { root, graph, connection, db: connection.getDb() };
}
function change(root: string) {
  fs.unlinkSync(path.join(root, 'gone.c'));
  fs.writeFileSync(path.join(root, 'api.c'), 'int api(void) { return 1234; }\n');
  fs.writeFileSync(path.join(root, 'new.c'), 'int newer(void) { return 3; }\n');
  fs.writeFileSync(path.join(root, 'caller.c'), 'int api(void); int caller(void) { return api()+api(); }\n');
}
function snapshot(db: ReturnType<DatabaseConnection['getDb']>) {
  return {
    nodes: db.prepare('SELECT id,kind,name,qualified_name,file_path,signature FROM nodes ORDER BY id').all(),
    edges: db.prepare('SELECT source,target,kind,metadata,line,col,provenance FROM edges ORDER BY source,target,kind,line,col').all(),
    refs: db.prepare('SELECT from_node_id,reference_name,reference_kind,file_path,status FROM unresolved_refs ORDER BY from_node_id,reference_name,reference_kind').all(),
  };
}

describe('production WAL gates preserve sync and recovery', () => {
  it('matches the existing no-deferral path and checkpoints only at transaction-free boundaries', async () => {
    const snapshots: unknown[] = [];
    for (const disabled of [true, false]) {
      vi.stubEnv('CODEGRAPH_NO_WAL_DEFER', disabled ? '1' : '0');
      const { root, graph, connection, db } = fixture();
      await graph.indexAll();
      let gates = 0, checkpoints = 0;
      const original = connection.checkpointWalPassive.bind(connection);
      vi.spyOn(connection, 'checkpointWalPassive').mockImplementation(async () => {
        db.exec('BEGIN'); db.exec('ROLLBACK'); checkpoints++;
        return original();
      });
      vi.spyOn(WalCheckpointValve.prototype, 'backpressure').mockImplementation(function () {
        gates++;
        return this.foldNow();
      });
      change(root);
      await expect(graph.sync()).resolves.toMatchObject({ filesAdded: 1, filesRemoved: 1, filesModified: 2 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      snapshots.push(snapshot(db));
      if (disabled) expect(gates).toBe(0);
      else { expect(gates).toBeGreaterThanOrEqual(4); expect(checkpoints).toBeGreaterThanOrEqual(4); }
      graph.close(); graphs.splice(graphs.indexOf(graph), 1);
      vi.restoreAllMocks();
    }
    expect(snapshots[1]).toEqual(snapshots[0]);
  }, 30000);

  it('propagates a deletion gate failure, restores policy and resumes remaining files', async () => {
    const { root, graph, connection, db } = fixture();
    await graph.indexAll();
    const interval = connection.getWalAutocheckpoint();
    change(root);
    const gate = vi.spyOn(WalCheckpointValve.prototype, 'backpressure').mockRejectedValueOnce(
      new WalValveAbortError('pinned reader', 3, 2));
    await expect(graph.sync()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });
    expect(connection.getWalAutocheckpoint()).toBe(interval);
    gate.mockRestore();
    await graph.sync();
    expect(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE name='newer'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM files WHERE path='gone.c'").get()).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }, 30000);

  it('preserves the pre-store retry journal across a failed write gate and drains it on retry', async () => {
    vi.stubEnv('CODEGRAPH_NO_APPEND_DELTA', '1');
    const { root, graph, connection, db } = fixture();
    await graph.indexAll();
    const interval = connection.getWalAutocheckpoint();
    fs.writeFileSync(path.join(root, 'api.c'), 'int api(void) { return 1234567; }\n');
    const gate = vi.spyOn(WalCheckpointValve.prototype, 'backpressure').mockRejectedValueOnce(
      new WalValveAbortError('pinned reader', 3, 2));
    await expect(graph.sync()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });
    expect(connection.getWalAutocheckpoint()).toBe(interval);
    expect((db.prepare("SELECT COUNT(*) AS n FROM project_metadata WHERE key LIKE 'sync-retry:pending:%'").get() as { n: number }).n).toBeGreaterThan(0);
    gate.mockRestore();
    await graph.sync();
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_metadata WHERE key LIKE 'sync-retry:pending:%'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM unresolved_refs WHERE status='pending'").get()).toEqual({ n: 0 });
  }, 30000);

  it('restores non-fresh indexAll policy on fatal checkpoint errors and can retry', async () => {
    const { root, graph, connection } = fixture();
    await graph.indexAll();
    const interval = connection.getWalAutocheckpoint();
    fs.writeFileSync(path.join(root, 'api.c'), 'int api(void) { return 7890; }\n');
    const gate = vi.spyOn(WalCheckpointValve.prototype, 'backpressure').mockRejectedValueOnce(
      new WalValveAbortError('pinned reader', 3, 2));
    await expect(graph.indexAll()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });
    expect(connection.getWalAutocheckpoint()).toBe(interval);
    gate.mockRestore();
    await expect(graph.indexAll()).resolves.toMatchObject({ success: true });
  }, 30000);

  it('leaves fresh MEMORY/OFF construction outside the valve and restores WAL/NORMAL', async () => {
    const { graph, connection } = fixture();
    const gate = vi.spyOn(WalCheckpointValve.prototype, 'backpressure');
    const fold = vi.spyOn(WalCheckpointValve.prototype, 'foldNow');
    await expect(graph.indexAll()).resolves.toMatchObject({ success: true });
    expect(gate).not.toHaveBeenCalled();
    expect(fold).not.toHaveBeenCalled();
    expect(connection.getJournalMode()).toBe('wal');
    expect(connection.getDb().pragma('synchronous', { simple: true })).toBe(1);
  }, 30000);
});
