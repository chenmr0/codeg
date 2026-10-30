import { afterEach, describe, expect, it, vi } from 'vitest';
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const workers: FakeWorker[] = [];
let failAt = -1;
class FakeWorker extends EventEmitter {
  terminate = vi.fn(() => Promise.resolve(1));
  postMessage = vi.fn();
  constructor() { super(); if (workers.length === failAt) throw new Error('spawn denied'); workers.push(this); }
  exit() { this.emit('exit', 0); }
}
let StoreWriter: any, ResolverPool: any;
function fixture() {
  const original = Module._load;
  vi.spyOn(Module, '_load').mockImplementation(function(this: unknown, ...args: any[]) {
    if (args[0] === 'node:worker_threads' || args[0] === 'worker_threads') return { Worker: FakeWorker };
    return original.apply(this, args);
  });
  StoreWriter = require('../dist/extraction/store-writer').StoreWriter;
  ResolverPool = require('../dist/resolution/resolver-pool').ResolverPool;
  vi.useFakeTimers();
  const release = vi.fn();
  return { release, factory: () => ({release}) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); workers.length=0; failAt=-1; });

describe('native store and resolver lifetime', () => {
  it.each(['resolve','reject','throw'])('store close waits actual exit despite terminate %s', async mode => {
    const {release,factory}=fixture();
    const store=new StoreWriter('worker.js','/unmanaged.db',false,undefined,factory);
    if(mode==='reject') workers[0].terminate.mockRejectedValue(new Error('terminate failed'));
    if(mode==='throw') workers[0].terminate.mockImplementation(()=>{throw new Error('terminate failed')});
    let closed=false; const pending=store.close().then(()=>closed=true);
    expect(store.close()).toBe(store.close());
    await vi.advanceTimersByTimeAsync(5000);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(closed).toBe(false);expect(release).not.toHaveBeenCalled();
    workers[0].exit();await pending;
    expect(release).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it('store startup failure releases its acquired lease',()=>{
    const {release,factory}=fixture();failAt=0;
    expect(()=>new StoreWriter('worker.js','/unmanaged.db',false,undefined,factory)).toThrow('spawn denied');
    expect(release).toHaveBeenCalledOnce();
  });
  it('store clean early exit rejects ready instead of hanging',async()=>{
    const {release,factory}=fixture();const store=new StoreWriter('worker.js','/unmanaged.db',false,undefined,factory);
    workers[0].exit();await expect(store.ready()).rejects.toThrow('before ready');await store.close();expect(release).toHaveBeenCalledOnce();
  });
  it('resolver partial startup retains prior member until exit',async()=>{
    const {release,factory}=fixture();failAt=1;
    expect(()=>new ResolverPool('worker.js','/unmanaged.db','/',2,factory)).toThrow('spawn denied');
    expect(release).toHaveBeenCalledTimes(1); // Only uncreated second member released.
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    await Promise.resolve();expect(release).toHaveBeenCalledTimes(1);
    workers[0].exit();await Promise.resolve();expect(release).toHaveBeenCalledTimes(2);
  });
  it.each(['resolve','reject','throw'])('resolver destroy waits all exit events despite terminate %s',async mode=>{
    const {release,factory}=fixture();const pool=new ResolverPool('worker.js','/unmanaged.db','/',2,factory);
    for(const worker of workers) {
      if(mode==='reject')worker.terminate.mockRejectedValue(new Error('terminate failed'));
      if(mode==='throw')worker.terminate.mockImplementation(()=>{throw new Error('terminate failed')});
    }
    let closed=false;const pending=pool.destroy().then(()=>closed=true);
    await Promise.resolve();expect(closed).toBe(false);expect(release).not.toHaveBeenCalled();
    workers[0].exit();await Promise.resolve();expect(closed).toBe(false);expect(release).toHaveBeenCalledTimes(1);
    workers[1].exit();await pending;expect(release).toHaveBeenCalledTimes(2);
  });
  it('resolver release failure still waits for every other native thread to exit',async()=>{
    fixture();let lease=0;
    const pool=new ResolverPool('worker.js','/unmanaged.db','/',2,()=>{
      const id=lease++;return {release(){if(id===0)throw new Error('lease close failed')}};
    });
    let settled=false;const result=pool.destroy().then(()=>{settled=true;return null},(error:Error)=>{settled=true;return error});
    workers[0].exit();await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);
    workers[1].exit();expect(await result).toBeInstanceOf(AggregateError);
  });

  it('normal unexpected resolver exit rejects pending work immediately',async()=>{
    const {factory}=fixture();const pool=new ResolverPool('worker.js','/unmanaged.db','/',2,factory);
    for(const worker of workers)worker.emit('message',{type:'ready'});
    await pool.ready();
    const result=pool.resolveBatch([{id:'pending'}]).then(()=>null,(error:Error)=>error);
    workers[0].exit();expect(await result).toMatchObject({message:'resolver worker exited with code 0'});
    const destroyed=pool.destroy();workers[1].exit();await destroyed;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('a parent synchronous open capability cannot replace a worker lease factory',()=>{
    fixture();const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-worker-factory-'));
    try {
      fs.mkdirSync(path.join(root,'.runtime'));fs.writeFileSync(path.join(root,'.runtime','layout.json'),'{}');
      const file=path.join(root,'codegraph.db');fs.writeFileSync(file,'');
      const {withFixedPathOpen}=require('../dist/sync/fixed-path/open-context');
      expect(()=>withFixedPathOpen(file,()=>new StoreWriter('worker.js',file,false))).toThrow('independent lease factory');
      expect(workers).toHaveLength(0);
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
  });

});
