// Canonicalize fixture roots: Windows TEMP may use an 8.3 alias while production resolves real paths.
// Real CLI stdio + shared-daemon integration; no mocked transport/database.
const rawTest=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
function test(name,options,fn){if(!process.env.E2E_CASE||name.includes(process.env.E2E_CASE))rawTest(name,options,fn);}
const {spawn}=require('node:child_process');const {pathToFileURL}=require('node:url');
const {CodeGraph}=require('../../dist');const {records,paths,seal}=require('../../dist/sync/fixed-path/protocol');
process.env.CODEGRAPH_ALL_LANGUAGES='1';process.env.CODEGRAPH_FIXED_PATH='1';
const bin=path.resolve('dist/bin/codegraph.js');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=20000){const start=Date.now();let last;while(Date.now()-start<ms){try{const value=await fn();if(value)return value;}catch(e){last=e;}await sleep(50);}throw new Error(`condition timed out: ${last?.stack||''}`);}
function client(dir,direct=false,preload,watch=false){
 const child=spawn(process.execPath,['--liftoff-only',...(preload?['--require',preload]:[]),bin,'serve','--mcp','--path',dir,...((direct&&!watch)||preload?['--no-watch']:[])],{cwd:dir,env:{...process.env,CODEGRAPH_NO_DAEMON:direct?'1':'0',CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS:'200',CODEGRAPH_WATCH_DEBOUNCE_MS:'100',CODEGRAPH_MCP_LOG_ATTACH:'1',CODEGRAPH_MCP_CATCHUP_BUDGET_MS:'5000'},stdio:['pipe','pipe','pipe']});
 let buf='',seq=0,stderr='';const pending=new Map(),samples=[];child.stderr.on('data',b=>stderr+=b);child.stdin.on('error',()=>{});
 child.stdout.on('data',b=>{buf+=b;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);try{const m=JSON.parse(line),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);samples.push(performance.now()-p.start);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}catch{}}});
 const exited=new Promise(r=>child.once('close',code=>{for(const p of pending.values())p.reject(new Error(`server exited ${code}: ${stderr}`));r(code);}));
 function rpc(method,params){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`RPC timeout ${method}: ${stderr}`));},25000);pending.set(id,{resolve,reject,timer,start:performance.now()});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
 return {child,samples,get stderr(){return stderr},async waitForDaemon(){
  // initialize is intentionally answered locally before the daemon connects.
  // stdout response arrival also does not order delivery on the stderr pipe.
  const started=Date.now();
  while(!/Attached to shared daemon/.test(stderr)){
   if(child.exitCode!==null||child.signalCode!==null)throw new Error(`MCP exited before real daemon attachment: ${stderr}`);
   if(/falling back|serving this session in-process|Proxy path failed/i.test(stderr))throw new Error(`MCP daemon fallback is not daemon coverage: ${stderr}`);
   if(Date.now()-started>=10000)throw new Error(`Real daemon attachment not confirmed within 10 seconds: ${stderr}`);
   await sleep(10);
  }
 },async start(){await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fixed-path-e2e',version:'1'},rootUri:pathToFileURL(dir).href});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');},async search(query){const r=await rpc('tools/call',{name:'search',arguments:{query}});assert(!r.isError,JSON.stringify(r));return JSON.stringify(r);},async close(){child.stdin.end();await Promise.race([exited,sleep(5000).then(()=>{child.kill();return exited;})]);}};
}
function main(dir,n=1){fs.writeFileSync(path.join(dir,'main.py'),`def stable(value=${n}):\n    return value\n`);}
function files(dir,prefix){for(let n=0;n<140;n++)fs.writeFileSync(path.join(dir,`${prefix}${n}.py`),`def ${prefix}${n}():\n    return ${n}\n`);}
function root(){return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'cg-real-mcp-')));}

