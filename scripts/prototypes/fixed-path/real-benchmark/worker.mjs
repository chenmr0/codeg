import fs from 'node:fs';import path from 'node:path';import {performance} from 'node:perf_hooks';import {createRequire} from 'node:module';
import {buildGraph,graphAt,prepareGrammars} from '../graph-adapter.mjs';
import {initialize,seal,Participant} from '../protocol.mjs';
import {reconcileSource,checkSource} from '../source-reconciliation.mjs';
const require=createRequire(import.meta.url),adaptive=require('../../../../dist/sync/adaptive-plan.js');
// Even post-operation statistics are database requests: use a real lease and
// the normal Participant shutdown (which lets SQLite retire its sidecars).
async function readActive(action){const participant=new Participant(root,file=>graphAt(root,file,{readOnly:true}));try{return await participant.request(action);}finally{participant.close();}}
const [mode,root,out,destination]=process.argv.slice(2); const t=performance.now(),startedAt=Date.now(),p=initialize(root);let result;
try{
 if(mode==='init'){result=await buildGraph(root,destination??p.active);seal(destination??p.active,{standalone:true});}
 else if(mode==='sync'){await prepareGrammars();const participant=new Participant(root,file=>graphAt(root,file));try{result=await participant.write(g=>g.sync({adaptive:false}));}finally{participant.close();}}
 else if(mode==='check')result=await checkSource(root);
 else if(mode==='rebuild')result=await reconcileSource(root,{maxBuilds:1,hook:phase=>process.send?.({event:'phase',phase,at:Date.now()})});
 else if(mode==='plan'){result=await readActive(async g=>{const plan=await adaptive.createAdaptivePlan(root,g.queries.getAllFiles(),{runtimeKey:adaptive.adaptiveRuntimeKey(root,'node-sqlite'),fullHash:true});const history=adaptive.readAdaptiveHistory(root);const decision=adaptive.chooseAdaptiveStrategy(plan,history,{configFingerprint:g.queries.getMetadata('adaptive:index-config-v1')});return {...plan,snapshot:{...plan.snapshot,files:undefined},decision,history};});}
 const operationFinishedAt=Date.now(),operationMs=performance.now()-t;const summarize=g=>({stats:g.getStats(),completeness:g.getIndexCompleteness()});let summary;
 // A detached init output has already been sealed standalone and is not the
 // active database. All active-path stats, including after sync, participate.
 if(mode==='init' && destination && path.resolve(destination)!==path.resolve(p.active)){const graph=graphAt(root,destination,{readOnly:true});try{summary=summarize(graph);}finally{graph.close();}}
 else summary=await readActive(summarize);
 const {stats,completeness}=summary;
 const report={mode,startedAt,operationFinishedAt,operationMs,finishedAt:Date.now(),wallMs:performance.now()-t,result,stats,completeness,node:process.version,platform:process.platform};fs.writeFileSync(out,JSON.stringify(report,null,2));process.send?.({event:'result',report});
}catch(e){fs.writeFileSync(out,JSON.stringify({mode,startedAt,finishedAt:Date.now(),wallMs:performance.now()-t,error:e.stack},null,2));console.error(e);process.exitCode=1;}finally{process.disconnect?.();}
