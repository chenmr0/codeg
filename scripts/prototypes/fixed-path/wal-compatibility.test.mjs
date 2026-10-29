import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import{DatabaseSync}from'node:sqlite';
import{paths,initialize,Participant}from'./protocol.mjs';import{fixture,snapshot}from'./worker.mjs';
function root(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wal-layout-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const digest=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
test('established DELETE coordinator is rejected without online conversion or graph mutation',t=>{
 const project=root(t),p=paths(project);fs.mkdirSync(p.runtime,{recursive:true});fixture(p.active,'A');const d=new DatabaseSync(p.gate);d.exec("CREATE TABLE state(id INTEGER PRIMARY KEY,mode TEXT);INSERT INTO state VALUES(1,'idle')");d.close();const before=digest(p.gate),graph=digest(p.active);
 assert.throws(()=>initialize(project),/Incompatible DELETE coordinator/);assert.equal(digest(p.gate),before);assert.equal(digest(p.active),graph);for(const file of[p.owner,p.connections,p.writers])assert(!fs.existsSync(file));
 const check=new DatabaseSync(p.gate);try{assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode,'delete');}finally{check.close();}
});
for(const kind of ['owner','connections','writers'])test(`WAL-mode ${kind} lease is rejected rather than weakening the OS fence`,async t=>{
 const project=root(t),p=initialize(project);fixture(p.active,'A');const bad=new DatabaseSync(p[kind]);assert.equal(bad.prepare('PRAGMA journal_mode=WAL').get().journal_mode,'wal');bad.close();let participant;
 try{
  if(kind==='owner')assert.throws(()=>new Participant(project,f=>new DatabaseSync(f)),/Lease database must use DELETE/);
  else{participant=new Participant(project,f=>new DatabaseSync(f));let actions=0;const action=d=>{actions++;return snapshot(d);};if(kind==='writers')await assert.rejects(participant.write(action),/Lease database must use DELETE/);else assert.throws(()=>participant.requestSync(action),/Lease database must use DELETE/);assert.equal(actions,0);assert.equal(participant.active,0);assert.equal(participant.handle,null);assert.equal(participant.holder,null);}
 }finally{if(participant){clearInterval(participant.timer);participant.closeHandle();participant.coordination?.close();participant.closed=true;}}
 const graph=new DatabaseSync(p.active);try{assert.deepEqual(snapshot(graph),{first:'A',second:'A'});}finally{graph.close();}
});
test('lost WAL state table with established leases is not recreated as idle',t=>{
 const project=root(t),p=initialize(project);fixture(p.active,'A');const before=digest(p.active),d=new DatabaseSync(p.gate);d.exec('DROP TABLE state');d.close();
 assert.throws(()=>initialize(project),/Missing coordination state/);const check=new DatabaseSync(p.gate);try{assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='state'").get(),undefined);}finally{check.close();}assert.equal(digest(p.active),before);
});