for(const mode of ['direct','daemon'])test(`real ${mode}: cross-process watcher rebuild, idle reconnect and offline public overwrite`, {timeout:90000},async()=>{
 const dir=root(),producer=root();main(dir);main(producer,77);let graph=await CodeGraph.init(dir,{index:true});let p=await CodeGraph.init(producer,{index:true});p.close();const publicDb=path.join(producer,'.codegraph-wx/codegraph.db');seal(publicDb,{standalone:true});const active=path.join(dir,'.codegraph-wx/codegraph.db');
 let clients=[],stop=false,load;const logs=[];
 try{
  clients=mode==='daemon'?[client(dir,true),client(dir),client(dir)]:[client(dir,true,undefined,true),client(dir,true),client(dir,true)];await Promise.all(clients.map(c=>c.start()));await Promise.all(clients.map(c=>c.search('stable')));
  if(mode==='daemon'){await until(()=>fs.existsSync(path.join(dir,'.codegraph-wx/daemon.pid')));await Promise.all(clients.slice(1).map(c=>c.waitForDaemon()));}
  const identity=graph.getDatabaseIdentity();let count=0;
  load=(async()=>{while(!stop){await Promise.all(clients.map(async c=>assert.match(await c.search('stable'),/stable/)));count+=clients.length;await sleep(30);}})();
  files(dir,'automatic_');await until(()=>graph.searchNodes('automatic_139').some(n=>n.node.name==='automatic_139'),30000);
  assert.notEqual(graph.getDatabaseIdentity(),identity);assert.equal(graph.getDatabaseFilePath(),active);assert(records(paths(dir)).some(r=>r.phase==='cleaned'));
  await Promise.all(clients.map(async c=>assert.match(await c.search('automatic_139'),/automatic_139/)));
  // Second rebuild exercises persistent native connections, not first-open only.
  for(const f of fs.readdirSync(dir))if(f.startsWith('automatic_'))fs.unlinkSync(path.join(dir,f));files(dir,'second_');
  await until(()=>graph.searchNodes('second_139').some(n=>n.node.name==='second_139'),30000);await Promise.all(clients.map(async c=>assert.match(await c.search('second_139'),/second_139/)));
  stop=true;await load;load=null;logs.push({requests:count,clients:clients.map(c=>({samples:c.samples,stderr:c.stderr}))});await Promise.all(clients.map(c=>c.close()));clients=[];await until(()=>!fs.existsSync(path.join(dir,'.codegraph-wx/daemon.pid')));graph.close();graph=null;
  assert(!fs.existsSync(active+'-wal'));assert(!fs.existsSync(active+'-shm'));for(const f of fs.readdirSync(dir))if(f.endsWith('.py'))fs.unlinkSync(path.join(dir,f));main(dir,77);fs.copyFileSync(publicDb,active);
  clients=mode==='daemon'?[client(dir,true),client(dir)]:[client(dir,true,undefined,true),client(dir,true)];await Promise.all(clients.map(c=>c.start()));await Promise.all(clients.map(async c=>assert.match(await c.search('stable'),/77/)));graph=CodeGraph.openSync(dir);assert.equal(graph.getDatabaseFilePath(),active);main(dir,88);await until(()=>graph.searchNodes('stable').some(n=>/88/.test(n.node.signature)),15000);await Promise.all(clients.map(async c=>assert.match(await c.search('stable'),/88/)));
 }finally{logs.push({phase:'final-state',clients:clients.map(c=>({samples:c.samples,stderr:c.stderr,exitCode:c.child.exitCode}))});stop=true;if(load)await load.catch(()=>{});await Promise.all(clients.map(c=>c.close()));await until(()=>!fs.existsSync(path.join(dir,'.codegraph-wx/daemon.pid'))).catch(()=>{});graph?.close();fs.mkdirSync('artifacts/phase2-real-mcp',{recursive:true});fs.writeFileSync(`artifacts/phase2-real-mcp/transport-${mode}.json`,JSON.stringify(logs,null,2));fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(producer,{recursive:true,force:true});}
});

