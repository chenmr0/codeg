import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initialize, state, now } from './protocol.mjs';
const schema="SELECT name FROM sqlite_master WHERE name='state'";
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bootstrap-schema-busy-')),p=initialize(root);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{root,p};}
function inject(phase,code,count,run){
 const prepare=DatabaseSync.prototype.prepare,close=DatabaseSync.prototype.close,exec=DatabaseSync.prototype.exec;
 let calls=0,closes=0,writes=0;const attempts=[],failure=Object.assign(Error(`schema probe ${phase} injected failure`),{errcode:code});
 function hit(){attempts.push({closes});if(++calls<=count)throw failure;}
 DatabaseSync.prototype.prepare=function(sql){if(sql===schema&&phase==='prepare')hit();const stmt=prepare.call(this,sql);if(sql===schema&&phase==='get')return{get(...args){hit();return stmt.get(...args);}};return stmt;};
 DatabaseSync.prototype.close=function(){closes++;return close.call(this);};
 DatabaseSync.prototype.exec=function(sql){if(sql.includes('BEGIN IMMEDIATE')||sql.includes('CREATE TABLE lease'))writes++;return exec.call(this,sql);};
 try{return{result:run(),calls,closes,writes,attempts};}catch(error){return{error,failure,calls,closes,writes,attempts};}
 finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.close=close;DatabaseSync.prototype.exec=exec;}
}
for(const phase of ['prepare','get']){
 for(const code of [5,261,517,773])test(`bootstrap schema ${phase}: retries BUSY family ${code} after closing failed handles`,t=>{
  const{root,p}=fixture(t),result=inject(phase,code,2,()=>initialize(root));assert.ifError(result.error);assert.equal(result.calls,3);assert.equal(result.closes,3);assert.deepEqual(result.attempts.map(a=>a.closes),[0,1,2]);assert.equal(result.writes,0,'only a read-only admission probe is retried');assert.equal(state(p).revision,0);
 });
 test(`bootstrap schema ${phase}: persistent BUSY exhausts original 500 ms total open/read budget`,t=>{
  const{root,p}=fixture(t),start=now(),result=inject(phase,261,Infinity,()=>initialize(root)),elapsed=now()-start;
  assert.equal(result.error,result.failure);assert(result.calls>2);assert.equal(result.closes,result.calls);assert.equal(result.writes,0);assert(elapsed>=490,`budget prematurely cut: ${elapsed}`);assert(elapsed<1000,`budget stacked or enlarged: ${elapsed}`);assert.doesNotThrow(()=>initialize(root));assert.equal(state(p).revision,0);
 });
 test(`bootstrap schema ${phase}: LOCKED, IOERR, corruption and invalid codes fail once`,t=>{
  const{root}=fixture(t);for(const code of [6,262,10,1546,11,-251,'261']){const result=inject(phase,code,Infinity,()=>initialize(root));assert.equal(result.error,result.failure);assert.equal(result.calls,1);assert.equal(result.closes,1);assert.equal(result.writes,0);assert.doesNotThrow(()=>initialize(root));}
 });
}
