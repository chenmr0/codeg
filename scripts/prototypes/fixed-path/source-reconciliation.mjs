/** Follow-up experiment ONLY. Does not change delivered protocol or production.
 * A content observation is not an atomic snapshot of an uncooperative filesystem.
 * Periodic revalidation provides conditional convergence after source quiescence.
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { initialize, gate, state, lease, recover, Participant, beginOperation, publish, now } from './protocol.mjs';
import { graphAt, buildGraph, validateGraph, sourceSnapshot, cheapSourceFence, expectedIndex } from './graph-adapter.mjs';
const require=createRequire(import.meta.url);
const {createAdaptivePlan,adaptiveRuntimeKey}=require('../../../dist/sync/adaptive-plan.js');
const {isSourceOwned}=require('../../../dist/sync/source-ownership.js');

export function initializeSource(root){
  const p=initialize(root);
  gate(p,g=>{g.exec('CREATE TABLE IF NOT EXISTS source_observation(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL)');g.prepare('INSERT OR IGNORE INTO source_observation VALUES(1,?)').run(JSON.stringify({version:1,status:'needs-check',checks:0,builds:0,reason:'startup-not-yet-observed'}));});
  return p;
}
function read(p){return gate(p,g=>JSON.parse(g.prepare('SELECT record FROM source_observation WHERE id=1').get().record));}
function update(p,patch){return gate(p,g=>{const previous=JSON.parse(g.prepare('SELECT record FROM source_observation WHERE id=1').get().record);if(previous.version!==1)throw new Error('Unknown source observation protocol');const next={...previous,...patch,updatedAt:new Date().toISOString()};g.prepare('UPDATE source_observation SET record=? WHERE id=1').run(JSON.stringify(next));return next;});}
export function sourceState(root){return read(initializeSource(root));}

/** Always hashes supported source content, even if size/mtime and dirty flag match. */
export async function checkSource(root,options={}){
  const p=initializeSource(root), started=now(), startedAtMs=Date.now(), stages={};
  if(!recover(root))return{status:'busy',reason:'publisher-or-recovery-active'};
  const owner=lease(p.owner,true);if(!owner)return{status:'busy',reason:'publisher-active'};
  let writers,reader;
  try{
    writers=lease(p.writers,true);if(!writers)return{status:'busy',reason:'writer-active'};
    if(state(p).mode!=='idle')return{status:'busy',reason:'admission-not-idle'};
    const expectedRevision=state(p).revision;
    // Capture an uncontended baseline, then let ordinary writes proceed during
    // expensive source hashing. Durable pre-write revision detects any overlap.
    if(!options.holdWritersDuringCheck){writers.close();writers=null;}
    const previous=read(p);update(p,{status:'checking',matches:null,reason:'full-content-observation-in-progress'});
    reader=new Participant(root,file=>graphAt(root,file,{readOnly:true}));
    const check=await reader.request(async graph=>{
      if(!isSourceOwned(graph.db.getDb()))throw new Error('Unowned/custom database: automatic source compensation refused');
      if(graph.getIndexCompleteness().status!=='complete')throw new Error('Incomplete active index: requires separate compatibility/recovery handling');
      options.hook?.('hash-start');
      options.beforeHash?.();
      // Exhaustive enumeration rejects unreadable directories/files instead of
      // treating skipped content as deleted or a successful empty observation.
      let stage=now();
      const beforeSource=sourceSnapshot(root);stages.beforeSnapshotMs=now()-stage;
      stage=now();const tracked=graph.queries.getAllFiles();stages.trackedFilesMs=now()-stage;stage=now();
      const plan=await createAdaptivePlan(root,tracked,{runtimeKey:adaptiveRuntimeKey(root,'node-sqlite'),fullHash:true});stages.adaptivePlanMs=now()-stage;stage=now();
      const storedConfig=graph.queries.getMetadata('adaptive:index-config-v1');
      const configChanged=storedConfig!==plan.snapshot.configFingerprint;
      const upgrade=graph.isIndexStale() || graph.needsLanguageScopeRebuild();
      stages.compatibilityMs=now()-stage;stage=now();const afterSource=sourceSnapshot(root);stages.afterSnapshotMs=now()-stage;
      const sourceChangedDuringCheck=beforeSource.digest!==afterSource.digest;
      const digest=crypto.createHash('sha256').update(JSON.stringify([plan.snapshot.configFingerprint,plan.snapshot.files.map(f=>[f.path,f.contentHash])])).digest('hex');
      return{matches:plan.changedFiles===0&&!configChanged&&!upgrade&&!sourceChangedDuringCheck,sourceChangedDuringCheck,fullSourceDigest:afterSource.digest,changedFiles:plan.changedFiles,added:plan.added,modified:plan.modified,removed:plan.removed,configChanged,upgrade,observedDigest:digest};
    });
    writers??=lease(p.writers,true);
    if(!writers || state(p).revision!==expectedRevision){
      const invalidated={status:'needs-check',matches:null,reason:'database-write-overlapped-observation',startedAtMs,finishedAtMs:Date.now(),checkMs:now()-started,stages};
      update(p,invalidated);return invalidated;
    }
    // This records a PAST observation, not "filesystem cannot change after here".
    const result={status:check.matches?'verified-observation':'dirty',reason:check.matches?'indexed-content-matched-full-observation':'observed-source-or-config-diff',checks:previous.checks+1,lastObservedAt:new Date().toISOString(),databaseRevision:state(p).revision,startedAtMs,finishedAtMs:Date.now(),checkMs:now()-started,stages,...check};
    update(p,result);options.hook?.('observed');return result;
  }catch(error){const result={status:'blocked',matches:null,reason:'source-check-failed',error:error.message,startedAtMs,finishedAtMs:Date.now(),checkMs:now()-started,stages};update(p,result);return result;}
  finally{try{reader?.close();}finally{writers?.close();owner.close();}}
}

