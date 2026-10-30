import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequestJournal } from './request-journal.mjs';

async function fixture(t) { const d=await fs.mkdtemp(path.join(os.tmpdir(),'request-journal-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return path.join(d,'requests.ndjson'); }
async function records(file) { return (await fs.readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)); }

test('async batches preserve all request order and normal close drains',async t=>{
 const file=await fixture(t),j=await createRequestJournal(file,{batchRows:7});
 for(let i=0;i<101;i++)j.append({i,unicode:'查询',outcome:i%2?'error':'success'});
 const m=await j.close();assert.deepEqual((await records(file)).map(x=>x.i),Array.from({length:101},(_,i)=>i));assert.equal(m.records,101);assert.equal(m.writtenRecords,101);assert.equal(m.bytes,(await fs.stat(file)).size);assert.ok(m.batches>1);assert.throws(()=>j.append({}),/closed/);
});
test('timer persists partial batch while producer is still running',async t=>{
 const file=await fixture(t),j=await createRequestJournal(file,{intervalMs:10,batchRows:32});
 try{j.append({i:1});const deadline=Date.now()+2000;while((await fs.stat(file)).size===0&&Date.now()<deadline)await delay(10);assert.deepEqual(await records(file),[{i:1}]);}finally{await j.close();}
});
test('existing evidence is not truncated',async t=>{
 const file=await fixture(t);await fs.writeFile(file,'original\n');await assert.rejects(createRequestJournal(file),{code:'EEXIST'});assert.equal(await fs.readFile(file,'utf8'),'original\n');
});
test('bounded backlog refuses silent loss',async t=>{
 const file=await fixture(t),j=await createRequestJournal(file,{maxPendingBytes:20});
 j.append({i:1});assert.throws(()=>j.append({text:'x'.repeat(100)}),/backlog exceeded/);await j.close();assert.deepEqual(await records(file),[{i:1}]);
});
test('flushed records survive producer SIGKILL without final report',async t=>{
 const file=await fixture(t),script=path.join(path.dirname(file),'child.mjs');
 await fs.writeFile(script,`import{createRequestJournal}from ${JSON.stringify(new URL('./request-journal.mjs',import.meta.url).href)};const j=await createRequestJournal(process.argv[2]);for(let i=0;i<40;i++)j.append({i});await j.flush();process.send('flushed');setInterval(()=>{},1000);`);
 const child=fork(script,[file],{stdio:['ignore','pipe','pipe','ipc']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('Exited before flush')));});child.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');assert.deepEqual((await records(file)).map(x=>x.i),Array.from({length:40},(_,i)=>i));
});
