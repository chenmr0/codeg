// Real independent daemon process with a deterministic test-only cold-open stall.
const path=require('node:path');
const [packageRoot,root,mode]=process.argv.slice(2);
const {MCPEngine}=require(path.join(packageRoot,'dist/mcp/engine'));
const original=MCPEngine.prototype.doInitialize;
MCPEngine.prototype.doInitialize=async function(...args){
 process.stdout.write(JSON.stringify({event:'engine-enter',at:Date.now()})+'\n');
 // Yield once: on the old implementation listen completes before the stall,
 // and independent clients queue in the OS while JS cannot process accept.
 await new Promise(setImmediate);
 process.stdout.write(JSON.stringify({event:'engine-stall-start',at:Date.now()})+'\n');
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,450);
 process.stdout.write(JSON.stringify({event:'engine-stall-end',at:Date.now()})+'\n');
 if(mode==='reject')throw new Error('injected startup initialization failure');
 return original.apply(this,args);
};
const {Daemon,tryAcquireDaemonLock}=require(path.join(packageRoot,'dist/mcp/daemon'));
(async()=>{
 const lock=tryAcquireDaemonLock(root);if(lock.kind!=='acquired')throw new Error('Fixture daemon lock was not exclusive');
 const daemon=new Daemon(root,{idleTimeoutMs:200,maxIdleMs:0});
 const ready=await daemon.start();process.stdout.write(JSON.stringify({event:'listening',at:Date.now(),socket:ready.socketPath,pid:process.pid})+'\n');
})().catch(error=>{console.error(error);process.exitCode=1;});
