/** Real publisher regression: source eligibility can change after candidate admission. */
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CodeGraph as Graph } from '../src';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { createAdaptivePlan } = require('../dist/sync/adaptive-plan') as typeof import('../src/sync/adaptive-plan');
const { DatabaseSync } = require('node:sqlite');
const roots: string[] = [];
const graphs: Graph[] = [];
const originalArgv = process.execArgv;
function dir() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-publication-links-')); roots.push(root); return root; }
function metadata(g: Graph, key: string) {
  const db = new DatabaseSync(g.getDatabaseFilePath(), { readOnly: true });
  try { return db.prepare('SELECT value FROM project_metadata WHERE key=?').get(key)?.value; } finally { db.close(); }
}
async function fixture() {
  process.execArgv = ['--liftoff-only'];
  const root = dir(), shared = dir();
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  fs.writeFileSync(path.join(root, 'local.c'), 'int local_original(void) { return 1; }\n');
  fs.writeFileSync(path.join(shared, 'remote.c'), 'int external_symbol(void) { return 2; }\n');
  vi.stubEnv('CODEGRAPH_ALLOWED_SOURCE_ROOTS', shared);
  const graph = await CodeGraph.init(root, { index: true }); graphs.push(graph);
  return { root, shared, graph };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const g of graphs.splice(0)) { g.close(); await g.whenIdle(); }
  process.execArgv = originalArgv;
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('retains the active database when an authorized link appears during candidate parsing, then syncs incrementally', async () => {
  const { root, shared, graph } = await fixture();
  const before = metadata(graph, 'portable:database-id-v1');
  fs.writeFileSync(path.join(root, 'local.c'), 'int local_updated(void) { return 123; }\n');
  vi.stubEnv('TEST_PUBLICATION_LINK_ROOT', shared);
  vi.stubEnv('NODE_OPTIONS', `--require="${path.resolve(__dirname, 'fixtures/link-during-portable-build.cjs')}"`);
  const result = await graph.sync({ adaptiveFallback: { minChangedFiles: 1, minChangedFraction: 0.01, minWorkFraction: 0.01 } });
  expect(result.complete).toBe(true);
  expect(fs.lstatSync(path.join(root, 'linked')).isSymbolicLink()).toBe(true);
  expect(metadata(graph, 'portable:database-id-v1')).toBe(before);
  expect(graph.getPortableCatchup()).toBeNull();
  expect(graph.getNodesByName('external_symbol')).toHaveLength(1);
  expect((await graph.sync({ adaptive: false })).complete).toBe(true);
}, 60_000);
it('recovers an already-published pending marker with authorized source links and full content verification', async () => {
  const { root, shared, graph } = await fixture();
  const oldId = metadata(graph, 'portable:database-id-v1');
  fs.writeFileSync(path.join(root, 'local.c'), 'int after_publication(void) { return 123; }\n');
  const publisher = require('../dist/sync/portable/publisher-client');
  const publish = publisher.runPortableRebuild;
  const abort = new AbortController();
  vi.spyOn(publisher, 'runPortableRebuild').mockImplementationOnce(async (...args) => {
    const result = await publish(...args);
    abort.abort();
    return result;
  });
  await expect(graph.sync({ signal: abort.signal,
    adaptiveFallback: { minChangedFiles: 1, minChangedFraction: 0.01, minWorkFraction: 0.01 },
  })).rejects.toThrow(/abort/i);
  expect(metadata(graph, 'portable:database-id-v1')).not.toBe(oldId);
  expect(graph.getPortableCatchup()).toBeTruthy();
  fs.symlinkSync(shared, path.join(root, 'linked'), 'junction');
  const result = await graph.sync({ adaptive: false });
  expect(result.complete).toBe(true);
  expect(graph.getPortableCatchup()).toBeNull();
  expect(graph.getNodesByName('external_symbol')).toHaveLength(1);
  expect((await graph.sync({ adaptive: false })).filesRemoved).toBe(0);
}, 60_000);
it('keeps ordinary fullHash publication eligibility closed for authorized links', async () => {
  const { root, shared, graph } = await fixture();
  fs.symlinkSync(shared, path.join(root, 'linked'), 'junction');
  await expect(createAdaptivePlan(root, graph.getFiles(), { runtimeKey: '', fullHash: true })).rejects.toThrow(/Symlink source/);
});

