/** Deterministic real-process cold-bootstrap interleaving, no fabricated mode. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { initialize, paths, state, sha } from './protocol.mjs';

function temporary(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-bootstrap-race-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}

test('stale initial DELETE observation accepts another process completed WAL bootstrap without conversion',t=>{
 const root=temporary(t),p=paths(root),original=DatabaseSync.prototype.prepare;
 let armed=true,initialMode,child,conversions=0,probeInTransaction=false;
 const protocol=new URL('./protocol.mjs',import.meta.url).href;
 DatabaseSync.prototype.prepare=function(sql){
  const statement=original.call(this,sql);
  if(sql==='PRAGMA journal_mode=WAL')conversions++;
  if(armed&&sql==='PRAGMA journal_mode')return {get:()=>{
   const result=statement.get();initialMode=result.journal_mode;armed=false;
   // get() has finished and released its read lock. The child performs real
   // initialize(), creates state and leases, and exits before our caller sees
   // its earlier DELETE result. No fake SQL result or fake lock is returned.
   child=spawnSync(process.execPath,['--input-type=module','-e',`import{initialize}from ${JSON.stringify(protocol)};initialize(${JSON.stringify(root)});`],{encoding:'utf8',timeout:15000});
   assert.equal(child.status,0,child.stderr);
   return result;
  }};
  if(sql==="SELECT name FROM sqlite_master WHERE name='state'"){
   probeInTransaction ||= this.isTransaction;
  }
  return statement;
 };
 try{assert.doesNotThrow(()=>initialize(root));}finally{DatabaseSync.prototype.prepare=original;}
 assert.equal(initialMode,'delete','must exercise the cached initial DELETE branch');
 assert.equal(conversions,0,'parent must adopt confirmed WAL, not convert an established coordinator');
 assert.equal(probeInTransaction,true,'mode and schema revalidation must be protected by a read transaction');
 assert.equal(state(p).mode,'idle');
 for(const file of[p.owner,p.connections,p.writers]){const db=new DatabaseSync(file);try{assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'delete');assert.equal(db.prepare('SELECT value FROM lease').get().value,1);}finally{db.close();}}
});

for(const established of [true,false])test(`real DELETE ${established?'state':'existing lease evidence'} still fails without migration or evidence changes`,t=>{
 const root=temporary(t),p=paths(root);fs.mkdirSync(p.runtime,{recursive:true});
 const db=new DatabaseSync(p.gate);db.exec(established?'CREATE TABLE state(id INTEGER PRIMARY KEY,mode TEXT);INSERT INTO state VALUES(1,\'idle\')':'CREATE TABLE unrelated(value INTEGER)');db.close();
 if(!established)fs.writeFileSync(p.connections,'existing lease evidence');
 const before=sha(p.gate),leaseBefore=fs.existsSync(p.connections)?sha(p.connections):null;
 assert.throws(()=>initialize(root),/Incompatible DELETE coordinator/);
 assert.equal(sha(p.gate),before);
 if(leaseBefore)assert.equal(sha(p.connections),leaseBefore);
 const check=new DatabaseSync(p.gate);try{assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode,'delete');}finally{check.close();}
 assert.equal(fs.existsSync(p.owner),false);assert.equal(fs.existsSync(p.writers),false);
});
