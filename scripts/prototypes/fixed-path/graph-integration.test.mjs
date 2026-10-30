import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Participant, initialize, seal, records, paths, gate } from './protocol.mjs';
import { buildGraph, graphAt, prepareGrammars } from './graph-adapter.mjs';
const require=createRequire(import.meta.url);
const {createAdaptivePlan,chooseAdaptiveStrategy,adaptiveRuntimeKey}=require('../../../dist/sync/adaptive-plan.js');
const here=path.dirname(fileURLToPath(import.meta.url));
const evidence=[];
process.env.CODEGRAPH_ALL_LANGUAGES='1';
function forkPublish(root) {
  const child=fork(path.join(here,'graph-publish.mjs'),[root],{execArgv:['--liftoff-only'],stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,CODEGRAPH_ALL_LANGUAGES:'1'}});
  let stdout='',stderr='',result;child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  return new Promise((resolve,reject)=>{child.on('message',m=>{if(m.type==='result')result=m.result;});child.on('error',reject);child.on('close',code=>{if(code===0&&result?.status==='published')resolve({...result,stdout,stderr});else reject(new Error(JSON.stringify({code,result,stderr,stdout})));});});
}
async function automaticSync(root,participant) {
  const tracked=await participant.request(g=>g.queries.getAllFiles());
  const plan=await createAdaptivePlan(root,tracked,{runtimeKey:adaptiveRuntimeKey(root,'node-sqlite')});
  const decision=chooseAdaptiveStrategy(plan,{version:1,samples:[]});
  if(decision.strategy==='rebuild') return {decision,publish:await forkPublish(root)};
  return {decision,sync:await participant.write(g=>g.sync({adaptive:false}))};
}
function standard(root, value=1) {fs.writeFileSync(path.join(root,'main.py'),`# public snapshot
# stable line identity
def stable(value=${value}):\n    return value\n\ndef removed():\n    return 0\n`);}
function sourceFiles(root) { return fs.readdirSync(root).filter(x=>x.endsWith('.py')); }
function participant(root,write=false){return new Participant(root,file=>graphAt(root,file,{readOnly:!write}));}

