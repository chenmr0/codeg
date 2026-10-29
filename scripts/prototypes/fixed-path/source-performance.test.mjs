import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { initialize, Participant, now } from './protocol.mjs';
import { buildGraph, graphAt } from './graph-adapter.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const holdWritersDuringCheck=process.env.SOURCE_HOLD_WRITERS==='1';
function launch(script,args){const child=fork(path.join(here,script),args,{execArgv:['--liftoff-only'],stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,CODEGRAPH_ALL_LANGUAGES:'1'}}),messages=[];let stderr='';child.stderr.on('data',b=>stderr+=b);child.stdout.resume();child.on('message',m=>messages.push(m));const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve(messages.find(m=>m.type==='result'||m.event==='result')):reject(new Error(`${script} ${code}: ${stderr}`)));});done.catch(()=>{});return{child,messages,done};}
async function until(fn){const deadline=Date.now()+30000;while(Date.now()<deadline){const v=fn();if(v)return v;await delay(5);}throw new Error('Timed out waiting for source-check event');}
function q(samples){const a=samples.slice().sort((a,b)=>a-b),at=f=>a[Math.ceil(a.length*f)-1]??0;return{count:a.length,p50Ms:at(.5),p95Ms:at(.95),p99Ms:at(.99),maxMs:a.at(-1)??0};}
test('continuous full-hash checker + compensation: 1001 files, five live query processes',{timeout:120000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'source-watch-load-')),p=initialize(root),count=1000;
 fs.writeFileSync(path.join(root,'main.py'),'def old_marker():\n    return 1\n');for(let i=0;i<count;i++)fs.writeFileSync(path.join(root,`file_${i}.py`),`def item_${i}(value=1):\n    return value\n`);await buildGraph(root,p.active);
 const clients=[];let watcher,writer;
 try{
  for(const role of ['CLI','MCP','daemon','SDK','worker']){const c=launch('graph-client.mjs',[root,role]);clients.push(c);await until(()=>c.messages.some(m=>m.type==='ready'));}
  watcher=launch('source-worker.mjs',['watch',root,JSON.stringify({pollMs:100,maxBuilds:2,holdWritersDuringCheck})]);
  await until(()=>watcher.messages.some(m=>m.phase==='hash-start'));
  writer=new Participant(root,file=>graphAt(root,file));const writeStarted=now();
  const admittedWrite=writer.write(g=>g.getStats()).then(()=>now()-writeStarted);
  await until(()=>watcher.messages.some(m=>m.event==='tick'&&m.result.status==='verified-observation'));const writeAdmissionMs=await admittedWrite;writer.close();writer=null;
  const editsStartedAtMs=Date.now();for(let i=0;i<count;i++)fs.writeFileSync(path.join(root,`file_${i}.py`),`def item_${i}(value=2,extra=3):\n    return value+extra\n`);fs.writeFileSync(path.join(root,'main.py'),'def new_marker():\n    return 2\n');const editCompleted=now(),editsCompletedAtMs=Date.now();
  await until(()=>watcher.messages.some(m=>m.event==='tick'&&m.result.status==='verified-observation'&&m.result.builds>=1));const convergenceMs=now()-editCompleted,convergenceObservedAtMs=Date.now();
  const ticksAfterChange=watcher.messages.filter(m=>m.event==='tick').length;await until(()=>watcher.messages.filter(m=>m.event==='tick').length>=ticksAfterChange+2);
  watcher.child.send('stop');await watcher.done;for(const c of clients)c.child.send('stop');const responses=await Promise.all(clients.map(c=>c.done));
  for(const r of responses){assert.deepEqual(r.errors,[]);assert(r.states.includes('old')&&r.states.includes('new'));}
  const ticks=watcher.messages.filter(m=>m.event==='tick').map(m=>m.result),checks=ticks.flatMap(t=>t.outcomes.filter(o=>o.type==='check')),publishes=ticks.flatMap(t=>t.outcomes.filter(o=>o.type==='publish'));
  const queries=q(responses.flatMap(r=>r.samples));const report={platform:process.platform,node:process.version,files:1001,timeline:{editsStartedAtMs,editsCompletedAtMs,convergenceObservedAtMs},pollMs:100,holdWritersDuringCheck,queries,checkTimes:q(checks.map(c=>c.checkMs).filter(Number.isFinite)),writeAdmissionMs,convergenceMs,publishes,checks:checks.map(c=>({status:c.status,changedFiles:c.changedFiles,checkMs:c.checkMs,startedAtMs:c.startedAtMs,finishedAtMs:c.finishedAtMs,stages:c.stages})),scope:'full-hash checker enabled; synthetic Python fixtures; writeAdmissionMs includes a no-op graph read under write admission, not mutation execution cost; no strict filesystem linearizability'};
  const out=process.env.SOURCE_EVIDENCE_DIR??path.resolve('artifacts/fixed-path-source-reconciliation');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,`source-performance-${holdWritersDuringCheck?'hold-writers-':''}${process.platform}.json`),JSON.stringify(report,null,2));
  assert(queries.maxMs<=1000,JSON.stringify(report));for(const pub of publishes)if(pub.status==='published')assert(pub.metrics.admissionPauseMs<=1000,JSON.stringify(pub));
 }finally{writer?.close();for(const c of clients)if(c.child.connected)c.child.kill('SIGKILL');if(watcher?.child.connected)watcher.child.kill('SIGKILL');}
});
