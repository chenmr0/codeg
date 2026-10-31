/** Zero-configuration fixed-layout defaults; real disk and real CLI processes.
 * Run: node --liftoff-only scripts/tests/fixed-layout-default.test.cjs
 * Supports CODEGRAPH_TEST_PACKAGE and CODEGRAPH_LAYOUT_DEFAULT_EVIDENCE.
 * All fixtures are retained. Tests never remove runtime files to make assertions pass.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {DatabaseSync} = require('node:sqlite');
const {snapshot, contract, reclaimed} = require('./helpers/layout-disk-evidence.cjs');
const packageRoot = path.resolve(process.env.CODEGRAPH_TEST_PACKAGE || path.join(__dirname, '../..'));
const {CodeGraph, DatabaseConnection} = require(path.join(packageRoot, 'dist'));
const bin = path.join(packageRoot, 'dist/bin/codegraph.js');
const evidence = path.resolve(process.env.CODEGRAPH_LAYOUT_DEFAULT_EVIDENCE || path.join('artifacts', 'layout-default', `${process.platform}-${Date.now()}`));
fs.mkdirSync(evidence, {recursive:true});
// This unset is deliberate: a surrounding developer shell cannot accidentally
// turn a claimed zero-configuration test into the old explicit opt-in flow.
delete process.env.CODEGRAPH_FIXED_PATH;
delete process.env.CODEGRAPH_ALL_LANGUAGES;
console.log('LAYOUT_DEFAULT_EVIDENCE=' + evidence);
fs.writeFileSync(path.join(evidence, 'environment.json'), JSON.stringify({platform:process.platform,node:process.version,packageRoot,fixedPathEnvironment:'unset'},null,2));
let sequence=0;
function fixture(name) {
 const project=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'layout-default-')));
 const dir=path.join(evidence,`${++sequence}-${name}`);fs.mkdirSync(dir);
 fs.writeFileSync(path.join(project,'main.py'),'def default_layout_symbol():\n    return 42\n');
 return {project,data:path.join(project,'.codegraph-wx'),dir,step:0};
}
function capture(f,phase,strict=true) {
 const value=snapshot(f.data);
 fs.writeFileSync(path.join(f.dir,`${++f.step}-${phase}.json`),JSON.stringify(value,null,2));
 if(strict)contract(value);
 return value;
}
async function close(graph) {
 graph.close();let timer;
 try {await Promise.race([graph.whenIdle(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('close maintenance timeout after 10000ms')),10000);})]);}
 finally {clearTimeout(timer);}
}
function cli(f,args,expected=0) {
 const env={...process.env};delete env.CODEGRAPH_FIXED_PATH;
 const result=spawnSync(process.execPath,['--liftoff-only',bin,...args],{cwd:f.project,env,encoding:'utf8',timeout:30000});
 fs.writeFileSync(path.join(f.dir,`cli-${f.step}-${args[0]}.json`),JSON.stringify(result,null,2));
 assert.equal(result.status,expected,result.stdout+result.stderr);return result;
}
function custom(file,value) {const db=new DatabaseSync(file);try{db.exec('CREATE TABLE default_custom(value TEXT)');db.prepare('INSERT INTO default_custom VALUES (?)').run(value);}finally{db.close();}}
function readCustom(file) {const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT value FROM default_custom').get().value;}finally{db.close();}}

for(const method of ['init','initSync'])test(`unset environment: SDK ${method} creates strict fixed layout and reopens`,{timeout:30000},async()=>{
 assert.equal(process.env.CODEGRAPH_FIXED_PATH,undefined);
 const f=fixture(method);let graph=method==='init'?await CodeGraph.init(f.project,{index:true}):CodeGraph.initSync(f.project);
 try {
  capture(f,'running');assert.equal(graph.getDatabaseFilePath(),path.join(f.data,'codegraph.db'));
  if(method==='initSync')await graph.indexAll();
  assert(graph.searchNodes('default_layout_symbol').length);await reclaimed(f.data);capture(f,'completed');
 }finally{await close(graph);}
 capture(f,'closed');graph=CodeGraph.openSync(f.project);
 try{assert(graph.searchNodes('default_layout_symbol').length);capture(f,'reopened');}finally{await close(graph);}
 await reclaimed(f.data);capture(f,'reclosed');
});

test('unset environment: real CLI init and sync create only fixed-layout root entries',{timeout:45000},async()=>{
 const f=fixture('cli');cli(f,['init',f.project]);await reclaimed(f.data);capture(f,'cli-init-exited');
 fs.writeFileSync(path.join(f.project,'extra.py'),'def cli_default_added():\n    return 7\n');
 cli(f,['sync',f.project,'--quiet']);await reclaimed(f.data);capture(f,'cli-sync-exited');
 const graph=CodeGraph.openSync(f.project);try{assert(graph.searchNodes('default_layout_symbol').length);assert(graph.searchNodes('cli_default_added').length);capture(f,'sdk-reopened');}finally{await close(graph);}
 capture(f,'reclosed');
});

test('explicit compatibility flags: 1 creates fixed, 0 creates legacy, fixed marker wins over 0',{timeout:30000},async()=>{
 const fixed=fixture('explicit-one'),legacy=fixture('explicit-zero');let graph;
 try {
  process.env.CODEGRAPH_FIXED_PATH='1';graph=await CodeGraph.init(fixed.project,{index:true});await close(graph);capture(fixed,'fixed-created');
  process.env.CODEGRAPH_FIXED_PATH='0';graph=CodeGraph.openSync(fixed.project);try{assert.equal(graph.getDatabaseFilePath(),path.join(fixed.data,'codegraph.db'));assert(graph.searchNodes('default_layout_symbol').length);capture(fixed,'fixed-opened-with-zero');}finally{await close(graph);}
  graph=await CodeGraph.init(legacy.project,{index:true});assert.match(graph.getDatabaseFilePath(),/[\\/]generations[\\/]/);await close(graph);capture(legacy,'explicit-legacy',false);assert(fs.existsSync(path.join(legacy.data,'CURRENT')));assert(!fs.existsSync(path.join(legacy.data,'.runtime','layout.json')));
 }finally{delete process.env.CODEGRAPH_FIXED_PATH;}
});

for(const kind of ['generational','root'])test(`unset environment: existing ${kind} data is never silently migrated or overwritten`,{timeout:45000},async()=>{
 const f=fixture(`existing-${kind}`);let graph,file;
 if(kind==='generational') {
  process.env.CODEGRAPH_FIXED_PATH='0';try{graph=await CodeGraph.init(f.project,{index:true});file=graph.getDatabaseFilePath();await close(graph);}finally{delete process.env.CODEGRAPH_FIXED_PATH;}
 } else {
  file=path.join(f.data,'codegraph.db');const db=DatabaseConnection.initialize(file);db.close();graph=CodeGraph.openSync(f.project);await graph.indexAll();await close(graph);
 }
 custom(file,kind);const pointer=kind==='generational'?fs.readFileSync(path.join(f.data,'CURRENT'),'utf8'):null;
 capture(f,'before-open',false);graph=CodeGraph.openSync(f.project);
 try{assert.equal(graph.getDatabaseFilePath(),file);assert(graph.searchNodes('default_layout_symbol').length);capture(f,'legacy-running',false);}finally{await close(graph);}
 assert(!fs.existsSync(path.join(f.data,'.runtime','layout.json')),'normal open must not silently migrate');
 assert.throws(()=>CodeGraph.initSync(f.project),/already initialized/i);
 await assert.rejects(CodeGraph.init(f.project,{index:true}),/already initialized/i);
 cli(f,['init',f.project]);capture(f,'init-no-overwrite',false);
 assert(!fs.existsSync(path.join(f.data,'.runtime','layout.json')),'CLI init existing data must not silently migrate');
 assert.equal(readCustom(file),kind);if(pointer!==null)assert.equal(fs.readFileSync(path.join(f.data,'CURRENT'),'utf8'),pointer);
 if(kind==='root') {
  for(let i=0;i<140;i++)fs.writeFileSync(path.join(f.project,`community_${i}.py`),`def community_${i}():\n    return ${i}\n`);
  graph=CodeGraph.openSync(f.project);let decision;
  try {const result=await graph.sync({onAdaptiveDecision:value=>decision=value});assert.notEqual(result.adaptive?.strategy,'rebuild');assert(graph.searchNodes('community_139').length);capture(f,'community-root-default-sync',false);}
  finally {await close(graph);}
  fs.writeFileSync(path.join(f.dir,'community-sync-decision.json'),JSON.stringify(decision??null,null,2));
  cli(f,['sync',f.project,'--quiet']);
  assert(!fs.existsSync(path.join(f.data,'CURRENT')),'community root sync must not create CURRENT');
  assert(!fs.existsSync(path.join(f.data,'generations')),'community root sync must not create generations');
  assert(!fs.existsSync(path.join(f.data,'.runtime','layout.json')),'normal sync must not implicitly register/migrate community database');
  assert.equal(readCustom(file),kind);capture(f,'community-root-closed',false);
 }
 await CodeGraph.migrateStorage(f.project,{offline:true});await reclaimed(f.data);capture(f,'explicit-offline-migration');
 assert.equal(readCustom(path.join(f.data,'codegraph.db')),kind);graph=CodeGraph.openSync(f.project);
 try{assert(graph.searchNodes('default_layout_symbol').length);capture(f,'migrated-reopened');}finally{await close(graph);}
 await reclaimed(f.data);capture(f,'closed');
});
