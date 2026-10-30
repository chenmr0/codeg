const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {fork}=require('node:child_process');
process.env.CODEGRAPH_FIXED_PATH='1';process.env.CODEGRAPH_ALL_LANGUAGES='1';
if(process.env.FIXED_SYNC_CHILD){
  (async()=>{
    const root=process.argv[2],role=process.env.FIXED_SYNC_CHILD;
    if(role==='recovery-holder'){
      const {lease,paths}=require('../../dist/sync/fixed-path/protocol');const held=lease(paths(root).owner,true);
      if(!held)throw Error('cannot acquire recovery owner');process.send({type:'held'});await new Promise(resolve=>process.once('message',resolve));held.close();process.disconnect();return;
    }
    if(role==='publisher'){
      const {beginOperation}=require('../../dist/sync/fixed-path/protocol');const op=beginOperation(root);
      process.send({type:'publisher-ready',pid:process.pid,candidate:op.record.directory});
      await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'publisher.release'))){clearInterval(timer);resolve();}},10);});
      op.owner.close();if(process.connected)process.disconnect();return;
    }
    if(role==='holder'||role==='parent-and-child'){
      const {acquireFixedSyncAdmission}=require('../../dist/sync/fixed-path/sync-admission');
      const held=await acquireFixedSyncAdmission({project:root,dataDirectory:path.join(root,'.codegraph-wx')});
      if(role==='parent-and-child'){
        const child=fork(__filename,[root],{execArgv:['--liftoff-only'],env:{...process.env,FIXED_SYNC_CHILD:'publisher'},stdio:['ignore','ignore','ignore','ipc']});
        const ready=await new Promise(resolve=>child.once('message',resolve));process.send({type:'held',...ready,type:'held'});
      }else process.send({type:'held'});
      await new Promise(resolve=>process.once('message',resolve));held.close();process.disconnect();return;
    }
    const rebuild=require('../../dist/sync/fixed-path/rebuild');
    if(role==='leader'){
      const original=rebuild.runFixedPathRebuild;
      rebuild.runFixedPathRebuild=async(...args)=>{process.send({type:'held'});await new Promise(resolve=>process.once('message',resolve));return original(...args);};
    }
    const {CodeGraph}=require('../../dist'),graph=CodeGraph.openSync(root);
    process.send({type:'started'});
    try{const result=await graph.sync({onAdaptiveDecision:decision=>process.send({type:'decision',strategy:decision.strategy})});process.send({type:'result',result,hasLate:graph.searchNodes('added139').some(r=>r.node.name==='added139')});}
    finally{await graph.whenIdle();graph.close();process.disconnect();}
  })().catch(error=>{process.send?.({type:'failure',message:error.stack});process.exitCode=1;process.disconnect?.();});
}else{
const test=require('node:test'),{CodeGraph}=require('../../dist'),{records,paths}=require('../../dist/sync/fixed-path/protocol');
function start(root,role){
 const child=fork(__filename,[root],{execArgv:['--liftoff-only'],env:{...process.env,FIXED_SYNC_CHILD:role},stdio:['ignore','ignore','pipe','ipc']});
 const messages=[];let stderr='';child.on('message',m=>messages.push(m));child.stderr.on('data',b=>stderr+=b);
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 async function wait(type){const deadline=Date.now()+30000;while(Date.now()<deadline){const failed=messages.find(m=>m.type==='failure');if(failed)throw Error(failed.message);const found=messages.find(m=>m.type===type);if(found)return found;if(child.exitCode!==null)throw Error(`child exited ${child.exitCode}: ${stderr}`);await new Promise(r=>setTimeout(r,10));}throw Error(`timeout waiting ${type}: ${stderr}`);}
 return{child,messages,exited,wait};
}
async function fixture(){const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'cg-sync-admission-')));fs.writeFileSync(path.join(root,'main.py'),'def stable():\n    return 1\n');const graph=await CodeGraph.init(root,{index:true});return{root,graph};}
async function stop(client){if(client&&client.child.exitCode===null){client.child.kill('SIGKILL');await client.exited;}}

