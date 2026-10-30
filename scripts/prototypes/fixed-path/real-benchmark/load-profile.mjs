/** Fixed-arrival real CodeGraph load. Diagnostic timings only; protocol unchanged. */
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Participant } from '../protocol.mjs';
import { graphAt } from '../graph-adapter.mjs';
import { createRequestJournal } from './request-journal.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const [mode,root,out,operation]=process.argv.slice(2);
const intervalMs=Number(process.env.BENCHMARK_QUERY_INTERVAL_MS??500);
const clientsCount=5;
const patterns=['ObServer','ObTenant','ObObj','ObString','ObTableSchema'];
const epoch=()=>performance.timeOrigin+performance.now();
const quantile=xs=>{const a=xs.slice().sort((x,y)=>x-y);return {count:a.length,p50Ms:a[Math.ceil(a.length*.5)-1]??null,p95Ms:a[Math.ceil(a.length*.95)-1]??null,p99Ms:a[Math.ceil(a.length*.99)-1]??null,maxMs:a.at(-1)??null};};
const errorRecord=e=>({name:e.name,message:e.message,stack:e.stack,code:e.code,errcode:e.errcode,gateDiagnostic:e.gateDiagnostic,cause:e.cause?String(e.cause):undefined});

if(mode==='client'){
  const rows=[],errors=[],opens=[];
  const journal=await createRequestJournal(`${out}.ndjson`);
  journal.append({type:'start',at:epoch(),pid:process.pid,intervalMs,root});
  const p=new Participant(root,file=>{const t=performance.now();const g=graphAt(root,file,{readOnly:true});opens.push({at:epoch(),ms:performance.now()-t});return g;});
  let run=true,target=performance.now(),stoppedAt;const offeredStart=target;
  process.on('message',m=>{if(m==='stop'){run=false;stoppedAt=performance.now();}});
  process.send?.({type:'ready'});
  try { while(run){
    // setTimeout may fire slightly early. Wait again rather than credit negative queue delay.
    while(run && performance.now()<target)await delay(Math.max(1,target-performance.now()));
    if(!run)break;
    const start=performance.now(),at=epoch(),requestIndex=rows.length+errors.length;
    const pattern=patterns[requestIndex%patterns.length];
    const timing={};let actionStartedAt,actionEndedAt;
    try{
      const result=await p.request(g=>{
        actionStartedAt=performance.now();timing.admissionAndOpenMs=actionStartedAt-start;
        let t=performance.now();const a=g.queries.getFileByPath('src/observer/ob_server.cpp')?.contentHash;timing.beforeFileHashMs=performance.now()-t;
        t=performance.now();const hits=g.searchNodes(pattern,{limit:5});timing.searchMs=performance.now()-t;
        const nodeTimes=[];t=performance.now();const nodes=hits.map(h=>{const s=performance.now(),n=g.getNode(h.node.id);nodeTimes.push(performance.now()-s);return n;});timing.getNodesMs=performance.now()-t;timing.getNodeCallsMs=nodeTimes;
        t=performance.now();const b=g.queries.getFileByPath('src/observer/ob_server.cpp')?.contentHash;timing.afterFileHashMs=performance.now()-t;
        actionEndedAt=performance.now();timing.actionMs=actionEndedAt-actionStartedAt;
        return {a,b,hits:hits.length,missing:nodes.filter(n=>!n).length};
      });
      const end=performance.now();timing.finishAndPromiseMs=end-actionEndedAt;
      rows.push({requestIndex,pattern,at,finishedAt:performance.timeOrigin+end,scheduledAt:performance.timeOrigin+target,scheduledDelayMs:Math.max(0,start-target),wallMs:end-start,latencyMs:end-target,...timing,...result});
    }catch(e){const end=performance.now();errors.push({requestIndex,pattern,at,finishedAt:performance.timeOrigin+end,wallMs:end-start,latencyMs:end-target,...timing,error:errorRecord(e)});}
    // Captured after timing ends, but any logging pressure affects the next scheduled latency.
    journal.append({type:'request',outcome:errors.at(-1)?.requestIndex===requestIndex?'error':'success',record:errors.at(-1)?.requestIndex===requestIndex?errors.at(-1):rows.at(-1)});
    target+=intervalMs;
  }
  } catch(e) { errors.push({at:epoch(),phase:'journal-or-client-loop',error:errorRecord(e)}); }
  let closeError;try{p.close();}catch(e){closeError=errorRecord(e);}
  const report={rows,errors,opens,closeError,offeredStart,stoppedAt,offeredRequests:Math.max(0,Math.floor(((stoppedAt??performance.now())-offeredStart)/intervalMs)+1),completedRequests:rows.length+errors.length,pendingScheduled:Math.max(0,Math.floor(((stoppedAt??performance.now())-target)/intervalMs)+1),stopPolicy:'Stop new admission on stop; finish admitted request; count every pending scheduled arrival separately.',reopens:p.reopens,reopenDurationsMs:p.reopenDurationsMs,admissionWaitMs:p.admissionWaitMs,service:quantile(rows.map(r=>r.wallMs)),latency:quantile(rows.map(r=>r.latencyMs))};
  journal.append({type:'stop',at:epoch(),completedRequests:report.completedRequests,closeError});
  report.journal=await journal.close();
  fs.writeFileSync(out,JSON.stringify(report));
  process.send?.({type:'result',errorCount:errors.length},()=>process.disconnect());
}else{
  const clients=[],events=[];let worker,operationError,startedAt,finishedAt;
  function launch(script,args){
    const child=fork(script,args,{execArgv:['--liftoff-only'],stdio:['ignore','inherit','inherit','ipc']});
    let readyResolve,readyReject;const ready=new Promise((ok,no)=>{readyResolve=ok;readyReject=no;});ready.catch(()=>{});
    child.on('message',m=>{events.push({at:epoch(),pid:child.pid,...m});if(m.type==='ready')readyResolve();});
    const done=new Promise((ok,no)=>{child.on('error',e=>{readyReject(e);no(e);});child.on('close',(code,signal)=>{if(code===0)ok();else{const e=new Error(`${script} code=${code} signal=${signal}`);readyReject(e);no(e);}});});done.catch(()=>{});
    return {child,ready,done};
  }
  try{
    for(let i=0;i<clientsCount;i++){const c=launch(fileURLToPath(import.meta.url),['client',root,`${out}.client-${i}.json`]);clients.push(c);await c.ready;}
    await delay(2000);startedAt=epoch();
    if(operation==='idle')await delay(Number(process.env.BENCHMARK_IDLE_MS??30000));
    else{worker=launch(path.join(here,'worker.mjs'),[operation,root,`${out}.operation.json`]);await worker.done;}
    finishedAt=epoch();await delay(2500);
  }catch(e){operationError=errorRecord(e);finishedAt=epoch();}
  finally{
    for(const c of clients)if(c.child.connected)c.child.send('stop');
    await Promise.allSettled(clients.map(c=>c.done));
    const reports=clients.map((_,i)=>{const file=`${out}.client-${i}.json`;return fs.existsSync(file)?JSON.parse(fs.readFileSync(file)): {rows:[],errors:[{error:{message:'Client result missing'}}],missingResult:true};});
    const all=reports.flatMap((r,i)=>r.rows.map(row=>({...row,client:i}))),during=all.filter(r=>r.at>=startedAt&&r.at<=finishedAt);
    const summary={schema:2,clock:'performance.timeOrigin + performance.now; Date.now child publication hooks retained; monotonic durations per process',startedAt,finishedAt,operation,operationError,offeredQps:clientsCount*1000/intervalMs,intervalMs,clients:clientsCount,operationWindowCount:during.length,totalSuccessfulRequests:all.length,service:quantile(during.map(r=>r.wallMs)),scheduledLatency:quantile(during.map(r=>r.latencyMs)),wholeLifetimeService:quantile(all.map(r=>r.wallMs)),wholeLifetimeScheduled:quantile(all.map(r=>r.latencyMs)),byPattern:Object.fromEntries(patterns.map(p=>[p,quantile(during.filter(r=>r.pattern===p).map(r=>r.wallMs))])),stageQuantiles:Object.fromEntries(['admissionAndOpenMs','beforeFileHashMs','searchMs','getNodesMs','afterFileHashMs','actionMs','finishAndPromiseMs'].map(p=>[p,quantile(during.map(r=>r[p]))])),errors:reports.flatMap(r=>r.errors),closeErrors:reports.flatMap(r=>r.closeError?[r.closeError]:[]),mixedHashReads:all.filter(r=>r.a!==r.b).length,observedHashes:[...new Set(all.map(r=>r.a))],perClientHashes:reports.map(r=>[...new Set(r.rows.map(x=>x.a))]),reopens:reports.map(r=>r.reopens),offeredRequests:reports.reduce((n,r)=>n+(r.offeredRequests??0),0),completedRequests:reports.reduce((n,r)=>n+(r.completedRequests??0),0),pendingScheduled:reports.reduce((n,r)=>n+(r.pendingScheduled??0),0),journal:reports.map(r=>r.journal),missingNodeReads:all.reduce((n,r)=>n+r.missing,0),slowest:all.slice().sort((a,b)=>b.latencyMs-a.latencyMs).slice(0,20),events};
    fs.writeFileSync(out,JSON.stringify(summary,null,2));
    if(operationError || summary.errors.length || summary.closeErrors.length)process.exitCode=1;
  }
}
