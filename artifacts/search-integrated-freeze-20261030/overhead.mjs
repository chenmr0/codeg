import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {performance}from'node:perf_hooks';
import {buildGraph,graphAt}from'../../scripts/prototypes/fixed-path/graph-adapter.mjs';
import {timedSearch}from'../../scripts/prototypes/fixed-path/real-benchmark/search-timing.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'search-observer-overhead-')),file=path.join(root,'graph.db');
fs.writeFileSync(path.join(root,'main.py'),'class ObServer:\n    pass\n');await buildGraph(root,file);
const plain=graphAt(root,file,{readOnly:true}),observed=graphAt(root,file,{readOnly:true});const rows=[];
try{for(let round=0;round<20;round++){const row={round};for(const mode of round%2?['observed','plain']:['plain','observed']){const g=mode==='plain'?plain:observed;const t=performance.now();for(let n=0;n<100;n++)mode==='plain'?g.searchNodes('ObServer',{limit:5}):timedSearch(g,'ObServer',{limit:5},{});row[mode+'MsPerQuery']=(performance.now()-t)/100;}rows.push(row);}}finally{plain.close();observed.close();fs.rmSync(root,{recursive:true,force:true});}
const median=a=>a.toSorted((x,y)=>x-y)[Math.floor(a.length/2)];console.log(JSON.stringify({scope:'small warm fixture; alternating batches, not large-repository gate or causal latency guarantee',rounds:20,callsPerBatch:100,rows,medianPlainMs:median(rows.map(r=>r.plainMsPerQuery)),medianObservedMs:median(rows.map(r=>r.observedMsPerQuery)),medianPairedDeltaMs:median(rows.map(r=>r.observedMsPerQuery-r.plainMsPerQuery))},null,2));