test('real CodeGraph: repeated portable public import -> incremental -> automatic rebuild -> public import -> query/sync',{timeout:120000},async()=>{
  await prepareGrammars();
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'fixed-real-')),producer=path.join(base,'producer'),consumer=path.join(base,'other-machine-project');
  fs.mkdirSync(producer);fs.mkdirSync(consumer);standard(producer);standard(consumer);
  const publicFile=path.join(base,'public.db'); await buildGraph(producer,publicFile);seal(publicFile);
  assert(!fs.existsSync(publicFile+'-wal'));
  standard(producer,999); // Consumer source lookup must NOT read producer's old absolute root.
  const p=initialize(consumer);
  fs.writeFileSync(path.join(p.data,'CURRENT'),'{malformed legacy manifest intentionally ignored by prototype}');
  fs.mkdirSync(path.join(p.data,'generations')); fs.writeFileSync(path.join(p.data,'generations','sentinel'),'not the active database');
  let reader,writer;
  try {
    for(let round=0;round<3;round++) {
      for(const name of sourceFiles(consumer))fs.unlinkSync(path.join(consumer,name)); standard(consumer);
      // Offline means every participant is closed, checkpointed output only.
      fs.copyFileSync(publicFile,p.active);
      gate(p,g=>g.prepare('INSERT OR REPLACE INTO costs VALUES (?,?)').run('old-other-machine','incorrect sample'));
      reader=participant(consumer);writer=participant(consumer,true);
      const found=await reader.request(g=>g.searchNodes('stable'));
      assert.equal(found[0].node.filePath,'main.py');const id=found[0].node.id;
      assert.equal(await reader.request(g=>g.getNode(id).signature),'(value=1)');
      assert.match(await reader.request(g=>g.getCode(id)),/def stable\(value=1\)/);
      assert.deepEqual(await reader.request(g=>g.getDetectedFrameworks()),[]);
      assert.equal(gate(p,g=>g.prepare('SELECT count(*) AS n FROM costs').get().n),0);
      const noChange=await automaticSync(consumer,writer);assert.equal(noChange.decision.strategy,'incremental');assert.equal(noChange.decision.reason,'no-content-changes');
      fs.writeFileSync(path.join(consumer,'main.py'),`from flask import Flask\napp=Flask(__name__)\ndef stable(value=${round+10}, extra=None):\n    return value\n@app.route('/')\ndef added():\n    return 'ok'\n`);
      const inc=await automaticSync(consumer,writer); assert.equal(inc.decision.strategy,'incremental');
      const changed=await reader.request(g=>g.getNode(id));assert.equal(changed.signature,`(value=${round+10}, extra=None)`);
      assert.equal((await reader.request(g=>g.searchNodes('removed'))).length,0);
      assert((await reader.request(g=>g.getDetectedFrameworks())).includes('flask'));
      for(let n=0;n<140;n++)fs.writeFileSync(path.join(consumer,`new_${n}.py`),`def added_${n}():\n    return ${round+n}\n`);
      const rebuilt=await automaticSync(consumer,writer);assert.equal(rebuilt.decision.strategy,'rebuild');assert.equal(rebuilt.decision.reason,'structural-large-change');
      assert.equal(fs.realpathSync(await reader.request(g=>g.getDatabaseFilePath())),fs.realpathSync(p.active));
      assert.equal((await reader.request(g=>g.searchNodes('added_139')))[0].node.name,'added_139');
      assert(reader.reopens>=2); assert(writer.reopens>=1);
      assert(records(p).every(r=>r.phase==='cleaned'));
      assert.equal(fs.readFileSync(path.join(p.data,'CURRENT'),'utf8'),'{malformed legacy manifest intentionally ignored by prototype}');
      assert.equal(await reader.request(g=>g.getNode(id).signature),`(value=${round+10}, extra=None)`);
      // A second real replacement removes framework evidence and changes the same ID.
      for(const name of sourceFiles(consumer))fs.unlinkSync(path.join(consumer,name)); standard(consumer,2);
      const removal=await automaticSync(consumer,writer); assert.equal(removal.decision.strategy,'rebuild');
      assert.deepEqual(await reader.request(g=>g.getDetectedFrameworks()),[]);
      assert.equal(await reader.request(g=>g.getNode(id).signature),'(value=2)');
      assert.equal((await reader.request(g=>g.searchNodes('added_139'))).length,0);
      evidence.push({round,decision:rebuilt.decision,publish:rebuilt.publish,removalPublish:removal.publish});
      reader.close();writer.close();reader=writer=null;
      for(const name of sourceFiles(consumer))fs.unlinkSync(path.join(consumer,name));standard(consumer);
      fs.copyFileSync(publicFile,p.active);
      reader=participant(consumer);writer=participant(consumer,true);
      assert.deepEqual(await reader.request(g=>g.getDetectedFrameworks()),[]);
      assert.equal((await reader.request(g=>g.searchNodes('added_139'))).length,0);
      assert.equal(await reader.request(g=>g.getNode(id).signature),'(value=1)');
      assert.match(await reader.request(g=>g.getCode(id)),/def stable\(value=1\)/);
      const final=await automaticSync(consumer,writer);assert.equal(final.decision.strategy,'incremental');assert.equal(final.decision.reason,'no-content-changes');
      writer.close();reader.close();reader=writer=null;
      for(const suffix of ['-wal','-shm','-journal'])assert.equal(fs.existsSync(p.active+suffix),false,'clean shutdown must not leave logs for offline overwrite');
    }
    fs.writeFileSync(p.active,'not SQLite');reader=participant(consumer);await assert.rejects(reader.request(g=>g.getStats()),/database|file|SQLite/i);
  } finally {reader?.close();writer?.close();}
  const dir=process.env.FIXED_PATH_EVIDENCE_DIR??path.resolve('artifacts/fixed-path-prototype');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,`graph-integration-${process.platform}.json`),JSON.stringify({platform:process.platform,node:process.version,fixture:base,rounds:evidence,productionEntryPoints:false},null,2));
});
