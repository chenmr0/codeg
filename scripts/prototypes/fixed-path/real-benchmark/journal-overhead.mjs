/** Diagnostic only: scheduled synthetic records, NOT a CodeGraph query gate. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequestJournal} from './request-journal.mjs';
const out=process.argv[2];if(!out)throw Error('Evidence directory required');await fs.mkdir(out,{recursive:false});
const runs=[];const q=xs=>{const a=xs.slice().sort((a,b)=>a-b);return {p50:a[Math.ceil(a.length*.5)-1],p95:a[Math.ceil(a.length*.95)-1],max:a.at(-1)}};
const record={type:'request',outcome:'success',record:{requestIndex:0,pattern:'ObTenant',at:1793323015000,finishedAt:1793323015123,scheduledAt:1793323015000,scheduledDelayMs:0.3,wallMs:123,latencyMs:123.3,admissionAndOpenMs:2.3,beforeFileHashMs:1.2,searchMs:115,getNodesMs:2.5,getNodeCallsMs:[.1,.2,.4,.5,1.3],afterFileHashMs:1.3,actionMs:120,finishAndPromiseMs:.7,a:'a'.repeat(64),b:'a'.repeat(64),hits:5,missing:0}};
await fs.writeFile(path.join(out,'plan.json'),JSON.stringify({rounds:3,order:['baseline','journal','journal','baseline','baseline','journal'],requestsPerRun:100,intervalMs:100,scope:'10 QPS synthetic evidence serialization/write scheduling; no claim about real database query latency'},null,2));
for(const [i,enabled] of [false,true,true,false,false,true].entries()){
 const j=enabled?await createRequestJournal(path.join(out,`run-${i}.ndjson`)):null,enqueue=[],lag=[];const start=performance.now();
 for(let n=0;n<100;n++){const target=start+n*100;while(performance.now()<target)await delay(Math.max(1,target-performance.now()));lag.push(performance.now()-target);record.record.requestIndex=n;const before=performance.now();j?.append(record);enqueue.push(performance.now()-before);}
 const metrics=await j?.close();runs.push({i,enabled,totalMs:performance.now()-start,enqueueMs:q(enqueue),scheduledLagMs:q(lag),metrics});await fs.writeFile(path.join(out,'results.json'),JSON.stringify({node:process.version,platform:process.platform,runs},null,2));
}
console.log(JSON.stringify(runs,null,2));
