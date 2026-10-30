/** Real Git linked-worktree coverage, not a synthetic .git-file fixture.
 * npm run build && CODEGRAPH_ALL_LANGUAGES=1 node --liftoff-only --test scripts/prototypes/fixed-path/git-worktree.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { initializeSource, checkSource, publishObserved } from './source-reconciliation.mjs';
import { buildGraph, graphAt, prepareGrammars } from './graph-adapter.mjs';
import { seal } from './protocol.mjs';
const require = createRequire(import.meta.url);
const { CodeGraph } = require('../../../dist/index.js');
const { isSourceOwned } = require('../../../dist/sync/source-ownership.js');
const { repositoryExcludePath } = require('../../../dist/git-metadata.js');
function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim(); }
function fixture() {
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'cg-worktree-real-')),main=path.join(base,'main'),root=path.join(base,'linked');
 fs.mkdirSync(main);git(main,'init');git(main,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','initial');git(main,'worktree','add','-b','linked-test',root);
 fs.writeFileSync(path.join(root,'main.py'),'def stable(value=1):\n    return value\n');fs.writeFileSync(path.join(root,'hidden.py'),'def hidden_api():\n    return 42\n');fs.writeFileSync(repositoryExcludePath(root),'hidden.py\n');
 assert.ok(fs.statSync(path.join(root,'.git')).isFile());return {base,root};
}
function found(graph,name) { return graph.searchNodes(name).filter(x=>x.node.name===name); }
function owned(graph) { assert.equal(isSourceOwned(graph.db.getDb()),true,'successful indexing restores source ownership'); }

test('real linked worktree: production init, incremental sync, and automatic adaptive rebuild', {timeout:120000}, async()=>{
 const {base,root}=fixture();let graph;const originalArgv=process.execArgv;const originalOptions=process.env.NODE_OPTIONS;
 process.execArgv=['--liftoff-only'];delete process.env.NODE_OPTIONS;
 try {
  await prepareGrammars();graph=await CodeGraph.init(root,{index:true});owned(graph);assert.equal(found(graph,'stable').length,1);assert.equal(found(graph,'hidden_api').length,0);
  fs.writeFileSync(path.join(root,'main.py'),'def stable(value=2):\n    return value\n');
  const sync=await graph.sync({adaptive:false});assert.equal(sync.complete,true);assert.equal(found(graph,'stable')[0].node.signature,'(value=2)');owned(graph);
  for(let i=0;i<140;i++) fs.writeFileSync(path.join(root,`added_${i}.py`),`def added_${i}():\n    return ${i}\n`);
  const decisions=[];const rebuilt=await graph.sync({onAdaptiveDecision:d=>decisions.push(d)});assert.equal(rebuilt.complete,true);assert.equal(rebuilt.adaptive?.strategy,'rebuild',JSON.stringify(decisions));assert.equal(found(graph,'added_139').length,1);assert.equal(found(graph,'hidden_api').length,0);owned(graph);
 } finally {graph?.close();process.execArgv=originalArgv;if(originalOptions===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=originalOptions;fs.rmSync(base,{recursive:true,force:true});}
});

test('real linked worktree: WAL prototype full build, exclude-aware rebuild and source follow-up checks', {timeout:120000}, async()=>{
 const {base,root}=fixture();let graph;
 try {
  const p=initializeSource(root);await buildGraph(root,p.active);seal(p.active,{standalone:true});
  graph=graphAt(root,p.active);owned(graph);assert.equal(found(graph,'hidden_api').length,0);graph.close();graph=null;
  assert.equal((await checkSource(root)).status,'verified-observation');
  fs.writeFileSync(repositoryExcludePath(root),'');
  const dirty=await checkSource(root);assert.equal(dirty.status,'dirty');assert.equal(dirty.configChanged,true);
  const published=await publishObserved(root);assert.equal(published.status,'published');
  assert.equal((await checkSource(root)).status,'verified-observation');
  graph=graphAt(root,p.active);owned(graph);assert.equal(found(graph,'hidden_api').length,1);graph.close();graph=null;
  fs.writeFileSync(repositoryExcludePath(root),'hidden.py\n');
  assert.equal((await checkSource(root)).status,'dirty');
  assert.equal((await publishObserved(root)).status,'published');
  assert.equal((await checkSource(root)).status,'verified-observation');
  graph=graphAt(root,p.active);assert.equal(found(graph,'hidden_api').length,0);owned(graph);
 } finally {graph?.close();fs.rmSync(base,{recursive:true,force:true});}
});

test('real linked worktree: watcher reports malformed common metadata without process exit and observes repair', {timeout:30000},()=>{
 const {base,root}=fixture();
 try {
  // A separate process with no uncaughtException handler proves fs.watch
  // callbacks do not terminate a long-lived MCP/SDK host on transient damage.
  const script=`
   const fs=require('node:fs'),path=require('node:path');
   const {FileWatcher}=require(${JSON.stringify(require.resolve('../../../dist/sync/watcher.js'))});
   const {repositoryGitDirectories,repositoryExcludePath}=require(${JSON.stringify(require.resolve('../../../dist/git-metadata.js'))});
   const root=process.argv[1],dirs=repositoryGitDirectories(root),file=path.join(dirs.gitDir,'commondir'),original=fs.readFileSync(file);
   let errors=[],syncs=0;const watcher=new FileWatcher(root,async()=>{syncs++;return {filesChanged:0,durationMs:0};},{debounceMs:30,onSyncError:error=>errors.push(error.message)});
   async function until(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw new Error('watch repair timed out');await new Promise(r=>setTimeout(r,20));}}
   (async()=>{try{if(!watcher.start())throw new Error('watch did not start');fs.writeFileSync(file,'');await until(()=>errors.length>0);if(!errors.some(e=>e.includes('Invalid Git commondir')))throw new Error('missing diagnostic');const revision=watcher.getChangeRevision();fs.writeFileSync(file,original);await until(()=>watcher.getChangeRevision()>revision);await until(()=>syncs>0);const before=watcher.getChangeRevision();fs.writeFileSync(repositoryExcludePath(root),'main.py\\n');await until(()=>watcher.getChangeRevision()>before);console.log('WATCH_REPAIR_PASSED');}finally{watcher.stop();fs.writeFileSync(file,original);}})().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  const output=execFileSync(process.execPath,['--liftoff-only','-e',script,root],{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});
  assert.match(output,/WATCH_REPAIR_PASSED/);
 } finally {fs.rmSync(base,{recursive:true,force:true});}
});
