/** Compatibility with the user's only published release, not a metadata mock. */
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import CodeGraph from '../src/index';
import { getCodeGraphDir } from '../src/directory';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';
const { DatabaseSync } = require('node:sqlite');
const fixture = path.join(__dirname, 'fixtures/published-1765271f');
const roots: string[] = [], graphs: CodeGraph[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const graph of graphs.splice(0)) { await graph.whenIdle(); graph.close(); await graph.whenIdle(); }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function restore() {
  vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
  // Match the released fixture's default-v1 scope, avoiding an unrelated scope migration.
  vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '0');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-published-1765271f-')); roots.push(root);
  fs.copyFileSync(path.join(fixture, 'published.c'), path.join(root, 'published.c'));
  const dataDir = getCodeGraphDir(root); fs.mkdirSync(dataDir, { recursive: true });
  const bytes = gunzipSync(fs.readFileSync(path.join(fixture, 'codegraph.db.gz')));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('7e0c362f471a3cb2f911a30e00052d090c574079546cc2d6b4367a95f97a9b18');
  const file = path.join(dataDir, 'codegraph.db'); fs.writeFileSync(file, bytes);
  return { root, file, dataDir };
}
function checkWal(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
    expect(db.prepare('PRAGMA quick_check').get().quick_check).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); }
}
it('opens and incrementally enrolls the untouched published database without losing content or WAL', async () => {
  const { root, file, dataDir } = restore();
  expect(fs.existsSync(path.join(dataDir, 'CURRENT'))).toBe(false);
  expect(fs.existsSync(path.join(dataDir, '.runtime'))).toBe(false);
  const graph = CodeGraph.openSync(root); graphs.push(graph);
  expect(graph.getIndexBuildInfo().extractionVersion).toBe(36);
  expect(graph.getStats()).toMatchObject({ nodeCount: 3, edgeCount: 3, fileCount: 1 });
  expect(graph.searchNodes('published_caller').length).toBeGreaterThan(0);
  const result = await graph.sync();
  // The release lacks current semantic-policy stamps; first enrollment
  // legitimately refreshes its one file, then settles to a true no-op.
  expect(result).toMatchObject({ complete: true, filesModified: 1, filesRemoved: 0 });
  expect(await graph.sync()).toMatchObject({ filesModified: 0, filesRemoved: 0 });
  expect(result.adaptive?.strategy).not.toBe('rebuild');
  expect(graph.getDatabaseFilePath()).toBe(file);
  expect(graph.getStats()).toMatchObject({ nodeCount: 3, edgeCount: 3, fileCount: 1 });
  checkWal(file);
}, 30000);

it('keeps a legacy SQLite read snapshot usable during upgrade, incremental writes, and explicit reindex', async () => {
  const { root, file } = restore();
  // A released client does not know portable leases. Keep its actual SQLite
  // transaction alive across first enrollment and subsequent writer operations.
  const oldReader = new DatabaseSync(file, { readOnly: true });
  oldReader.exec('BEGIN');
  const oldCount = oldReader.prepare('SELECT COUNT(*) AS n FROM nodes').get().n;
  try {
    const graph = CodeGraph.openSync(root); graphs.push(graph);
    fs.appendFileSync(path.join(root, 'published.c'), 'int upgraded_symbol(void) { return 29; }\n');
    expect((await graph.sync()).filesModified).toBe(1);
    expect(graph.searchNodes('upgraded_symbol').length).toBeGreaterThan(0);
    expect((await graph.indexAll()).complete).toBe(true);
    expect(graph.getIndexBuildInfo().extractionVersion).toBe(EXTRACTION_VERSION);
    expect(oldReader.prepare('SELECT COUNT(*) AS n FROM nodes').get().n).toBe(oldCount);
    expect(oldReader.prepare("SELECT COUNT(*) AS n FROM nodes WHERE name='upgraded_symbol'").get().n).toBe(0);
  } finally { oldReader.exec('COMMIT'); oldReader.close(); }
  checkWal(file);
  const reopened = CodeGraph.openReadOnlySync(root); graphs.push(reopened);
  expect(reopened.searchNodes('published_value').length).toBeGreaterThan(0);
  expect(reopened.searchNodes('upgraded_symbol').length).toBeGreaterThan(0);
}, 30000);
