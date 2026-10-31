// Deterministic scheduling regression, not a performance benchmark. The timer
// starts at the first main-thread reconciliation stat, after worker enumeration.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseConnection } = require('../../dist');
const { QueryBuilder } = require('../../dist/db/queries');
const { ExtractionOrchestrator, hashContent } = require('../../dist/extraction');
const { canScanOffThread } = require('../../dist/extraction/scan-off-thread');

test('mtime-only reconciliation yields before its first metadata-write batch', { timeout: 20000 }, async () => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-responsive-')));
  const root = path.join(directory, 'source');
  fs.mkdirSync(root);
  const connection = DatabaseConnection.initialize(path.join(directory, 'graph.db'));
  const queries = new QueryBuilder(connection.getDb());
  const originalStat = fs.statSync;
  const originalRefresh = queries.refreshUnchangedFileStats;
  const priorScope = process.env.CODEGRAPH_ALL_LANGUAGES;
  const priorRust = process.env.CODEGRAPH_RUST_SCAN;
  const targets = new Set();
  const expected = new Map();
  let timer;
  let timerFired = false;
  let timerArmed = false;
  let statCalls = 0;
  let refreshCalls = 0;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  try {
    process.env.CODEGRAPH_ALL_LANGUAGES = '1';
    process.env.CODEGRAPH_RUST_SCAN = 'off';
    assert.equal(connection.getBackend(), 'node-sqlite');
    assert.equal(canScanOffThread(), true, 'requires emitted worker so scan callbacks cannot satisfy the timer assertion');
    // Correct content hashes and sizes, but every stored timestamp predates
    // the actual source. This must refresh stat metadata without re-extraction.
    for (let i = 0; i < 1000; i++) {
      const relative = `file_${String(i).padStart(4, '0')}.py`;
      const full = path.join(root, relative);
      const content = `def stable_${i}():\n    return ${i}\n`;
      fs.writeFileSync(full, content);
      fs.utimesSync(full, 1700000000, 1700000000);
      const stat = originalStat(full), contentHash = hashContent(content);
      targets.add(full);
      expected.set(relative, { contentHash, size: stat.size, modifiedAt: stat.mtimeMs, indexedAt: 12345 });
      queries.upsertFile({ path: relative, contentHash, language: 'python', size: stat.size,
        modifiedAt: stat.mtimeMs - 10000, indexedAt: 12345, nodeCount: 0 });
    }
    const orchestrator = new ExtractionOrchestrator(root, queries);
    fs.statSync = function(file, ...args) {
      if (typeof file === 'string' && targets.has(file)) {
        if (!timerArmed) {
          timerArmed = true;
          timer = setTimeout(() => { timerFired = true; }, 0);
        }
        statCalls++;
        // Bounded test-only delay makes a 1000-file no-yield loop fail reliably
        // without requiring slow hardware, cache eviction, or a large corpus.
        Atomics.wait(pause, 0, 0, 1);
      }
      return originalStat.call(fs, file, ...args);
    };
    queries.refreshUnchangedFileStats = function(files) {
      if (refreshCalls++ === 0) {
        assert(timerArmed, 'timer must be armed by reconciliation, not scan replay');
        assert(timerFired, 'reconciliation must admit timers before its first metadata batch');
      }
      return originalRefresh.call(this, files);
    };
    let result;
    try { result = await orchestrator.sync(); }
    finally {
      fs.statSync = originalStat;
      queries.refreshUnchangedFileStats = originalRefresh;
      if (timer) clearTimeout(timer);
    }
    assert(timerArmed && timerFired);
    assert(statCalls >= 1000);
    assert(refreshCalls > 0);
    assert.equal(result.complete, true);
    assert.equal(result.filesChecked, 1000);
    assert.equal(result.filesAdded, 0);
    assert.equal(result.filesModified, 0);
    assert.equal(result.filesRemoved, 0);
    assert.equal(result.nodesUpdated, 0);
    assert.equal(queries.getAllFiles().length, 1000);
    for (const [file, before] of expected) {
      const actual = queries.getFileByPath(file);
      assert(actual);
      assert.equal(actual.contentHash, before.contentHash);
      assert.equal(actual.size, before.size);
      assert.equal(actual.modifiedAt, before.modifiedAt);
      assert.equal(actual.indexedAt, before.indexedAt);
      assert.equal(actual.nodeCount, 0);
    }
    assert.equal(connection.getDb().prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(connection.getDb().prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    fs.statSync = originalStat;
    queries.refreshUnchangedFileStats = originalRefresh;
    if (timer) clearTimeout(timer);
    if (priorScope === undefined) delete process.env.CODEGRAPH_ALL_LANGUAGES;
    else process.env.CODEGRAPH_ALL_LANGUAGES = priorScope;
    if (priorRust === undefined) delete process.env.CODEGRAPH_RUST_SCAN;
    else process.env.CODEGRAPH_RUST_SCAN = priorRust;
    connection.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