it('does not treat a link retarget during full reconciliation as a clean inventory', async () => {
  const { root, shared, graph } = await fixture();
  const outside = dir();
  fs.writeFileSync(path.join(outside, 'remote.c'), 'int secret_symbol(void) { return 9; }\n');
  fs.symlinkSync(shared, path.join(root, 'linked'), 'junction');
  await expect(createAdaptivePlan(root, graph.getFiles(), {
    runtimeKey: '', fullHash: true, reconcileAuthorizedLinks: true,
    observeContent(relative) {
      if (relative === 'linked/remote.c') {
        fs.unlinkSync(path.join(root, 'linked'));
        fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
      }
    },
  })).rejects.toThrow(/Source link changed/);
});
it('does not let the recovery flag bypass publication eligibility on a database without a pending marker', async () => {
  const { root, shared, graph } = await fixture();
  fs.symlinkSync(shared, path.join(root, 'linked'), 'junction');
  const { runAdaptiveReadWorker } = require('../dist/sync/rebuild-controller');
  await expect(runAdaptiveReadWorker({ type: 'evaluate', root, databasePath: graph.getDatabaseFilePath(),
    portable: true, fullHash: true, reconcileAuthorizedLinks: true, eligibility: {} })).rejects.toThrow(/Symlink source/);
});
it('hashes linked content during recovery even when size and mtime match the indexed record', async () => {
  const { root, shared, graph } = await fixture();
  fs.symlinkSync(shared, path.join(root, 'linked'), 'junction');
  expect((await graph.sync({ adaptive: false })).complete).toBe(true);
  const tracked = graph.getFiles();
  const remote = path.join(shared, 'remote.c');
  const previous = fs.statSync(remote);
  fs.writeFileSync(remote, fs.readFileSync(remote, 'utf8').replace('external_symbol', 'modified_symbol'));
  fs.utimesSync(remote, previous.atime, previous.mtime);
  const plan = await createAdaptivePlan(root, tracked, { runtimeKey: '', fullHash: true, reconcileAuthorizedLinks: true });
  expect(plan.modified).toContain('linked/remote.c');
});

it.skipIf(process.platform === 'win32')('retains a pending publication marker on real ignore EACCES, then verifies recovery after access returns', () => {
  const root = dir(), shared = dir();
  for (const directory of [root, shared]) fs.chmodSync(directory, 0o777);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  fs.writeFileSync(path.join(root, 'local.c'), 'int local_pending(void) { return 1; }\n');
  fs.writeFileSync(path.join(shared, 'remote.c'), 'int external_pending(void) { return 2; }\n');
  fs.symlinkSync(shared, path.join(root, 'linked'), 'junction');
  const policy = path.join(shared, '.gitignore');
  fs.writeFileSync(policy, '# policy\n');
  const uid = process.getuid?.() === 0 ? 65534 : undefined;
  if (uid !== undefined) fs.chownSync(policy, uid, uid);
  const script = path.join(root, 'pending-policy.cjs');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const { CodeGraph } = require(${JSON.stringify(path.resolve('dist/index.js'))});
(async () => {
 const graph = await CodeGraph.init(${JSON.stringify(root)}, { index: true });
 try {
  const markerDb = new (require('node:sqlite').DatabaseSync)(graph.getDatabaseFilePath());
  markerDb.prepare('INSERT OR REPLACE INTO project_metadata(key,value,updated_at) VALUES(?,?,?)').run('portable:source-catchup-v1', 'integration-pending-policy', Date.now());
  markerDb.close();
  fs.chmodSync(${JSON.stringify(policy)}, 0);
  let failed = false;
  try { await graph.sync({ adaptive: false }); } catch (error) { failed = /EACCES|incomplete/.test(String(error)); }
  if (!failed || !graph.getPortableCatchup()) throw Error('incomplete policy cleared pending marker');
  if (graph.getNodesByName('external_pending').length !== 1) throw Error('old external symbol lost');
  fs.chmodSync(${JSON.stringify(policy)}, 0o644);
  const result = await graph.sync({ adaptive: false });
  if (result.complete !== true || graph.getPortableCatchup() !== null) throw Error('recovery did not finish');
  if (graph.getNodesByName('external_pending').length !== 1) throw Error('external symbol lost after recovery');
 } finally { fs.chmodSync(${JSON.stringify(policy)}, 0o644); graph.close(); await graph.whenIdle(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
  expect(() => execFileSync(process.execPath, ['--liftoff-only', script], {
    uid, gid: uid, env: { ...process.env, CODEGRAPH_ALLOWED_SOURCE_ROOTS: shared }, stdio: 'pipe',
  })).not.toThrow();
}, 60_000);
