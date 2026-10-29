import fs from 'node:fs';import path from 'node:path';import {performance} from 'node:perf_hooks';import {createRequire} from 'node:module';
import {buildGraph,graphAt,prepareGrammars} from '../graph-adapter.mjs';
import {initialize,seal,Participant} from '../protocol.mjs';
import {reconcileSource,checkSource} from '../source-reconciliation.mjs';
const require=createRequire(import.meta.url),adaptive=require('../../../../dist/sync/adaptive-plan.js');
const [mode,root,out,destination]=process.argv.slice(2); const t=performance.now(),startedAt=Date.now(),p=initialize(root);let result;
try{
 if(mode==='init'){result=await buildGraph(root,destination??p.active);seal(destination??p.active,{standalone:true});}
 else if(mode==='sync'){await prepareGrammars();const participant=new Participant(root,file=>graphAt(root,file));try{result=await participant.write(g=>g.sync({adaptive:false}));}finally{participant.close();}}
 else if(mode==='check')result=await checkSource(root);
 else if(mode==='rebuild')result=await reconcileSource(root,{maxBuilds:1,hook:phase=>process.send?.({event:'phase',phase,at:Date.now()})});
 else if(mode==='plan'){const g=graphAt(root,p.active,{readOnly:true});try{const plan=await adaptive.createAdaptivePlan(root,g.queries.getAllFiles(),{runtimeKey:adaptive.adaptiveRuntimeKey(root,'node-sqlite'),fullHash:true});const history=adaptive.readAdaptiveHistory(root);const decision=adaptive.chooseAdaptiveStrategy(plan,history,{configFingerprint:g.queries.getMetadata('adaptive:index-config-v1')});result={...plan,snapshot:{...plan.snapshot,files:undefined},decision,history};}finally{g.close();}}
 const operationFinishedAt=Date.now(),operationMs=performance.now()-t;const statsGraph=graphAt(root,destination??p.active,{readOnly:true});let stats,completeness;try{stats=statsGraph.getStats();completeness=statsGraph.getIndexCompleteness();}finally{statsGraph.close();}
 const report={mode,startedAt,operationFinishedAt,operationMs,finishedAt:Date.now(),wallMs:performance.now()-t,result,stats,completeness,node:process.version,platform:process.platform};fs.writeFileSync(out,JSON.stringify(report,null,2));process.send?.({event:'result',report});
}catch(e){fs.writeFileSync(out,JSON.stringify({mode,startedAt,finishedAt:Date.now(),wallMs:performance.now()-t,error:e.stack},null,2));console.error(e);process.exitCode=1;}finally{process.disconnect?.();}