test('two real SDK processes serialize sync before planning and follower sees the published index', {timeout:45000},async()=>{
 const {root,graph}=await fixture();let leader,follower;
 try{
  for(let i=0;i<140;i++)fs.writeFileSync(path.join(root,`added${i}.py`),`def added${i}():\n    return ${i}\n`);
  leader=start(root,'leader');await leader.wait('held');follower=start(root,'follower');await follower.wait('started');
  await new Promise(r=>setTimeout(r,150));assert(!follower.messages.some(m=>['decision','result'].includes(m.type)),'follower must not evaluate a stale plan');
  assert(graph.searchNodes('stable').length);assert.equal(graph.searchNodes('added139').length,0);
  leader.child.send('continue');const a=await leader.wait('result'),b=await follower.wait('result');
  assert.equal(a.result.adaptive.strategy,'rebuild');assert(follower.messages.some(m=>m.type==='decision'&&m.strategy==='incremental'));assert.notEqual(b.result.complete,false);assert(a.hasLate&&b.hasLate);
  assert.equal((await leader.exited).code,0);assert.equal((await follower.exited).code,0);
  assert.equal(records(paths(root)).filter(r=>r.phase==='cleaned').length,1);
 }finally{await stop(leader);await stop(follower);graph.abortActiveWork();await graph.whenIdle();graph.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('queued sync timeout and abort preserve holder and queries; process exit releases admission', {timeout:20000},async()=>{
 const {root,graph}=await fixture();let holder;
 try{
  holder=start(root,'holder');await holder.wait('held');
  await assert.rejects(graph.sync({syncCoordinationTimeoutMs:100}),/timed out/);assert.equal(holder.child.exitCode,null);assert(graph.searchNodes('stable').length);
  const abort=new AbortController(),pending=graph.sync({signal:abort.signal,syncCoordinationTimeoutMs:10000});setTimeout(()=>abort.abort(),60);
  await assert.rejects(pending,/cancelled/);assert.equal(holder.child.exitCode,null);
  const resumed=graph.sync({adaptive:false,syncCoordinationTimeoutMs:10000});fs.writeFileSync(path.join(root,'queued.py'),'def queued_change():\n    return 7\n');holder.child.kill('SIGKILL');await holder.exited;
  const result=await resumed;assert.notEqual(result.complete,false);assert(graph.searchNodes('stable').length);assert(graph.searchNodes('queued_change').some(r=>r.node.name==='queued_change'));
 }finally{await stop(holder);graph.abortActiveWork();await graph.whenIdle();graph.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('parent-only crash does not let a follower bypass its still-live publisher child', {timeout:20000},async()=>{
 const {root,graph}=await fixture();let parent,pid;
 try{
  parent=start(root,'parent-and-child');const ready=await parent.wait('held');pid=ready.pid;
  parent.child.kill('SIGKILL');await parent.exited;
  await assert.rejects(graph.sync({adaptive:false,syncCoordinationTimeoutMs:100}),/timed out/);
  process.kill(pid,0);assert(graph.searchNodes('stable').length);assert(fs.existsSync(ready.candidate));
  const pending=graph.sync({adaptive:false,syncCoordinationTimeoutMs:10000});
  fs.writeFileSync(path.join(root,'publisher.release'),'release');await pending;
  assert(!fs.existsSync(ready.candidate),'recovery removes aborted candidate only after child ownership exits');
 }finally{await stop(parent);if(pid)try{process.kill(pid,'SIGKILL');}catch{}graph.abortActiveWork();await graph.whenIdle();graph.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('admission rejects expired wait even when lock is released before the next poll',async()=>{
 const {root,graph}=await fixture();const {acquireFixedSyncAdmission}=require('../../dist/sync/fixed-path/sync-admission');
 const project={project:root,dataDirectory:path.join(root,'.codegraph-wx')};let held;
 try{held=await acquireFixedSyncAdmission(project);const pending=acquireFixedSyncAdmission(project,{timeoutMs:1});
   setTimeout(()=>held.close(),10);await assert.rejects(pending,/timed out/);
 }finally{held?.close();graph.close();fs.rmSync(root,{recursive:true,force:true});}
});


test('publisher ownership taken after planning is retried only before candidate creation and replanned', {timeout:20000},async()=>{
 const {root,graph}=await fixture(),rebuild=require('../../dist/sync/fixed-path/rebuild'),original=rebuild.runFixedPathRebuild;
 let competitor,injected=false,decisions=0;
 try{
  for(let i=0;i<140;i++)fs.writeFileSync(path.join(root,`race${i}.py`),`def race${i}():\n    return ${i}\n`);
  rebuild.runFixedPathRebuild=async(...args)=>{if(!injected){injected=true;competitor=start(root,'recovery-holder');await competitor.wait('held');setTimeout(()=>competitor.child.send('release'),600);}return original(...args);};
  const result=await graph.sync({onAdaptiveDecision:()=>decisions++});assert.equal(result.adaptive.strategy,'rebuild');assert(decisions>=2);
  assert(graph.searchNodes('race139').length);assert.equal(records(paths(root)).length,1);assert.equal((await competitor.exited).code,0);
 }finally{rebuild.runFixedPathRebuild=original;await stop(competitor);graph.abortActiveWork();await graph.whenIdle();graph.close();fs.rmSync(root,{recursive:true,force:true});}
});


test('progress callback errors carrying the contention string are never replayed as pre-construction failures', {timeout:15000},async()=>{
 const {root,graph}=await fixture();let decisions=0;
 try{
  for(let i=0;i<140;i++)fs.writeFileSync(path.join(root,`error${i}.py`),`def error${i}():\n    return ${i}\n`);
  await assert.rejects(graph.sync({onAdaptiveDecision:()=>decisions++,onProgress:()=>{throw Object.assign(Error('intentional progress failure'),{code:'FIXED_PUBLISHER_BUSY'});}}),/intentional progress failure/);
  assert.equal(decisions,1);assert(graph.searchNodes('stable').length);assert.equal(graph.searchNodes('error139').length,0);
 }finally{graph.abortActiveWork();await graph.whenIdle();graph.close();fs.rmSync(root,{recursive:true,force:true});}
});

}
