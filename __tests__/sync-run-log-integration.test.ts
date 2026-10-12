import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { SyncRunLog } from '../src/sync/run-log';

const roots: string[] = [], graphs: CodeGraph[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const g of graphs.splice(0)) g.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
async function fixture(dir?: string) {
  if (dir) vi.stubEnv('CODEGRAPH_DIR', dir);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-project-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'private-source.c'), 'int private_symbol(void){return 1;}\n');
  const graph = CodeGraph.initSync(root); graphs.push(graph); await graph.indexAll();
  const dbPath = (graph as any).db.getPath() as string;
  return { root, graph, logs: path.join(path.dirname(dbPath), 'logs'), internal: graph as any };
}
function completed(logs: string) { return fs.readdirSync(logs).filter(n => /^codegraph-sync-v1-\d{13}-[a-f0-9]{32}\.log$/.test(n)); }

describe('default sync log integration', () => {
  it('writes anonymous stage and final records without adding terminal summary by default', async () => {
    const f = await fixture(); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await f.graph.sync();
    const files = completed(f.logs); expect(files).toHaveLength(1);
    const text = fs.readFileSync(path.join(f.logs, files[0]), 'utf8');
    expect(text).toContain('outcome=success'); expect(text).toContain('phase=');
    expect(text).not.toMatch(/secret-project|private-source|private_symbol/);
    expect(log.mock.calls.flat().some(v => String(v).startsWith('[sync-summary]'))).toBe(false);
  });
  it.each(['0', 'false', ' FALSE '])('can fully disable persistent logging with %s while keeping opt-in terminal summaries', async value => {
    const f = await fixture(); vi.stubEnv('CODEGRAPH_SYNC_LOG', value);
    let lines: readonly string[] = [];
    await f.graph.sync({ diagnosticsSummary: value => { lines = value; } });
    expect(fs.existsSync(f.logs)).toBe(false); expect(lines).toHaveLength(8);
  });
  it('uses the configured database directory', async () => {
    const f = await fixture('.codegraph-separate'); await f.graph.sync();
    expect(completed(f.logs)).toHaveLength(1);
    expect(fs.existsSync(path.join(f.root, '.codegraph-wx', 'logs'))).toBe(false);
  });
  it('uses an existing legacy database directory', async () => {
    const f = await fixture(); f.graph.close(); graphs.splice(graphs.indexOf(f.graph), 1);
    fs.renameSync(path.join(f.root, '.codegraph-wx'), path.join(f.root, '.codegraph'));
    const g = CodeGraph.openSync(f.root); graphs.push(g); await g.sync();
    expect(completed(path.join(f.root, '.codegraph', 'logs'))).toHaveLength(1);
    expect(fs.existsSync(path.join(f.root, '.codegraph-wx'))).toBe(false);
  });
  it('emits final failure status while preserving the original sync error', async () => {
    const f = await fixture(); const original = new Error('private-source secret error');
    vi.spyOn(f.internal.orchestrator, 'sync').mockRejectedValueOnce(original);
    await expect(f.graph.sync()).rejects.toBe(original);
    const text = fs.readFileSync(path.join(f.logs, completed(f.logs)[0]), 'utf8');
    expect(text).toContain('outcome=error'); expect(text).not.toContain(original.message);
  });
  it('does not create a log when the index write lock is unavailable', async () => {
    const f = await fixture(); vi.spyOn(f.internal.fileLock, 'acquire').mockImplementation(() => { throw new Error('busy'); });
    await expect(f.graph.sync()).resolves.toMatchObject({ durationMs: 0 });
    expect(fs.existsSync(f.logs)).toBe(false);
  });
  it('does not let an unexpected logger failure mask the sync exception', async () => {
    const f = await fixture(); const original = new Error('original sync exception');
    const finish = SyncRunLog.prototype.finish;
    vi.spyOn(SyncRunLog.prototype, 'finish').mockImplementation(async function(this: SyncRunLog) { await finish.call(this); throw new Error('log failure'); });
    vi.spyOn(f.internal.orchestrator, 'sync').mockRejectedValueOnce(original);
    await expect(f.graph.sync()).rejects.toBe(original);
  });
});
