const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {CodeGraph}=require('../../dist');
const {DatabaseOpenError}=require('../../dist/db');
const {FixedPathController}=require('../../dist/sync/fixed-path/controller');
const {FixedPathWriterLock}=require('../../dist/sync/fixed-path/writer-lock');
process.env.CODEGRAPH_FIXED_PATH='1';

test('a later reader construction failure must not discard an earlier failed writer native handle',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-failed-natives-'));
  let controller,probe,aOpen=true,bOpen=true,allowA=false;
  try{
    const graph=await CodeGraph.init(root);
    const dataDirectory=graph.getDataDirectory();graph.close();
    // Inject close outcomes, while using the real controller, SQLite mutation
    // reservation and participant lifecycle. A cannot yet prove native closure.
    const a={isOpen:()=>aOpen,close(){if(!allowA)throw Error('writer A is still open');aOpen=false;}};
    const b={isOpen:()=>bOpen,close(){bOpen=false;}};
    controller=new FixedPathController({project:root,dataDirectory},(_file,readOnly)=>{
      throw new DatabaseOpenError(readOnly?b:a,Error('construction failed'),Error('native close failed'));
    });
    assert.throws(()=>controller.writeSync(()=>{}),DatabaseOpenError);
    assert.throws(()=>controller.readSync(()=>{}),DatabaseOpenError);
    assert.throws(()=>controller.close(),/writer A|native|close/i);
    probe=new FixedPathWriterLock(dataDirectory);
    assert.throws(()=>probe.acquire(),/locked/,'failed writer still requires mutation protection');
    allowA=true;controller.close();
    assert.equal(aOpen,false);assert.equal(bOpen,false);
    probe.acquire();probe.release();
  }finally{
    allowA=true;probe?.release();try{controller?.close();}catch{}
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('writer native workers retain mutation ownership after parent handle closes until actual exit release',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-worker-reservation-'));
  let controller,worker,probe;
  try{
    const graph=await CodeGraph.init(root),dataDirectory=graph.getDataDirectory();graph.close();
    controller=new FixedPathController({project:root,dataDirectory},(_file,_readOnly,retain)=>({close(){},retain}));
    controller.writeSync(handle=>{worker=handle.retain();});
    probe=new FixedPathWriterLock(dataDirectory);
    assert.throws(()=>probe.acquire(),/locked/);
    assert.throws(()=>controller.close(),/active operations/);
    let idle=false;const waiting=controller.whenIdle().then(()=>{idle=true;});
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(idle,false);
    worker.release();await waiting;assert.equal(idle,true);
    probe.acquire();probe.release();controller.close();
  }finally{worker?.release();probe?.release();controller?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('worker exit with mutation-release failure settles idle wait with the error and permits explicit close retry',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-worker-release-error-'));
  const original=FixedPathWriterLock.prototype.release;let controller,worker,fail=true;
  try{
    const graph=await CodeGraph.init(root),dataDirectory=graph.getDataDirectory();graph.close();
    controller=new FixedPathController({project:root,dataDirectory},(_file,_reader,retain)=>({close(){},retain}));
    controller.writeSync(handle=>{worker=handle.retain();});
    const waiting=assert.rejects(controller.whenIdle(),/injected mutation release/);
    FixedPathWriterLock.prototype.release=function(){if(fail)throw Error('injected mutation release');return original.call(this);};
    assert.throws(()=>worker.release(),/injected mutation release/);await waiting;
    fail=false;controller.close();await controller.whenIdle();
  }finally{fail=false;FixedPathWriterLock.prototype.release=original;worker?.release();controller?.close();fs.rmSync(root,{recursive:true,force:true});}
});