/** Queue is durable BEFORE publishing; COMMITTED does not clear it. */
export async function publishObserved(root,options={}){
  const p=initializeSource(root);let op, consumed=false, publicationResult;const startedAtMs=Date.now(), preparation={};
  try{
    op=beginOperation(root);
    const previous=read(p);update(p,{status:'needs-check',matches:null,reason:'candidate-publication-requires-postcheck',operation:op.record.id,builds:previous.builds+1});
    let stage=now();const before=sourceSnapshot(root);preparation.sourceSnapshotMs=now()-stage;stage=now();
    const snapshot=await expectedIndex(root);preparation.expectedIndexMs=now()-stage;const started=now();
    update(p,{expectedSourceDigest:before.digest});
    options.hook?.('before-build');
    await buildGraph(root,op.record.candidate);
    options.hook?.('after-build');
    consumed=true;
    const result=await publish(op,{
      buildMs:now()-started,validate:file=>validateGraph(root,file,snapshot),
      validateSource(){
        // A prior dirty observation cannot authorize a different active database.
        // publish holds writers-exclusive here and has checked the baseline revision.
        const eligibilityStarted=now();const active=graphAt(root,p.active,{readOnly:true});
        try{
          if(!isSourceOwned(active.db.getDb()))throw new Error('Active source ownership changed; compensation refused');
          if(active.getIndexCompleteness().status!=='complete')throw new Error('Active index became incomplete; compensation refused');
        }finally{active.close();preparation.activeEligibilityMs=now()-eligibilityStarted;}
        const validateSourceStarted=now();const current=sourceSnapshot(root);preparation.validateSourceMs=now()-validateSourceStarted;
        if(current.digest!==before.digest)throw new Error('Source changed during construction; compensation remains queued');
      },
      finalSourceFence(){const t=now();cheapSourceFence(root,before);preparation.finalSourceFenceMs=now()-t;},hook:options.hook,
    });
    result.startedAtMs=startedAtMs;result.finishedAtMs=Date.now();result.preparation=preparation;
    publicationResult=result;
    options.afterPublish?.(result);
    // Even a successful publish leaves needs-check for a separately acquired pass.
    update(p,{status:'needs-check',matches:null,reason:'publication-finished-requires-independent-observation',lastPublish:result.status,lastPublishError:result.error??null});
    return result;
  }catch(error){
    // publish consumes/releases its owner even if recovery fails. NEVER replay it.
    if(op&&!consumed){consumed=true;const result=await publish(op,{validate(){throw error;}});update(p,{status:'needs-check',matches:null,reason:'build-failed-check-required',lastPublishError:error.message});return result;}
    if(consumed)return{status:'pending',reason:'publication-or-reporting-error-no-replay',error:error.message,publicationResult,operation:op.record.id,nextCheckRequired:true};
    return{status:'busy',reason:error.message};
  }
}

/** Bounds one work turn; leaves durable pending state instead of claiming convergence. */
export async function reconcileSource(root,options={}){
  const outcomes=[];let builds=0;
  while(true){
    const observed=await checkSource(root,options);outcomes.push({type:'check',...observed});
    if(observed.status==='verified-observation')return{status:'verified-observation',outcomes,builds,guarantee:'past-content-observation-only'};
    if(observed.status!=='dirty')return{status:'pending',outcomes,builds,nextCheckRequired:true};
    if(builds>=(options.maxBuilds??2))return{status:'pending',outcomes,builds,nextCheckRequired:true};
    const built=await publishObserved(root,options);builds++;outcomes.push({type:'publish',...built});
    if(built.status==='busy')return{status:'pending',outcomes,builds,nextCheckRequired:true};
  }
}

/** Poll even after a matching observation: lost watcher events cannot suppress checks. */
export async function watchSource(root,{pollMs=1000,signal,onResult,...options}={}){
  while(!signal?.aborted){
    const result=await reconcileSource(root,options);onResult?.(result);
    if(signal?.aborted)break;
    try{await delay(pollMs,undefined,{signal});}catch(error){if(!signal?.aborted)throw error;}
  }
}
