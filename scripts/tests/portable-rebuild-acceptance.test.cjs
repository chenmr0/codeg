'use strict';

/** Production-entrypoint acceptance for portable background rebuilding.
 * Run after npm run build:
 *   node --liftoff-only scripts/tests/portable-rebuild-acceptance.test.cjs
 * Uses small source fixtures and real independent reader processes. Passing on
 * Linux does not constitute Windows acceptance; run the same file on Windows.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const dist = path.resolve(__dirname, '../../dist');
process.env.CODEGRAPH_ALL_LANGUAGES = '1';
const runtimeArgs = ['--liftoff-only'];
const fallback = { minChangedFiles: 2, minChangedFraction: 0.5, minWorkFraction: 0.5,
  minAffectedOldNodes: 2, minAffectedOldNodeFraction: 0.5 };

if (process.env.CODEGRAPH_PORTABLE_TEST_ROLE === 'reader') {
  const { CodeGraph } = require(dist);
  let graph;
  let timer;
  try {
    graph = CodeGraph.openSync(process.argv[2]);
    const probe = () => {
      try {
        process.send?.({ type: 'sample', at: Date.now(),
          old: graph.searchNodes('original_symbol').some(row => row.node.name === 'original_symbol'),
          next: graph.searchNodes('replacement_7').some(row => row.node.name === 'replacement_7') });
      } catch (error) {
        process.send?.({ type: 'query-error', at: Date.now(), message: error.message });
      }
    };
    process.on('message', async message => {
      if (message === 'probe') probe();
      if (message === 'stop') {
        clearInterval(timer);
        graph.close();
        await graph.whenIdle();
        process.disconnect();
      }
    });
    probe();
    timer = setInterval(probe, 15);
    process.send?.({ type: 'ready' });
  } catch (error) {
    process.send?.({ type: 'failure', message: error.stack });
    process.exitCode = 1;
    process.disconnect?.();
  }
} else {
  const test = require('node:test');
  const { CodeGraph } = require(dist);
  const roots = new Set();
  function fixture() {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'portable-rebuild-')));
    roots.add(root);
    return root;
  }
  function source(root, name = 'original_symbol') {
    fs.writeFileSync(path.join(root, 'main.ts'), `export function ${name}(): number { return 1; }\n`);
  }
  function additions(root) {
    for (let i = 0; i < 8; i++)
      fs.writeFileSync(path.join(root, `added_${i}.ts`), `export function replacement_${i}(): number { return ${i}; }\n`);
  }
  function has(graph, name) { return graph.searchNodes(name).some(row => row.node.name === name); }
  async function close(graph) {
    if (!graph) return;
    await graph.whenIdle();
    graph.close();
    await graph.whenIdle();
  }
  function assertRoot(root, graph) {
    const data = path.join(root, '.codegraph-wx');
    assert.equal(graph.getDatabaseFilePath(), path.join(data, 'codegraph.db'));
    assert(!fs.existsSync(path.join(data, 'CURRENT')), 'new projects must not create CURRENT');
    assert(!fs.existsSync(path.join(data, 'generations')), 'new projects must not create generation layouts');
  }
  function seal(file) {
    const db = new DatabaseSync(file);
    try {
      const rows = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
      assert(rows.every(row => !row.busy), 'export checkpoint must not be busy');
      db.exec('PRAGMA journal_mode=DELETE');
    } finally { db.close(); }
    assert(!fs.existsSync(file + '-wal'), 'public snapshot must not depend on WAL');
  }
  async function until(predicate, description, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${description}`);
  }
  function reader(root) {
    const messages = [];
    let stderr = '';
    const child = fork(__filename, [root], { execArgv: runtimeArgs,
      env: { ...process.env, CODEGRAPH_PORTABLE_TEST_ROLE: 'reader' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.on('message', message => messages.push(message));
    child.stderr.on('data', data => { stderr += data; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    return { child, messages, exited,
      ready: () => until(() => {
        const failed = messages.find(message => message.type === 'failure');
        if (failed) throw new Error(failed.message);
        if (child.exitCode !== null) throw new Error(`reader exited ${child.exitCode}: ${stderr}`);
        return messages.some(message => message.type === 'ready');
      }, 'independent reader startup'),
      async stop() {
        if (child.exitCode === null && child.connected) child.send('stop');
        let timer;
        const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
        clearTimeout(timer);
        if (!result && child.exitCode === null) { child.kill(); await exited; }
      } };
  }
  test.after(() => {
    // Fixtures are removed only after all graph handles and child processes close.
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  test('fresh SDK retains a fixed root database through rebuild and subsequent incremental sync', { timeout: 60000 }, async () => {
    const root = fixture(); source(root);
    let graph = await CodeGraph.init(root, { index: true });
    try {
      assertRoot(root, graph);
      additions(root);
      const rebuilt = await graph.sync({ adaptiveFallback: fallback });
      assert.equal(rebuilt.adaptive?.strategy, 'rebuild', JSON.stringify(rebuilt));
      assert.notEqual(rebuilt.complete, false);
      assertRoot(root, graph);
      assert(has(graph, 'original_symbol'));
      assert(has(graph, 'replacement_7'));
      source(root, 'modified_symbol');
      await graph.sync({ adaptive: false });
      assert(has(graph, 'modified_symbol'));
      assert(!has(graph, 'original_symbol'));
      await close(graph); graph = CodeGraph.openSync(root);
      assertRoot(root, graph);
      assert(has(graph, 'modified_symbol'));
      const noop = await graph.sync();
      assert.equal(noop.filesAdded + noop.filesModified + noop.filesRemoved, 0);
    } finally { await close(graph); }
  });

  test('offline single-file replacement preserves runtime and adopts the imported database', { timeout: 60000 }, async () => {
    const producer = fixture(), consumer = fixture();
    source(producer, 'public_symbol'); source(consumer);
    let published = await CodeGraph.init(producer, { index: true });
    let graph = await CodeGraph.init(consumer, { index: true });
    try {
      additions(consumer);
      assert.equal((await graph.sync({ adaptiveFallback: fallback })).adaptive?.strategy, 'rebuild');
      await close(published); published = null;
      await close(graph); graph = null;
      const from = path.join(producer, '.codegraph-wx', 'codegraph.db');
      const to = path.join(consumer, '.codegraph-wx', 'codegraph.db');
      seal(from); seal(to);
      const runtime = path.join(consumer, '.codegraph-wx', '.runtime');
      assert(fs.existsSync(runtime), 'exercise replacement with existing local runtime');
      const sentinel = path.join(runtime, 'acceptance-preserved.txt');
      fs.writeFileSync(sentinel, 'local runtime must not be blindly removed');
      fs.copyFileSync(from, to);
      graph = CodeGraph.openSync(consumer);
      assertRoot(consumer, graph);
      assert(has(graph, 'public_symbol'));
      assert(!has(graph, 'original_symbol'));
      assert(!has(graph, 'replacement_7'));
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'local runtime must not be blindly removed');
      // Imported graph and local source may differ; explicit sync must converge.
      await graph.sync({ adaptive: false });
      assert(has(graph, 'original_symbol'));
      assert(has(graph, 'replacement_7'));
      assert(!has(graph, 'public_symbol'));
    } finally { await close(published); await close(graph); }
  });

  test('a real independent SDK reader keeps querying old data during candidate construction and adopts publication', { timeout: 60000 }, async () => {
    const root = fixture(); source(root);
    const graph = await CodeGraph.init(root, { index: true });
    let client;
    let syncing;
    const progress = [];
    try {
      client = reader(root); await client.ready();
      additions(root);
      const started = Date.now();
      syncing = graph.sync({ adaptiveFallback: fallback,
        onProgress(event) { progress.push({ at: Date.now(), phase: event.phase }); } });
      const result = await syncing;
      const completed = Date.now();
      assert.equal(result.adaptive?.strategy, 'rebuild');
      assert(progress.some(event => event.phase === 'parsing'), 'observe actual background candidate extraction');
      const parsing = progress.find(event => event.phase === 'parsing').at;
      const during = client.messages.filter(message => message.type === 'sample' &&
        message.at >= parsing && message.at <= completed && message.old && !message.next);
      assert(during.length > 0, 'independent reader must execute while the candidate is being built, not only before sync');
      await until(() => client.messages.some(message => message.type === 'sample' && message.next), 'reader reopening the published graph');
      const before = client.messages.filter(message => message.type === 'sample' && message.at < started);
      assert(before.every(message => message.old && !message.next));
      const after = client.messages.filter(message => message.type === 'sample' && message.next);
      assert(after.every(message => message.old), 'new graph must include unchanged old source');
      assertRoot(root, graph);
    } finally {
      if (syncing) await syncing.catch(() => {});
      await client?.stop();
      await close(graph);
    }
  });


  function changeWithPreservedStat(root) {
    const file = path.join(root, 'main.ts'), before = fs.statSync(file);
    const content = fs.readFileSync(file, 'utf8');
    const changed = content.replace('original_symbol', 'modified_symbol');
    assert.notEqual(changed, content);
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(content));
    fs.writeFileSync(file, changed);
    fs.utimesSync(file, before.atime, before.mtime);
    const after = fs.statSync(file);
    assert.equal(after.size, before.size);
    assert.equal(Math.floor(after.mtimeMs), Math.floor(before.mtimeMs));
  }

  for (const interrupted of [false, true]) {
    test(`post-publication same-stat content change ${interrupted ? 'survives cancellation and scoped nonadaptive reopen' : 'is re-extracted before sync completes'}`, { timeout: 60000 }, async () => {
      const publisher = require(path.join(dist, 'sync/portable/publisher-client'));
      const original = publisher.runPortableRebuild;
      const root = fixture(); source(root);
      // Preserve a representable whole-second timestamp already stored in the
      // initial index, rather than introducing a rounding change during injection.
      fs.utimesSync(path.join(root, 'main.ts'), 1700000000, 1700000000);
      let graph = await CodeGraph.init(root, { index: true });
      const abort = new AbortController(); let injected = false;
      publisher.runPortableRebuild = async (...args) => {
        const result = await original(...args);
        assert(graph.getPortableCatchup(), 'candidate must carry durable pending catchup before publication returns');
        changeWithPreservedStat(root); injected = true;
        if (interrupted) abort.abort();
        return result;
      };
      try {
        additions(root);
        const sync = graph.sync({ adaptiveFallback: fallback, signal: abort.signal });
        if (interrupted) {
          await assert.rejects(sync, /abort|cancel/i);
          assert(injected);
          assert(graph.getPortableCatchup(), 'cancellation must preserve pending reconciliation');
          publisher.runPortableRebuild = original;
          await close(graph); graph = CodeGraph.openSync(root);
          assert(graph.getPortableCatchup(), 'reopened database must retain its own pending obligation');
          const result = await graph.sync({ adaptive: false, paths: ['added_0.ts'] });
          assert.notEqual(result.complete, false);
        } else {
          const result = await sync;
          assert.equal(result.adaptive?.strategy, 'rebuild');
        }
        assert(injected);
        assert(has(graph, 'modified_symbol'));
        assert(!has(graph, 'original_symbol'));
        assert.equal(graph.getPortableCatchup(), null);
        const noop = await graph.sync();
        assert.equal(noop.filesAdded + noop.filesModified + noop.filesRemoved, 0);
      } finally { publisher.runPortableRebuild = original; await close(graph); }
    });
  }

  function tinyDatabase(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    try {
      db.exec('CREATE TABLE acceptance_value(value TEXT NOT NULL)');
      db.prepare('INSERT INTO acceptance_value VALUES (?)').run(value);
    } finally { db.close(); }
  }
  function tinyValue(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare('SELECT value FROM acceptance_value').get().value; }
    finally { db.close(); }
  }
  function crashedPublication(data, phase, sourceFile) {
    const protocol = path.join(dist, 'sync/portable/protocol.js');
    const code = `const {DatabaseSync}=require('node:sqlite');
      const {PortableCoordinator}=require(${JSON.stringify(protocol)});
      const coordinator=new PortableCoordinator(process.argv[1]);
      const lease=coordinator.acquireWriter();coordinator.recover();
      const candidate=coordinator.beginCandidate();
      if(process.argv[3])require('node:fs').copyFileSync(process.argv[3],candidate.path);
      else {const db=new DatabaseSync(candidate.path);
      db.exec("CREATE TABLE acceptance_value(value TEXT NOT NULL);INSERT INTO acceptance_value VALUES('new')");db.close();}
      coordinator.publish(candidate,{hook(phase){if(phase===process.argv[2])process.exit(73)}})
        .then(()=>{lease.release();process.exitCode=2},error=>{console.error(error.stack);lease.release();process.exitCode=1});`;
    const child = spawnSync(process.execPath, [...runtimeArgs, '-e', code, data, phase, ...(sourceFile ? [sourceFile] : [])],
      { env: process.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 73, `expected publisher fault at ${phase}: ${child.stderr}`);
  }


  test('production openSync recovers a publisher crash after the active root was moved away', { timeout: 60000 }, async () => {
    const root = fixture(), producer = fixture(); source(root); source(producer, 'public_symbol');
    let graph = await CodeGraph.init(root, { index: true });
    let other = await CodeGraph.init(producer, { index: true });
    try {
      await close(graph); graph = null;
      await close(other); other = null;
      const data = path.join(root, '.codegraph-wx');
      const active = path.join(data, 'codegraph.db');
      const replacement = path.join(producer, '.codegraph-wx', 'codegraph.db');
      seal(active); seal(replacement);
      crashedPublication(data, 'old-moved', replacement);
      assert(!fs.existsSync(active), 'exercise the real missing-root recovery window');
      graph = CodeGraph.openSync(root);
      assert(has(graph, 'original_symbol'));
      assert(!has(graph, 'public_symbol'));
      assertRoot(root, graph);
    } finally { await close(graph); await close(other); }
  });

  test('configuration change after publication can reconcile on this sync or a reopened retry', { timeout: 60000 }, async () => {
    const publisher = require(path.join(dist, 'sync/portable/publisher-client'));
    const original = publisher.runPortableRebuild;
    const root = fixture(); source(root);
    let graph = await CodeGraph.init(root, { index: true }); let injected = false;
    publisher.runPortableRebuild = async (...args) => {
      const result = await original(...args);
      if (!injected) { fs.writeFileSync(path.join(root, '.codegraphignore'), 'added_7.ts\n'); injected = true; }
      return result;
    };
    try {
      additions(root);
      try { await graph.sync({ adaptiveFallback: fallback }); }
      catch (error) {
        assert.match(error.message, /configuration.*chang/i);
        assert(graph.getPortableCatchup(), 'configuration failure must preserve its reconciliation obligation');
      }
      assert(injected);
      publisher.runPortableRebuild = original;
      await close(graph); graph = CodeGraph.openSync(root);
      const retry = await graph.sync({ adaptiveFallback: fallback });
      assert.notEqual(retry.complete, false);
      assert.equal(graph.getPortableCatchup(), null);
      assert(has(graph, 'original_symbol'));
      assert(!has(graph, 'replacement_7'), 'reconciled index must honor the new ignore configuration');
    } finally { publisher.runPortableRebuild = original; await close(graph); }
  });

  test('publication drain timeout retains old database and allows a later successful publication', { timeout: 15000 }, async () => {
    const { PortableCoordinator } = require(path.join(dist, 'sync/portable/protocol'));
    const root = fixture(), data = path.join(root, '.codegraph-wx');
    const active = path.join(data, 'codegraph.db'); tinyDatabase(active, 'old');
    const coordinator = new PortableCoordinator(data), writer = coordinator.acquireWriter();
    let read;
    try {
      const first = coordinator.beginCandidate(); tinyDatabase(first.path, 'new');
      read = coordinator.acquireReader();
      await assert.rejects(coordinator.publish(first, { timeoutMs: 40 }), /drain.*tim|budget/i);
      assert.equal(coordinator.snapshot().mode, 'idle');
      assert.equal(tinyValue(active), 'old');
      read.release(); read = null;
      coordinator.abortCandidate(first);
      const retry = coordinator.beginCandidate(); tinyDatabase(retry.path, 'new');
      await coordinator.publish(retry);
      assert.equal(coordinator.snapshot().mode, 'idle');
      assert.equal(tinyValue(active), 'new');
    } finally { read?.release(); writer.release(); }
  });

  for (const phase of ['prepared', 'draining', 'old-moved', 'new-moved', 'committed']) {
    test(`real publisher exit at ${phase} recovers one intact authoritative database`, { timeout: 20000 }, () => {
      const { PortableCoordinator } = require(path.join(dist, 'sync/portable/protocol'));
      const root = fixture(), data = path.join(root, '.codegraph-wx'), active = path.join(data, 'codegraph.db');
      tinyDatabase(active, 'old'); crashedPublication(data, phase);
      const coordinator = new PortableCoordinator(data);
      coordinator.recover();
      const expected = ['new-moved', 'committed'].includes(phase) ? 'new' : 'old';
      assert.equal(tinyValue(active), expected);
      assert.equal(coordinator.snapshot().mode, 'idle');
      coordinator.recover();
      assert.equal(tinyValue(active), expected, 'recovery must remain idempotent');
    });
  }

  for (const phase of ['old-moved', 'new-moved']) {
    test(`offline independent import wins over retained ${phase} publication evidence`, { timeout: 20000 }, () => {
      const { PortableCoordinator } = require(path.join(dist, 'sync/portable/protocol'));
      const root = fixture(), data = path.join(root, '.codegraph-wx'), active = path.join(data, 'codegraph.db');
      tinyDatabase(active, 'old'); crashedPublication(data, phase);
      const imported = path.join(root, 'public.db'); tinyDatabase(imported, 'imported-third-database');
      const bytes = fs.readFileSync(imported);
      fs.copyFileSync(imported, active);
      const coordinator = new PortableCoordinator(data);
      coordinator.recover();
      assert.equal(tinyValue(active), 'imported-third-database');
      assert.deepEqual(fs.readFileSync(active), bytes, 'recovery must not mutate or roll back a valid independent import');
      assert.equal(coordinator.snapshot().mode, 'idle');
      const retained = fs.readdirSync(path.join(data, '.runtime', 'portable')).filter(name => /^[0-9a-f-]{36}$/.test(name));
      assert(retained.length > 0, 'unmatched old candidate/backup evidence must be retained');
      coordinator.recover();
      assert.equal(tinyValue(active), 'imported-third-database');
    });
  }

}