for(const direct of [true,false]) test(`actual ${direct?'direct stdio':'shared daemon'} MCP in-flight response pins old database; failed drain preserves it`, {timeout:60000},async()=>{
  const dir=root();main(dir);const graph=await CodeGraph.init(dir,{index:true});const ready=path.join(dir,'request.ready'),release=path.join(dir,'request.release'),hook=path.join(os.tmpdir(),path.basename(dir)+'-hold.cjs');
  // Test-only deterministic scheduling AFTER real query acquired request pin.
  // Transport, ToolHandler lifecycle, native DB and publisher remain real.
  fs.writeFileSync(hook,`const fs=require('node:fs');const {ToolHandler}=require(${JSON.stringify(path.resolve('dist/mcp/tools.js'))});const original=ToolHandler.prototype.handleSearch;ToolHandler.prototype.handleSearch=async function(args){const result=await original.call(this,args);if(args.query==='stable'&&fs.existsSync(${JSON.stringify(path.join(dir,'arm'))})){fs.writeFileSync(${JSON.stringify(ready)},'pinned');while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,10));}return result;};`);
  const c=client(dir,direct,hook);let pending;
  try{
   await c.start();await c.search('stable');if(!direct)await c.waitForDaemon();const oldFile=fs.statSync(path.join(dir,'.codegraph-wx/codegraph.db'),{bigint:true});fs.writeFileSync(path.join(dir,'arm'),'');pending=c.search('stable');await until(()=>fs.existsSync(ready));files(dir,'blocked_');
   await assert.rejects(graph.sync(),/Drain|drain|cancelled/);const retainedFile=fs.statSync(path.join(dir,'.codegraph-wx/codegraph.db'),{bigint:true});assert.equal(retainedFile.ino,oldFile.ino);assert.equal(retainedFile.dev,oldFile.dev);assert.equal(graph.searchNodes('blocked_139').length,0);assert.equal(graph.searchNodes('stable').length,1);
   fs.writeFileSync(release,'');assert.match(await pending,/stable/);pending=null;fs.unlinkSync(path.join(dir,'arm'));await graph.sync();assert.match(await c.search('blocked_139'),/blocked_139/);
   // A direct stdio EOF drains already-admitted async response, not close under it.
   if(direct){fs.unlinkSync(ready);fs.unlinkSync(release);fs.writeFileSync(path.join(dir,'arm'),'');pending=c.search('stable').then(value=>({value}),error=>({error}));await until(()=>fs.existsSync(ready));c.child.stdin.end();await sleep(100);assert.equal(c.child.exitCode,null);fs.writeFileSync(release,'');const eof=await pending;if(eof.error)assert.match(eof.error.message,/Request cancelled/);else assert.match(eof.value,/stable/);pending=null;}
  }finally{fs.writeFileSync(release,'');if(pending)await pending.catch(()=>{});await c.close();await until(()=>!fs.existsSync(path.join(dir,'.codegraph-wx/daemon.pid'))).catch(()=>{});graph.close();fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(hook,{force:true});}
});

for(const direct of [true,false])test(`real ${direct?'direct':'daemon'} cold catch-up joins a concurrent SDK rebuild without publisher collision`,{timeout:45000},async()=>{
 const dir=root();main(dir);const graph=await CodeGraph.init(dir,{index:true});files(dir,'join_');
 const rebuild=require('../../dist/sync/fixed-path/rebuild'),original=rebuild.runFixedPathRebuild;
 let release,entered;const hold=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let c,pending;
 rebuild.runFixedPathRebuild=async(...args)=>{entered();await hold;return original(...args);};
 try{
  pending=graph.sync();await ready;c=client(dir,direct);
  // Force initialize/stdout to be observed before attachment/stderr, a valid
  // cold-start ordering that previously failed an immediate log assertion.
  if(!direct)c.child.stderr.pause();
  await c.start();
  if(!direct){
   assert.equal(c.stderr,'');
   let attached=false;const attachment=c.waitForDaemon().then(()=>attached=true);
   await sleep(30);assert.equal(attached,false);
   c.child.stderr.resume();await attachment;
   assert.match(c.stderr,/Attached to shared daemon/);
  }
  await sleep(150);const querying=c.search('join_139');release();
  const result=await pending;assert.equal(result.adaptive.strategy,'rebuild');
  const response=await querying;assert.match(response,/join_139/);assert(!/Startup index refresh was incomplete/.test(response),response);
  const daemonLog=!direct?fs.readFileSync(path.join(dir,'.codegraph-wx/daemon.log'),'utf8'):'';
  assert(!/Catch-up sync failed|Another publisher\/recovery/.test(c.stderr+daemonLog),c.stderr+daemonLog);
  fs.mkdirSync('artifacts/phase2-real-mcp',{recursive:true});fs.writeFileSync(`artifacts/phase2-real-mcp/cold-${direct?'direct':'daemon'}.json`,JSON.stringify({response,stderr:c.stderr,daemonLog},null,2));
  assert.equal(records(paths(dir)).filter(r=>r.phase==='cleaned').length,1);
 }finally{release();rebuild.runFixedPathRebuild=original;await pending?.catch(()=>{});await c?.close();await until(()=>!fs.existsSync(path.join(dir,'.codegraph-wx/daemon.pid'))).catch(()=>{});await graph.whenIdle();graph.close();fs.rmSync(dir,{recursive:true,force:true});}
});
