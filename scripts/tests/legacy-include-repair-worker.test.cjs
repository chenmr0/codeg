const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseConnection } = require('../../dist');
const { repairLegacyIncludesOffThread } = require('../../dist/db/legacy-include-repair');
const stamp = 'repair:cpp-include-targets-v1';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'include-worker-')), file = path.join(root, 'graph.db');
  const connection = DatabaseConnection.initialize(file), db = connection.getDb();
  db.exec(`INSERT INTO nodes(id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,updated_at)
    VALUES ('source','file','caller.cpp','caller.cpp','caller.cpp','cpp',1,1,0,0,0),
      ('target','import','api.h','api.h','caller.cpp','cpp',1,1,0,0,0);
    INSERT INTO edges(source,target,kind,metadata,line,col) VALUES ('source','target','imports','{"refName":"api.h"}',1,0);
    INSERT INTO unresolved_refs(from_node_id,reference_name,reference_kind,line,col,file_path,language,status,name_tail)
      VALUES ('source','nested/missing.h','imports',2,0,'caller.cpp','cpp','failed','h');`);
  t.after(() => { connection.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { file, db };
}
function lease() {
  let acquired = 0, released = 0;
  return { factory() { acquired++; return { release() { released++; } }; }, get acquired() { return acquired; }, get released() { return released; } };
}
test('native worker repairs includes and atomically stamps completion', async t => {
  const { file, db } = fixture(t), held = lease();
  assert.deepEqual(await repairLegacyIncludesOffThread(file, held.factory), ['caller.cpp']);
  assert.equal(held.acquired, 1); assert.equal(held.released, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM edges').get().n, 0);
  assert.deepEqual(db.prepare('SELECT reference_name,status,name_tail FROM unresolved_refs ORDER BY reference_name').all().map(row => ({ ...row })), [
    { reference_name: 'api.h', status: 'pending', name_tail: '' },
    { reference_name: 'nested/missing.h', status: 'pending', name_tail: '' }]);
  assert.equal(db.prepare('SELECT value FROM project_metadata WHERE key=?').get(stamp).value, 'done');
  assert.deepEqual(await repairLegacyIncludesOffThread(file, held.factory), []);
});
test('native stamp failure rolls back edges and references, and releases only on exit', async t => {
  const { file, db } = fixture(t), held = lease(), before = db.prepare('SELECT * FROM unresolved_refs').all();
  db.exec(`CREATE TRIGGER fail_stamp BEFORE INSERT ON project_metadata WHEN NEW.key='${stamp}' BEGIN SELECT RAISE(ABORT, 'repair-stamp-failure'); END`);
  const pending = repairLegacyIncludesOffThread(file, held.factory);
  assert.equal(held.acquired, 1); assert.equal(held.released, 0);
  await assert.rejects(pending, /repair-stamp-failure/); assert.equal(held.released, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM edges').get().n, 1);
  assert.deepEqual(db.prepare('SELECT * FROM unresolved_refs').all(), before);
  assert.equal(db.prepare('SELECT value FROM project_metadata WHERE key=?').get(stamp), undefined);
  db.exec('DROP TRIGGER fail_stamp'); assert.deepEqual(await repairLegacyIncludesOffThread(file, held.factory), ['caller.cpp']);
});
test('cancellation retains independent ownership until the native worker exits', async t => {
  const { file, db } = fixture(t), held = lease(), abort = new AbortController();
  const pending = repairLegacyIncludesOffThread(file, held.factory, abort.signal); abort.abort();
  assert.equal(held.acquired, 1); assert.equal(held.released, 0);
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(held.released, 1);
  const done = db.prepare('SELECT value FROM project_metadata WHERE key=?').get(stamp);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM edges').get().n, done ? 0 : 1);
});
test('main-thread timers progress while native repair waits for a database lock', async t => {
  const { file, db } = fixture(t), held = lease(); db.pragma('journal_mode = DELETE'); db.exec('BEGIN EXCLUSIVE');
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; assert.equal(held.released, 0); db.exec('ROLLBACK'); }, 100);
  try { assert.deepEqual(await repairLegacyIncludesOffThread(file, held.factory), ['caller.cpp']); assert(timerFired); assert.equal(held.released, 1); }
  finally { clearTimeout(timer); try { db.exec('ROLLBACK'); } catch {} }
});
test('native repair isolates parent-only preload arguments and NODE_OPTIONS', async t => {
  const { file, db } = fixture(t), held = lease(), preload = path.join(path.dirname(file), 'throw-if-loaded.cjs');
  fs.writeFileSync(preload, 'throw new Error("parent-preload-must-not-run-in-repair");\n');
  const previousOptions = process.env.NODE_OPTIONS, previousArgv = [...process.execArgv];
  try {
    process.env.NODE_OPTIONS = `--require=${preload}`; process.execArgv.push('--require', preload);
    assert.deepEqual(await repairLegacyIncludesOffThread(file, held.factory), ['caller.cpp']);
    assert.equal(db.prepare('SELECT value FROM project_metadata WHERE key=?').get(stamp).value, 'done'); assert.equal(held.released, 1);
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
    process.execArgv.splice(0, process.execArgv.length, ...previousArgv);
  }
});
test('abort during a proven native write transaction preserves atomic repair', { timeout: 15000 }, async t => {
  const { file, db } = fixture(t), held = lease(), abort = new AbortController(), before = db.prepare('SELECT * FROM unresolved_refs ORDER BY id').all();
  db.exec(`CREATE TRIGGER delay_stamp BEFORE INSERT ON project_metadata WHEN NEW.key='${stamp}'
    BEGIN SELECT (WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM counter WHERE n<5000000) SELECT sum(n) FROM counter); END`);
  db.pragma('busy_timeout = 0'); let settled = false;
  const pending = repairLegacyIncludesOffThread(file, held.factory, abort.signal);
  const outcome = pending.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  let writerObserved = false; const deadline = Date.now() + 5000;
  try {
    while (!settled && Date.now() < deadline) {
      try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); }
      catch (error) { if ((error.errcode & 255) !== 5) throw error; writerObserved = true; break; }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert(writerObserved, 'independent connection must observe worker write lock'); assert.equal(held.released, 0);
    abort.abort(); assert.equal(held.released, 0);
    const result = await outcome; assert.equal(result.error?.name, 'AbortError'); assert.equal(held.released, 1);
    const done = db.prepare('SELECT value FROM project_metadata WHERE key=?').get(stamp), edgeCount = db.prepare('SELECT COUNT(*) n FROM edges').get().n;
    const refs = db.prepare('SELECT * FROM unresolved_refs ORDER BY id').all();
    if (done) { assert.equal(done.value, 'done'); assert.equal(edgeCount, 0); assert.equal(refs.length, 2); assert(refs.every(row => row.status === 'pending' && row.name_tail === '')); }
    else { assert.equal(edgeCount, 1); assert.deepEqual(refs, before); }
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { abort.abort(); await outcome; }
});
