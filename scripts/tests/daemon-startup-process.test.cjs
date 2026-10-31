// Real child processes + real UNIX sockets / Windows named pipes. Never mock
// process.platform or count fallback as success. Run on an OS-capable executor.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),net=require('node:net');
const packageRoot=path.resolve(process.env.CODEGRAPH_TEST_PACKAGE||path.join(__dirname,'../..'));
const {CodeGraph}=require(path.join(packageRoot,'dist'));
const {connectWithHello}=require(path.join(packageRoot,'dist/mcp/proxy'));
const {getDaemonPidPath}=require(path.join(packageRoot,'dist/mcp/daemon-paths'));
const {snapshot,contract}=require('./helpers/layout-disk-evidence.cjs');
const out=path.resolve(process.env.CODEGRAPH_DAEMON_STARTUP_EVIDENCE||'artifacts/daemon-startup-process');fs.mkdirSync(out,{recursive:true});
delete process.env.CODEGRAPH_FIXED_PATH;process.env.CODEGRAPH_ALL_LANGUAGES='1';process.env.CODEGRAPH_DAEMON_TRACE='1';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,ms=5000){const deadline=Date.now()+ms;while(Date.now()<deadline){const value=fn();if(value)return value;await sleep(10);}throw new Error(`condition exceeded ${ms}ms`);}
async function fixture(t,mode='delay'){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cg-startup-'))),data=path.join(root,'.codegraph-wx');
 fs.writeFileSync(path.join(root,'main.py'),'def startup_query(value=42):\n    return value\n');
 const graph=await CodeGraph.init(root,{index:true});graph.close();await graph.whenIdle();
 const sockets=[],events=[];let stdout='',stderr='',buffer='';
 const child=spawn(process.execPath,['--liftoff-only',path.join(__dirname,'fixtures/daemon-startup-server.cjs'),packageRoot,root,mode],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,CODEGRAPH_NO_WATCH:'1',CODEGRAPH_DAEMON_TRACE:'1'}});
 const exited=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 child.stdout.on('data',chunk=>{stdout+=chunk;buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{events.push(JSON.parse(line));}catch{}}});child.stderr.on('data',chunk=>stderr+=chunk);
 function save(phase){const disk=snapshot(data);fs.writeFileSync(path.join(out,`${path.basename(root)}-${phase}.json`),JSON.stringify({platform:process.platform,mode,events,stdout,stderr,disk},null,2));return disk;}
 t.after(async()=>{
  save('before-teardown');for(const socket of sockets)socket.destroy();
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}
  save('after-exit');fs.rmSync(root,{recursive:true,force:true});
 });
 const ready=await until(()=>{if(child.exitCode!==null)throw new Error(`daemon exited before listening: ${stderr}`);return events.find(e=>e.event==='listening');});contract(save('listening'));
 async function connect(){const socket=await connectWithHello(ready.socket);assert(socket&&socket!=='version-mismatch',`No real daemon hello: ${stderr}`);sockets.push(socket);return socket;}
 async function closeAndVerify(){for(const socket of sockets)socket.destroy();let timer,end;try{end=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`daemon failed to idle-exit: ${stderr}`)),5000);})]);}finally{clearTimeout(timer);}assert.equal(end.code,0,stderr);assert.equal(end.signal,null);assert(!fs.existsSync(getDaemonPidPath(root)));contract(save('closed'));}
 return {root,ready,events,connect,closeAndVerify,save,sockets,exited,get stderr(){return stderr;}};
}
function rpc(socket,method,params,id){return new Promise((resolve,reject)=>{let buffer='';const timer=setTimeout(()=>finish(new Error(`RPC ${method} exceeded existing 25000ms tool budget`)),25000);const onClose=()=>finish(new Error('daemon closed while query was pending'));function finish(error,result){clearTimeout(timer);socket.removeListener('data',data);socket.removeListener('close',onClose);error?reject(error):resolve(result);}function data(chunk){buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);let value;try{value=JSON.parse(line);}catch{continue;}if(value.id===id){if(value.error)finish(new Error(JSON.stringify(value.error)));else finish(null,value.result);return;}}}socket.on('data',data);socket.once('close',onClose);socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
async function query(socket){await rpc(socket,'initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'startup-admission',version:'1'}},1);const result=await rpc(socket,'tools/call',{name:'search',arguments:{query:'startup_query'}},2);assert(!result.isError,JSON.stringify(result));assert.match(JSON.stringify(result),/startup_query/);assert.match(JSON.stringify(result),/42/);}
test('orphan startup exits with no database initialization and removes its actual pid lock',{timeout:15000},async t=>{
 const f=await fixture(t);await f.closeAndVerify();assert(!f.events.some(e=>e.event==='engine-enter'));
});
test('two real clients get daemon hello and queries across a 450ms cold-open stall with idle=200ms',{timeout:45000},async t=>{
 const f=await fixture(t);const sockets=await Promise.all([f.connect(),f.connect()]);await Promise.all(sockets.map(query));assert(f.events.some(e=>e.event==='engine-enter'));contract(f.save('queried'));await f.closeAndVerify();
});
test('queued second client survives first client abandoning initialization',{timeout:45000},async t=>{
 const f=await fixture(t),first=await f.connect();await until(()=>f.events.some(e=>e.event==='engine-stall-start'));first.destroy();const connectAt=Date.now();f.events.push({event:'second-connect-start',at:connectAt});const second=await f.connect();await query(second);const stallEnd=await until(()=>f.events.find(e=>e.event==='engine-stall-end'));assert(connectAt<stallEnd.at,'test did not exercise a queued connection during the injected stall');await f.closeAndVerify();
});
test('initialization rejection cannot keep a disconnected daemon alive',{timeout:15000},async t=>{
 const f=await fixture(t,'reject');await f.connect();await until(()=>f.events.some(e=>e.event==='engine-enter'));await f.closeAndVerify();
});
test('accepted raw peer abandoning its hello does not initialize or leak the daemon',{timeout:15000},async t=>{
 const f=await fixture(t);const socket=net.createConnection(f.ready.socket);f.sockets.push(socket);await new Promise((resolve,reject)=>{socket.once('data',resolve);socket.once('error',reject);});socket.destroy();await f.closeAndVerify();assert(!f.events.some(e=>e.event==='engine-enter'));
});
