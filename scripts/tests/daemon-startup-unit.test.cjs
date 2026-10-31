// Unit lifecycle evidence only: in-memory listener/streams, never an OS/Windows claim.
const test=require('node:test'),assert=require('node:assert/strict');
const net=require('node:net'),{EventEmitter}=require('node:events'),{Duplex}=require('node:stream');
const {Daemon}=require('../../dist/mcp/daemon');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function socket(){return new Duplex({read(){},write(_b,_e,done){done();}});}
function cleanup(t,daemon){
 // Never let a unit exercise the daemon's process.exit shutdown owner.
 daemon.stop=async()=>{};
 const before=new Map(['SIGINT','SIGTERM'].map(name=>[name,new Set(process.listeners(name))]));
 t.after(async()=>{await sleep(0);daemon.disarmIdleTimer();clearInterval(daemon.maxIdleTimer);clearInterval(daemon.clientSweepTimer);for(const [name,handlers]of before)for(const handler of process.listeners(name))if(!handlers.has(handler))process.removeListener(name,handler);});
}
test('unattached startup never begins blocking engine work and exits under unchanged 200ms idle',async t=>{
 const daemon=new Daemon(process.cwd(),{idleTimeoutMs:200,maxIdleMs:0});cleanup(t,daemon);
 let initialized=0;const stopped=[];
 t.mock.method(daemon.engine,'ensureInitialized',async()=>{initialized++;await new Promise(setImmediate);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,450);});
 t.mock.method(daemon,'stop',async reason=>{stopped.push(reason);});
 t.mock.method(net,'createServer',()=>{const server=new EventEmitter();server.listen=(_path,ready)=>process.nextTick(ready);return server;});
 await daemon.start();
 assert.equal(initialized,0,'cold open must not occupy event loop before first transport admission');
 await sleep(350);assert.deepEqual(stopped,['idle timeout']);assert.equal(initialized,0);
});
test('engine starts only after hello is handed to a live session, not on accept',async t=>{
 const daemon=new Daemon(process.cwd(),{idleTimeoutMs:200,maxIdleMs:0});cleanup(t,daemon);
 const observed=[];t.mock.method(daemon.engine,'ensureInitialized',async()=>{observed.push(daemon.getClientCount());});
 const stream=socket();t.after(()=>stream.destroy());daemon.handleConnection(stream);
 await sleep(250);assert.deepEqual(observed,[]);
 stream.push(JSON.stringify({codegraph_client:1,pid:process.pid})+'\n');
 await sleep(0);assert.deepEqual(observed,[1]);assert.equal(daemon.getClientCount(),1);
 stream.destroy();await sleep(0);
});
test('abandoned accepted hello never initializes database or creates a session',async t=>{
 const daemon=new Daemon(process.cwd(),{idleTimeoutMs:200,maxIdleMs:0});cleanup(t,daemon);
 let initialized=0;const stopped=[];t.mock.method(daemon.engine,'ensureInitialized',async()=>{initialized++;});t.mock.method(daemon,'stop',async reason=>{stopped.push(reason);});
 const stream=socket();daemon.handleConnection(stream);stream.destroy();await sleep(350);
 assert.equal(initialized,0);assert.equal(daemon.getClientCount(),0);assert.deepEqual(stopped,['idle timeout']);
});
for(const outcome of ['reject','pending'])test(`last disconnect re-arms idle even if engine initialization stays ${outcome}`,async t=>{
 const daemon=new Daemon(process.cwd(),{idleTimeoutMs:200,maxIdleMs:0});cleanup(t,daemon);
 let entered=0;const stopped=[];
 t.mock.method(daemon.engine,'ensureInitialized',()=>{entered++;return outcome==='reject'?Promise.reject(new Error('injected engine rejection')):new Promise(()=>{});});
 t.mock.method(daemon,'stop',async reason=>{stopped.push(reason);});
 const stream=socket();daemon.handleConnection(stream);stream.push(JSON.stringify({codegraph_client:1,pid:process.pid})+'\n');await sleep(0);
 assert.equal(entered,1);stream.destroy();await sleep(350);assert.equal(daemon.getClientCount(),0);assert.deepEqual(stopped,['idle timeout']);
});
