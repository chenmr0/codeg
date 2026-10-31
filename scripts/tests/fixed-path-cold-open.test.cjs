const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { CodeGraph } = require('../../dist');
process.env.CODEGRAPH_FIXED_PATH = '1';
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-cold-open-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  CodeGraph.initSync(root).close();
  return { root, file: path.join(root, '.codegraph-wx', 'codegraph.db') };
}
test('cold fixed-path open does not compute graph-wide statistics', t => {
  const { root } = fixture(t), original = CodeGraph.prototype.getStats;
  CodeGraph.prototype.getStats = () => { throw new Error('unexpected aggregate scan'); };
  let graph;
  try { graph = CodeGraph.openSync(root); assert.equal(graph.getFileCount(), 0); assert.deepEqual(graph.searchNodes('absent'), []); }
  finally { graph?.close(); CodeGraph.prototype.getStats = original; }
  graph = CodeGraph.openSync(root);
  try { assert.equal(graph.getStats().nodeCount, 0); } finally { graph.close(); }
});
for (const table of ['nodes', 'edges', 'files']) test(`cold fixed-path open rejects a missing ${table} table`, t => {
  const { root, file } = fixture(t), db = new DatabaseSync(file);
  try { db.exec(`PRAGMA foreign_keys=OFF; DROP TABLE ${table}`); } finally { db.close(); }
  assert.throws(() => CodeGraph.openSync(root), /no such table|malformed/i);
});
test('cold fixed-path open validates required columns even on empty tables', t => {
  const { root, file } = fixture(t), db = new DatabaseSync(file);
  try { db.exec('ALTER TABLE files RENAME COLUMN language TO unsupported_language'); } finally { db.close(); }
  assert.throws(() => CodeGraph.openSync(root), /no such column.*language/i);
});
test('cold fixed-path open rejects a corrupt offline public replacement', t => {
  const { root, file } = fixture(t); fs.writeFileSync(file, Buffer.alloc(8192, 0x61));
  assert.throws(() => CodeGraph.openSync(root), /not a database|malformed|header|Invalid CodeGraph|current schema version/i);
});
test('cold fixed-path open rejects an absent offline public replacement', t => {
  const { root, file } = fixture(t); fs.unlinkSync(file);
  assert.throws(() => CodeGraph.openSync(root), /ENOENT|not initialized|missing|not found/i);
  assert.equal(fs.existsSync(file), false);
});
