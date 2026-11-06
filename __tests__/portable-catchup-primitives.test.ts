import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
const { DatabaseConnection } = require('../dist/db');
const { QueryBuilder } = require('../dist/db/queries');
const { ExtractionOrchestrator } = require('../dist/extraction');
const { SEMANTIC_CONFIG_KEY, semanticConfigFingerprint } = require('../dist/sync/index-policy');
const { EXTRACTION_VERSION } = require('../dist/extraction/extraction-version');
const { adaptiveConfigFingerprint, adaptiveRuntimeKey } = require('../dist/sync/adaptive-plan');
const { resolveSyncPolicy } = require('../dist/sync/sync-policy');
const { installSourceOwnership, beginSourceWrite, finishSourceWrite } = require('../dist/sync/source-ownership');
const roots: string[] = [];
const connections: any[] = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) { connection.close(); await connection.whenIdle(); }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-portable-catchup-'));
  roots.push(root);
  const file = path.join(root, 'sample.ts');
  fs.writeFileSync(file, 'export function alpha() { return 1; }\n');
  const dbPath = path.join(root, '.codegraph-wx', 'codegraph.db');
  const connection = DatabaseConnection.initialize(dbPath); connections.push(connection);
  expect(installSourceOwnership(connection.getDb())).toBe(true);
  const write = beginSourceWrite(connection.getDb());
  const queries = new QueryBuilder(connection.getDb());
  const orchestrator = new ExtractionOrchestrator(root, queries);
  await orchestrator.indexFile('sample.ts');
  queries.setMetadata('adaptive:index-config-v1', adaptiveConfigFingerprint(root, queries.getAllFiles()));
  queries.setMetadata(SEMANTIC_CONFIG_KEY, semanticConfigFingerprint(root, queries.getAllFiles()));
  queries.setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION));
  expect(finishSourceWrite(connection.getDb(), write, true)).toBe(true);
  return { root, file, dbPath, connection, queries, orchestrator };
}
function evaluate(root: string, databasePath: string, extra: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    let response: any;
    const worker = new Worker(path.resolve(__dirname, '../dist/sync/rebuild-validation-worker.js'), {
      workerData: { parentExecArgv: process.execArgv, job: { type: 'evaluate', root, databasePath, eligibility: {}, portable: true, fullHash: true, ...extra } },
    });
    worker.once('message', value => { response = value; });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0 || response?.error || !response) reject(new Error(response?.error ?? `worker exited ${code}`));
      else resolve(response.result);
    });
  });
}
describe('portable catch-up primitives', () => {
  it('forces equal-stat content changes through reconciliation', async () => {
    const f = await fixture();
    const stat = fs.statSync(f.file);
    fs.writeFileSync(f.file, 'export function bravo() { return 2; }\n');
    fs.utimesSync(f.file, stat.atime, stat.mtime);
    const result = await f.orchestrator.sync(undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, ['sample.ts']);
    expect(result.filesModified).toBe(1);
    const names = f.connection.getDb().prepare('SELECT name FROM nodes').all().map((row: any) => row.name);
    expect(names).toContain('bravo'); expect(names).not.toContain('alpha');
  });
  it('forces equal-hash storage through the worker replacement interface', async () => {
    const f = await fixture();
    f.connection.getDb().prepare("UPDATE nodes SET name='stale' WHERE name='alpha'").run();
    const result = await f.orchestrator.sync(undefined, undefined, false,
      async (request: any) => f.orchestrator.storeParsedReplacement(request),
      undefined, undefined, undefined, undefined, ['sample.ts']);
    expect(result.filesModified).toBe(1);
    const names = f.connection.getDb().prepare('SELECT name FROM nodes').all().map((row: any) => row.name);
    expect(names).toContain('alpha'); expect(names).not.toContain('stale');
  });
  it('uses a full-hash threshold for a portable cache with historical guards and no owner marker', async () => {
    const f = await fixture();
    const db = f.connection.getDb();
    db.prepare("DELETE FROM project_metadata WHERE key='adaptive:source-owner-v1'").run();
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name GLOB 'adaptive_owner_*'").get().n).toBe(18);
    const stat = fs.statSync(f.file);
    fs.writeFileSync(f.file, 'export function bravo() { return 2; }\n');
    fs.utimesSync(f.file, stat.atime, stat.mtime);
    const threshold = { eligibility: { fallback: { minChangedFiles: 1 } } };
    const result = await evaluate(f.root, f.dbPath, { paths: ['not-the-changed-file.ts'], ...threshold });
    expect(result.plan.modified).toEqual(['sample.ts']);
    expect(result.decision).toMatchObject({ strategy: 'rebuild', reason: 'structural-large-change' });
    const compatible = await evaluate(f.root, f.dbPath, { portable: false, ...threshold });
    expect(compatible.plan.modified).toEqual(['sample.ts']);
    expect(compatible.decision.reason).toContain('unverified-legacy-or-custom-index');
  });
  it.each([true, false])('ignores historical samples and damaged history when portable=%s', async portable => {
    const f = await fixture();
    const files = f.queries.getAllFiles();
    const common = {
      runtimeKey: adaptiveRuntimeKey(f.root, 'node-sqlite'),
      configFingerprint: adaptiveConfigFingerprint(f.root, files),
      semanticConfigFingerprint: semanticConfigFingerprint(f.root, files),
      totalFiles: 1, totalBytes: files[0].size, totalNodes: files[0].nodeCount,
      changedFiles: 1, affectedOldNodes: files[0].nodeCount, changedBytes: files[0].size,
      addedFiles: 0, modifiedFiles: 1, removedFiles: 0, shape: 'modified-only', recordedAt: Date.now(),
    };
    const local = { version: 1, samples: [
      { ...common, kind: 'full', durationMs: 1000 },
      ...Array.from({ length: 3 }, () => ({ ...common, kind: 'incremental', durationMs: 200000 })),
    ] };
    const write = beginSourceWrite(f.connection.getDb());
    f.queries.setMetadata('adaptive:cost-history-v1', JSON.stringify(local));
    expect(finishSourceWrite(f.connection.getDb(), write, true)).toBe(true);
    fs.writeFileSync(path.join(path.dirname(f.dbPath), 'adaptive-cost-history.json'), JSON.stringify({ version: 1, samples: [] }));
    fs.writeFileSync(f.file, 'export function bravo() { return 2; }\n');
    const decision = () => evaluate(f.root, f.dbPath, { portable });
    expect((await decision()).decision.strategy).toBe('incremental');
    const next = beginSourceWrite(f.connection.getDb());
    f.queries.setMetadata('adaptive:cost-history-v1', JSON.stringify({ version: 1, samples: local.samples.map(sample => ({ ...sample, runtimeKey: 'another-machine' })) }));
    expect(finishSourceWrite(f.connection.getDb(), next, true)).toBe(true);
    fs.writeFileSync(path.join(path.dirname(f.dbPath), 'adaptive-cost-history.json'), JSON.stringify(local));
    expect((await decision()).decision.strategy).toBe('incremental');
    const damaged = beginSourceWrite(f.connection.getDb());
    f.queries.setMetadata('adaptive:cost-history-v1', '{broken');
    expect(finishSourceWrite(f.connection.getDb(), damaged, true)).toBe(true);
    fs.writeFileSync(path.join(path.dirname(f.dbPath), 'adaptive-cost-history.json'), '{broken');
    expect((await decision()).decision.strategy).toBe('incremental');
    const rebuilt = await evaluate(f.root, f.dbPath, { portable, eligibility: { fallback: { minChangedFiles: 1 } } });
    expect(rebuilt.decision).toMatchObject({ strategy: 'rebuild', reason: 'structural-large-change' });
    expect(fs.readFileSync(path.join(path.dirname(f.dbPath), 'adaptive-cost-history.json'), 'utf8')).toBe('{broken');
    expect(f.queries.getMetadata('adaptive:cost-history-v1')).toBe('{broken');
  });

  it.each([true, false])('uses the admitted policy snapshot across a worker boundary when portable=%s', async portable => {
    const f = await fixture();
    fs.writeFileSync(f.file, 'export function changed() { return 1234; }\n');
    const policy = resolveSyncPolicy(f.root, { adaptiveFallback: { minChangedFiles: 1 } });
    fs.writeFileSync(path.join(f.root, '.codegraphrc.json'), JSON.stringify({ sync: { adaptive: { enabled: false } } }));
    const result = await evaluate(f.root, f.dbPath, { portable, policy, eligibility: { enabled: false } });
    expect(result.decision).toMatchObject({ strategy: 'rebuild', reason: 'structural-large-change' });
    const disabled = await evaluate(f.root, f.dbPath, {
      portable, policy: resolveSyncPolicy(f.root), eligibility: { fallback: { minChangedFiles: 1 } },
    });
    expect(disabled.decision.strategy).toBe('incremental');
  });

});
