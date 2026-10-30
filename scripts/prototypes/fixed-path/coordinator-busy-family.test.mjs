import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initialize, Participant, gate, now } from './protocol.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-busy-family-'));
  const p=initialize(root);
  const clients=[];t.after(()=>{try{for(const client of clients)client.close();}finally{fs.rmSync(root,{recursive:true,force:true});}});
  return {root,p,clients};
}
function opener(t,kind) {
  const {root,p,clients}=fixture(t);
  if(kind==='initialize')return {p,run:()=>initialize(root)};
  const client=new Participant(root,()=>{throw Error('native factory must not run');},{pollMs:100000});
  clearInterval(client.timer);client.coordination.close();client.coordination=null;
  clients.push(client);
  return {p,run:()=>client.readSnapshot(d=>d.prepare('SELECT mode FROM state WHERE id=1').get())};
}
function injectOpen(code,count,run) {
  const original=DatabaseSync.prototype.prepare;
  let calls=0;const failure=Object.assign(Error(`injected coordinator preopen ${code}`),{errcode:code});
  DatabaseSync.prototype.prepare=function(sql){
    if(sql==='PRAGMA journal_mode' && ++calls<=count)throw failure;
    return original.call(this,sql);
  };
  try{return {result:run(),calls,failure};}catch(error){return {error,calls,failure};}
  finally{DatabaseSync.prototype.prepare=original;}
}
for(const kind of ['initialize','persistent reader reopen']) {
  test(`${kind}: BUSY extended primary family retries only preopen then succeeds`,t=>{
    for(const code of [5,261,517,773]) {
      const {run}=opener(t,kind);const result=injectOpen(code,2,run);
      assert.ifError(result.error);assert.equal(result.calls,3,`code ${code}: exactly two failed opens`);
      if(kind!=='initialize')assert.equal(result.result.mode,'idle');
    }
  });
  test(`${kind}: persistent BUSY_RECOVERY exhausts unchanged 500ms open budget`,t=>{
    const {run}=opener(t,kind),start=now(),result=injectOpen(261,Infinity,run),elapsed=now()-start;
    assert(result.error);assert(result.error===result.failure || result.error.code==='ADMISSION_TIMEOUT');
    assert(result.calls>2);assert(elapsed>=490,`budget unexpectedly shortened: ${elapsed}`);
    assert(elapsed<1000,`500ms open retry consumed request budget: ${elapsed}`);
    assert.doesNotThrow(run,'failed opens are closed and a subsequent attempt remains usable');
  });
  test(`${kind}: LOCKED, IOERR, corruption and invalid codes fail once without retry`,t=>{
    for(const code of [6,262,10,1546,11,-251,'261']) {
      const {run}=opener(t,kind),result=injectOpen(code,Infinity,run);
      assert.equal(result.error,result.failure,`preserve original ${code} error`);
      assert.equal(result.calls,1,`must not retry ${code}`);
      assert.doesNotThrow(run);
    }
  });
  test(`${kind}: successful BUSY retry never bypasses journal-mode validation`,t=>{
    const {run}=opener(t,kind),original=DatabaseSync.prototype.prepare;let calls=0;
    DatabaseSync.prototype.prepare=function(sql){
      if(sql==='PRAGMA journal_mode') {
        if(++calls===1)throw Object.assign(Error('recovery busy'),{errcode:261});
        return {get:()=>({journal_mode:'delete'})};
      }
      return original.call(this,sql);
    };
    try{assert.throws(run,/Incompatible DELETE coordinator/);assert.equal(calls,3,'one BUSY, initial mode and transactional refreshed mode');}
    finally{DatabaseSync.prototype.prepare=original;}
    assert.doesNotThrow(run);
  });
}
for(const phase of ['action','COMMIT'])test(`extended BUSY in gate ${phase} is not promoted to preopen retry`,t=>{
  const {p}=fixture(t),failure=Object.assign(Error('extended BUSY after admission'),{errcode:261});
  let actions=0,commits=0;const original=DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec=function(sql){if(phase==='COMMIT'&&sql==='COMMIT'){commits++;throw failure;}return original.call(this,sql);};
  try{assert.throws(()=>gate(p,d=>{actions++;d.prepare('UPDATE state SET revision=revision+1 WHERE id=1').run();if(phase==='action')throw failure;}),e=>e===failure);}
  finally{DatabaseSync.prototype.exec=original;}
  assert.equal(actions,1);assert.equal(commits,phase==='COMMIT'?1:0);
  assert.equal(gate(p,d=>d.prepare('SELECT revision FROM state WHERE id=1').get().revision),0,'failed operation rolled back without replay');
});
