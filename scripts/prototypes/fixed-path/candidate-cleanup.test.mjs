/** Crashed real-indexer lock artifact; only the isolated prototype is changed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {initialize,beginOperation,recover,records,sha,gate} from './protocol.mjs';
import {fixture} from './worker.mjs';
const self=fileURLToPath(import.meta.url);
if(process.env.CANDIDATE_CLEANUP_CHILD==='1'){
 const op=beginOperation(process.env.CANDIDATE_CLEANUP_ROOT);
 // Same FileLock implementation/filename used by the actual indexer. Never
 // release it: SIGKILL below reproduces interruption during a partial build.
 const {FileLock}=createRequire(import.meta.url)('../../../dist/utils.js');
 const lock=new FileLock(path.join(op.record.directory,'codegraph.lock'));lock.acquire();
 fixture(op.record.candidate,'partial');
 const db=new DatabaseSync(op.record.candidate);db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO writes VALUES('incomplete')");
 globalThis.crashedBuilderResources={op,lock,db};
 process.send({record:op.record});setInterval(()=>{},1000);
}else{
 function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'candidate-cleanup-')),p=initialize(root);fixture(p.active,'A');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,p,active:sha(p.active)};}
 test('live candidate builder is protected; after process crash recovery removes real indexer lock and dirty candidate',async t=>{
  const {root,p,active}=setup(t);
  const child=fork(self,[],{execArgv:['--liftoff-only'],env:{...process.env,CANDIDATE_CLEANUP_CHILD:'1',CANDIDATE_CLEANUP_ROOT:root},stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);t.after(()=>child.kill('SIGKILL'));
  const message=once(child,'message');const exited=once(child,'exit');
  const [{record}]=await Promise.race([message,exited.then(e=>{throw new Error(`builder exited ${e}: ${stderr}`);})]);
  const lock=path.join(record.directory,'codegraph.lock');assert.match(fs.readFileSync(lock,'utf8'),/^\d+\n[0-9a-f-]{36}\n$/);
  assert(fs.existsSync(record.candidate+'-wal'));const names=fs.readdirSync(record.directory);
  assert.equal(recover(root),false,'live publisher OS lease prevents any recovery/cleanup');assert.deepEqual(fs.readdirSync(record.directory),names);assert.equal(sha(p.active),active);
  child.kill('SIGKILL');await exited;
  assert.equal(recover(root),true);assert.equal(records(p).find(r=>r.id===record.id).phase,'cleaned');assert.equal(fs.existsSync(record.directory),false);assert.equal(sha(p.active),active);
  assert.equal(recover(root),true,'restart retry is idempotent');assert.equal(sha(p.active),active);
 });
 for(const kind of ['partial-lock','unexpected-file','directory-lock','symlink-lock','sealed-lock'])test(`aborted candidate cleanup: ${kind}`,t=>{
  const {root,p,active}=setup(t),op=beginOperation(root),r=op.record;
  fixture(r.candidate,'partial');const lock=path.join(r.directory,'codegraph.lock');
  if(kind==='directory-lock')fs.mkdirSync(lock);
  else if(kind==='symlink-lock')fs.symlinkSync(p.active,lock);
  else fs.writeFileSync(lock,kind==='partial-lock'?'':'123\n00000000-0000-0000-0000-000000000000\n');
  if(kind==='unexpected-file')fs.writeFileSync(path.join(r.directory,'unknown'),'evidence');
  if(kind==='sealed-lock'){r.candidateIdentity=sha(r.candidate);r.phase='prepared';gate(p,g=>g.prepare('UPDATE operations SET record=? WHERE id=?').run(JSON.stringify(r),r.id));}
  const before=fs.readdirSync(r.directory);op.owner.close();assert.equal(recover(root),true);
  if(kind==='partial-lock'){assert.equal(fs.existsSync(r.directory),false);assert.equal(records(p).find(x=>x.id===r.id).phase,'cleaned');}
  else{assert.deepEqual(fs.readdirSync(r.directory),before,'all evidence retained, not partially deleted');assert.equal(records(p).find(x=>x.id===r.id).phase,'aborted');assert(fs.existsSync(r.candidate));}
  assert.equal(sha(p.active),active);
 });
}
