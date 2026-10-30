const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodeGraph, DatabaseConnection } = require('../../dist');
const { FixedPathWriterLock } = require('../../dist/sync/fixed-path/writer-lock');
const { withFixedPathOpen } = require('../../dist/sync/fixed-path/open-context');
process.env.CODEGRAPH_FIXED_PATH = '1';
process.env.CODEGRAPH_ALL_LANGUAGES = '1';

test('rejected concurrent writer must not heal the admitted writer bulk schema during native open', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-writer-admission-'));
  let graph, current, writer;
  try {
    fs.writeFileSync(path.join(root, 'main.ts'), 'export function stable() { return 1; }');
    graph = await CodeGraph.init(root, { index: true });
    const data = graph.getDataDirectory();
    const file = graph.getDatabaseFilePath();
    // Model the actual lifetime of a bulk operation: mutation admission is held
    // while its trigger/index optimization window is open between async batches.
    writer = new FixedPathWriterLock(data);
    writer.acquire();
    current = withFixedPathOpen(file, () => DatabaseConnection.open(file));
    current.beginBulkNodeLoad();
    current.beginBulkParseLoad();
    const state = () => current.getDb().prepare(`SELECT type, name FROM sqlite_master
      WHERE (type='trigger' AND name IN ('nodes_ai','nodes_ad','nodes_au'))
         OR (type='index' AND name='idx_nodes_name') ORDER BY name`).all();
    assert.deepEqual(state(), []);
    assert.throws(() => graph.clear(), /locked|writer|mutation/i);
    assert.deepEqual(state(), [], 'a blocked facade writer changed the active bulk writer schema before acquiring mutation admission');
    assert.equal(graph.getDatabaseFilePath(), file, 'must remain same fixed database path');
  } finally {
    if (current) {
      current.endBulkNodeLoad();
      await current.endBulkParseLoad();
      current.close();
    }
    writer?.release();
    graph?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scoped watcher-style sync converges edits outside its original paths after publication', {timeout:15000}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scoped-convergence-'));
  const worker = require('../../dist/sync/fixed-path/rebuild');
  const original = worker.runFixedPathRebuild;
  const abort = new AbortController();
  let graph, injected = false, postPublicationDecisions = 0;
  try {
    fs.writeFileSync(path.join(root, 'main.ts'), 'export function stable() { return 1; }');
    graph = await CodeGraph.init(root, { index: true });
    const paths = [];
    for (let i=0; i<140; i++) {
      paths.push(`added_${i}.ts`);
      fs.writeFileSync(path.join(root, paths.at(-1)), `export function added_${i}() { return ${i}; }`);
    }
    worker.runFixedPathRebuild = async (...args) => {
      const result = await original(...args);
      if (!injected) {
        injected = true;
        fs.writeFileSync(path.join(root, 'late.ts'), 'export function late_arrival() { return 7; }');
      }
      return result;
    };
    const result = await graph.sync({ paths, signal: abort.signal, onAdaptiveDecision() {
      // Bound a broken loop deterministically; one repair plus a clean full
      // verification should suffice for this stable, single injected edit.
      if (injected && ++postPublicationDecisions >= 4) abort.abort(new Error('Repeated scoped reconciliation never indexed late.ts'));
    }});
    assert(injected, 'must perform actual publication');
    assert.equal(result.complete, true);
    assert(graph.searchNodes('late_arrival').some(row => row.node.name === 'late_arrival'));
  } finally {
    worker.runFixedPathRebuild = original;
    abort.abort();
    await graph?.whenIdle();
    graph?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('new fixed initialization never admits an unleased legacy reader before registration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fixed-init-admission-'));
  const protocol = require('../../dist/sync/fixed-path/protocol');
  const original = fs.openSync;
  let graph, concurrentReader, fence, injected = false;
  fs.openSync = (file, flags, ...args) => {
    const fd = original(file, flags, ...args);
    // Source has been validated/sealed, but initial migration intent has not
    // yet been persisted. Schedule a current-version cold reader at this gap.
    if (!injected && file === path.join(root, '.codegraph-wx', 'codegraph.db') && flags === 'r+') {
      injected = true;
      try { concurrentReader = CodeGraph.openReadOnlySync(root); } catch {}
    }
    return fd;
  };
  try {
    fs.writeFileSync(path.join(root, 'main.ts'), 'export function stable() { return 1; }');
    graph = await CodeGraph.init(root, { index: true });
    const dataDirectory = graph.getDataDirectory();
    graph.close(); graph = null;
    if (concurrentReader) {
      fence = protocol.lease(protocol.paths({project:root, dataDirectory}).connections, true);
      assert.equal(fence, null, 'a known-version reader opened during fixed initialization escaped connection fencing');
    }
  } finally {
    fs.openSync = original;
    fence?.close();
    concurrentReader?.close();
    graph?.close();
    fs.rmSync(root, {recursive:true,force:true});
  }
});
