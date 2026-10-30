import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildGraph } from './graph-adapter.mjs';
import { initialize, seal } from './protocol.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
function launch(script,args){
 const child=fork(path.join(here,script),args,{execArgv:['--liftoff-only'],stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,CODEGRAPH_ALL_LANGUAGES:'1'}}), messages=[];let stderr='';child.stderr.on('data',b=>stderr+=b);child.stdout.resume();let readyResolve;
 const ready=new Promise(r=>readyResolve=r);child.on('message',m=>{messages.push(m);if(m.type==='ready')readyResolve(m);});
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>{const result=messages.find(m=>m.type==='result');if(code!==0||!result)reject(new Error(`${script} closed ${code}, missing result=${!result}: ${stderr}`));else resolve(result);});});
 return{child,ready,done,messages};
}
function q(samples){const a=samples.slice().sort((a,b)=>a-b);const at=f=>a[Math.ceil(a.length*f)-1];return{count:a.length,p50Ms:at(.5),p95Ms:at(.95),p99Ms:at(.99),maxMs:a.at(-1)};}
test('real CodeGraph 1001-file background rebuild with five live query processes',{timeout:120000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fixed-graph-load-')),p=initialize(root);const count=Number(process.env.FIXED_PATH_PERF_FILES??1000);
 fs.writeFileSync(path.join(root,'main.py'),'def old_marker():\n    return 1\n');
 for(let i=0;i<count;i++)fs.writeFileSync(path.join(root,`file_${i}.py`),`def item_${i}(a=1):\n    return a\n`);
 await buildGraph(root,p.active);seal(p.active);const clients=[];let result;
 try {
  for(const role of ['CLI','MCP','daemon','SDK','background-worker']){const c=launch('graph-client.mjs',[root,role]);clients.push(c);await c.ready;}
  await delay(300);
  for(let i=0;i<count;i++)fs.writeFileSync(path.join(root,`file_${i}.py`),`def item_${i}(a=2,b=3):\n    return a+b\n`);
  fs.writeFileSync(path.join(root,'main.py'),'def new_marker():\n    return 2\n');
  const publisher=launch('graph-publish.mjs',[root]);result=(await publisher.done).result;assert.equal(result.status,'published',JSON.stringify(result));
  await delay(300);for(const c of clients)c.child.send('stop');const measurements=await Promise.all(clients.map(c=>c.done));
  for(const r of measurements){assert.deepEqual(r.errors,[]);assert(r.states.includes('old')&&r.states.includes('new'));assert(r.reopens>=2);}
  const queries=q(measurements.flatMap(m=>m.samples));
  const report={platform:process.platform,node:process.version,files:count+1,fixture:root,publish:result,queries,roles:measurements.map(m=>({role:m.role,queries:q(m.samples),reopens:m.reopens,reopenDurationsMs:m.reopenDurationsMs,admissionWait:q(m.admissionWaitMs),gateMetrics:m.gateMetrics})),scope:'Real CodeGraph operations through isolated adapters; not production entrypoints; no large-repository claim'};
  const dir=process.env.FIXED_PATH_EVIDENCE_DIR??path.resolve('artifacts/fixed-path-prototype');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,`graph-performance-${process.platform}.json`),JSON.stringify(report,null,2));
  assert(result.metrics.admissionPauseMs<=1000,JSON.stringify(report));assert(queries.maxMs<=1000,JSON.stringify(report));
 }finally{for(const c of clients)if(c.child.connected)c.child.kill('SIGKILL');}
});
