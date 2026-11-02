'use strict';
/** Real process / SQLite regression checks. Run after npm run build. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const dist = path.resolve(__dirname, '../../dist');
const protocol = path.join(dist, 'sync/portable/protocol.js');
const { PortableCoordinator } = require(protocol);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-resource-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(root, 'codegraph.db'));
  db.exec('CREATE TABLE active(x); INSERT INTO active VALUES(42)'); db.close();
  return root;
}
function state(c) {
  const db = new DatabaseSync(path.join(c.runtime, 'gate.sqlite'));
  try { return db.prepare('SELECT * FROM state').get(); } finally { db.close(); }
}
function readable(c) {
  const lease = c.acquireReader();
  const db = new DatabaseSync(c.active, {readOnly: true});
  try { assert.equal(db.prepare('SELECT x FROM active').get().x,42); }
  finally {db.close();lease.release();}
}
function tasks(c) { return fs.readdirSync(c.runtime).filter(n => n.endsWith('.cleanup.json')); }
function crashedCandidate(root) {
  const source = `const fs=require('node:fs'); const {DatabaseSync}=require('node:sqlite'); const {PortableCoordinator}=require(${JSON.stringify(protocol)}); const c=new PortableCoordinator(process.argv[1]); const writer=c.acquireWriter(); const candidate=c.beginCandidate(); const db=new DatabaseSync(candidate.path); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES(1)');fs.writeFileSync(process.argv[1]+'/candidate.json',JSON.stringify(candidate));process.exit(71);`;
  const child = spawnSync(process.execPath,['--no-warnings','-e',source,root],{encoding:'utf8',timeout:5000});
  assert.equal(child.status,71,child.stderr);
  return JSON.parse(fs.readFileSync(path.join(root,'candidate.json'),'utf8'));
}
test('a crashed independent WAL builder is checkpointed and reclaimed; active stays readable',t=>{
  const root=fixture(t), candidate=crashedCandidate(root), c=new PortableCoordinator(root);
  assert(fs.existsSync(candidate.path+'-wal'));
  for(let i=0;i<3;i++) { c.recover(); readable(c); }
  assert(!fs.existsSync(path.dirname(candidate.path)));
  assert.equal(state(c).journal,null); assert.deepEqual(tasks(c),[]);
});
test('unknown artifacts retain task; new candidates and reads work; later recovery retries',t=>{
  const root=fixture(t),candidate=crashedCandidate(root),c=new PortableCoordinator(root);
  const extra=path.join(path.dirname(candidate.path),'unknown');fs.writeFileSync(extra,'keep');
  c.recover();assert.equal(state(c).journal,null);assert.equal(tasks(c).length,1);readable(c);
  const writer=c.acquireWriter();const next=c.beginCandidate();c.abortCandidate(next);writer.release();
  c.recover();assert.equal(tasks(c).length,1);assert(fs.existsSync(candidate.path));
  fs.unlinkSync(extra);c.recover();assert.deepEqual(tasks(c),[]);assert(!fs.existsSync(candidate.path));readable(c);
});
test('busy WAL is never unlinked; releasing owner permits a later cleanup',t=>{
  const root=fixture(t),candidate=crashedCandidate(root),c=new PortableCoordinator(root);
  const blocker=new DatabaseSync(candidate.path);blocker.exec('BEGIN IMMEDIATE; INSERT INTO t VALUES(2)');
  try {c.recover();assert.equal(tasks(c).length,1);assert(fs.existsSync(candidate.path+'-wal'));readable(c);}
  finally {blocker.close();}
  c.recover();assert.equal(tasks(c).length,0);assert(!fs.existsSync(candidate.path));
});
test('abort defers cleanup until a later recovery, not while builder handles may exist',t=>{
  const root=fixture(t),c=new PortableCoordinator(root),writer=c.acquireWriter(),candidate=c.beginCandidate();
  const db=new DatabaseSync(candidate.path);db.exec('PRAGMA journal_mode=WAL;CREATE TABLE t(x)');
  c.abortCandidate(candidate);assert(fs.existsSync(candidate.path));assert.equal(tasks(c).length,1);readable(c);
  db.close();writer.release();c.recover();assert.equal(tasks(c).length,0);
});
for(const point of ['task-recorded','candidate-deleted']) test(`independent recovery crash at ${point} retains retry obligation`,t=>{
  const root=fixture(t),candidate=crashedCandidate(root);
  const source=`const fs=require('node:fs'); const rename=fs.renameSync,unlink=fs.unlinkSync;fs.renameSync=function(a,b){const r=rename.apply(this,arguments);if(process.argv[2]==='task-recorded'&&String(b).endsWith('.cleanup.json'))process.exit(72);return r;};fs.unlinkSync=function(a){const r=unlink.apply(this,arguments);if(process.argv[2]==='candidate-deleted'&&String(a).endsWith('candidate.db'))process.exit(72);return r;};const {PortableCoordinator}=require(${JSON.stringify(protocol)});new PortableCoordinator(process.argv[1]).recover();`;
  const child=spawnSync(process.execPath,['--no-warnings','-e',source,root,point],{encoding:'utf8',timeout:5000});assert.equal(child.status,72,child.stderr);
  const c=new PortableCoordinator(root);assert.equal(tasks(c).length,1);c.recover();readable(c);assert.deepEqual(tasks(c),[]);assert(!fs.existsSync(path.dirname(candidate.path)));
});
for(const point of ['prepared','old-moved','new-moved','committed']) test(`publication exit at ${point} recovers and reclaims task`,t=>{
  const root=fixture(t);
  const source=`const {DatabaseSync}=require('node:sqlite');const {PortableCoordinator}=require(${JSON.stringify(protocol)});const c=new PortableCoordinator(process.argv[1]);const writer=c.acquireWriter();const candidate=c.beginCandidate();const db=new DatabaseSync(candidate.path);db.exec('CREATE TABLE active(x);INSERT INTO active VALUES(43)');db.close();c.publish(candidate,{hook(phase){if(phase===process.argv[2])process.exit(73);}}).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});`;
  const child=spawnSync(process.execPath,['--no-warnings','-e',source,root,point],{encoding:'utf8',timeout:5000});assert.equal(child.status,73,child.stderr);
  const c=new PortableCoordinator(root);c.recover();c.recover();assert.equal(state(c).journal,null);assert.deepEqual(tasks(c),[]);
  assert(!fs.readdirSync(c.runtime).some(n=>/^[0-9a-f-]{36}$/.test(n)));
  const lease=c.acquireReader(),db=new DatabaseSync(c.active);try{assert.equal(db.prepare('SELECT x FROM active').get().x,['new-moved','committed'].includes(point)?43:42);}finally{db.close();lease.release();}
});
test('tampered cleanup task cannot delete outside its task directory',t=>{
  const root=fixture(t),candidate=crashedCandidate(root),c=new PortableCoordinator(root);
  fs.writeFileSync(path.join(path.dirname(candidate.path),'unknown'),'keep');c.recover();
  const task=path.join(c.runtime,tasks(c)[0]),record=JSON.parse(fs.readFileSync(task,'utf8'));record.record.path=c.active;fs.writeFileSync(task,JSON.stringify(record));
  c.recover();readable(c);assert.equal(tasks(c).length,1);assert(fs.existsSync(candidate.path));
});
test('hard-linked candidate artifact cannot mutate or delete the active database',t=>{
  const root=fixture(t),c=new PortableCoordinator(root),writer=c.acquireWriter(),candidate=c.beginCandidate();
  fs.linkSync(c.active,candidate.path);c.abortCandidate(candidate);writer.release();c.recover();
  assert.equal(tasks(c).length,1);readable(c);assert(fs.existsSync(candidate.path));
});
for(const mode of ['zero','unknown']) test(`publisher rejects ${mode} free space before allocating a candidate; sync falls back`,async t=>{
  process.env.CODEGRAPH_ALL_LANGUAGES='1';
  const {CodeGraph}=require(dist);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'portable-disk-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'main.ts'),'export function original(){return 1;}');
  const graph=await CodeGraph.init(root,{index:true});
  for(let i=0;i<8;i++) fs.writeFileSync(path.join(root,`added${i}.ts`),`export function addition${i}(){return ${i};}`);
  const probe=path.join(root,'probe.cjs'),log=path.join(root,'calls.txt');
  fs.writeFileSync(probe,`const fs=require('node:fs');fs.statfsSync=()=>{fs.appendFileSync(${JSON.stringify(log)},'called\\n');${mode==='unknown'?"throw new Error('capacity unavailable');":"return {bavail:0n,bsize:4096n};"}};`);
  const previous=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=`${previous||''} --require ${JSON.stringify(probe)}`;
  try {
    const result=await graph.sync({adaptiveFallback:{minChangedFiles:2,minChangedFraction:.5,minWorkFraction:.5,minAffectedOldNodes:2,minAffectedOldNodeFraction:.5}});
    assert.equal(result.complete,true);assert.equal(result.adaptive.strategy,'incremental');assert.match(result.adaptive.reason,/insufficient-or-unknown-free-disk/);
    assert(fs.readFileSync(log,'utf8').includes('called'));
    assert(graph.searchNodes('addition7').some(row=>row.node.name==='addition7'));
    const c=new PortableCoordinator(path.dirname(graph.getDatabaseFilePath()));assert.equal(state(c).journal,null);
    assert(!fs.readdirSync(c.runtime).some(n=>/^[0-9a-f-]{36}$/.test(n)),'disk refusal must not allocate a candidate');
  } finally {
    if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;
    graph.close();await graph.whenIdle();
  }
});
