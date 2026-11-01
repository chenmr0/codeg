'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const protocolPath = path.resolve(__dirname, '../../dist/sync/portable/protocol.js');
const { PortableCoordinator } = require(protocolPath);
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-bootstrap-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function location(root) { const dir=path.join(root,'.runtime','portable'); fs.mkdirSync(dir,{recursive:true}); return dir; }
function sqlite(file, sql) { const db=new DatabaseSync(file);try{db.exec(sql);}finally{db.close();} }
test('nonzero empty SQLite bootstrap files are completed instead of skipped', t => {
  const root=fixture(t), dir=location(root);
  for(const name of ['writer','readers','gate']) sqlite(path.join(dir,name+'.sqlite'),'VACUUM');
  const c=new PortableCoordinator(root); assert.deepEqual(c.snapshot(),{mode:'idle',revision:0}); const w=c.acquireWriter();w.release();const r=c.acquireReader();r.release();
});
test('known pre-marker empty state and lease tables recover missing singleton', t => {
  const root=fixture(t), dir=location(root);
  for(const name of ['writer','readers']) sqlite(path.join(dir,name+'.sqlite'),'CREATE TABLE lease(id INTEGER PRIMARY KEY)');
  sqlite(path.join(dir,'gate.sqlite'),"CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL,revision INTEGER NOT NULL,journal TEXT)");
  const c=new PortableCoordinator(root);assert.deepEqual(c.snapshot(),{mode:'idle',revision:0}); const w=c.acquireWriter();w.release();
});
test('a committed state with missing singleton is rejected without reset', t => {
  const root=fixture(t);new PortableCoordinator(root);const file=path.join(location(root),'gate.sqlite');
  sqlite(file,'DELETE FROM state');const before=fs.readFileSync(file);
  assert.throws(()=>new PortableCoordinator(root),/singleton is missing/);assert.deepEqual(fs.readFileSync(file),before);
});
test('unknown bootstrap schema is rejected and preserved', t => {
  const root=fixture(t),dir=location(root),file=path.join(dir,'writer.sqlite');sqlite(file,'CREATE TABLE important(x);INSERT INTO important VALUES(42)');
  const before=fs.readFileSync(file);assert.throws(()=>new PortableCoordinator(root),/Unknown coordination schema/);assert.deepEqual(fs.readFileSync(file),before);
});
test('a held writer does not block a cold coordinator or reader', t => {
  const root=fixture(t),c=new PortableCoordinator(root),w=c.acquireWriter();
  try { const result=spawnSync(process.execPath,['--no-warnings','-e',`const {PortableCoordinator}=require(${JSON.stringify(protocolPath)});const c=new PortableCoordinator(process.argv[1]);const r=c.acquireReader();r.release();process.stdout.write('readable');`,root],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'readable'); }
  finally {w.release();}
});
for(const point of ['first-lease','second-lease','state-uncommitted','state-committed']) test(`real bootstrap process exit at ${point} recovers safely`,t=>{
  const root=fixture(t);
  const source=`const sqlite=require('node:sqlite');const original=sqlite.DatabaseSync.prototype.exec;let leases=0,state=false;sqlite.DatabaseSync.prototype.exec=function(sql){const result=original.call(this,sql);if(sql.includes('CREATE TABLE IF NOT EXISTS lease')){leases++;if((process.argv[2]==='first-lease'&&leases===1)||(process.argv[2]==='second-lease'&&leases===2))process.exit(71);}if(sql.includes('CREATE TABLE IF NOT EXISTS state')){state=true;if(process.argv[2]==='state-uncommitted')process.exit(71);}if(sql==='COMMIT'&&state&&process.argv[2]==='state-committed')process.exit(71);return result;};const {PortableCoordinator}=require(${JSON.stringify(protocolPath)});new PortableCoordinator(process.argv[1]);`;
  const result=spawnSync(process.execPath,['--no-warnings','-e',source,root,point],{encoding:'utf8',timeout:5000});assert.equal(result.status,71,result.stderr);
  const c=new PortableCoordinator(root);assert.deepEqual(c.snapshot(),{mode:'idle',revision:0});const w=c.acquireWriter();w.release();const r=c.acquireReader();r.release();
});
test('transient gate locking is a retryable PortableBusyError', t => {
  const root=fixture(t),c=new PortableCoordinator(root),file=path.join(location(root),'gate.sqlite');
  const blocker=new DatabaseSync(file);blocker.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
  try { assert.throws(()=>c.snapshot(),e=>e.code==='PORTABLE_BUSY'); }
  finally {blocker.close();}
  assert.deepEqual(c.snapshot(),{mode:'idle',revision:0});
});
