/** Opt-in diagnostic preload: CODEGRAPH_PROFILE_OUTPUT=... node --require ./scripts/profile-init.cjs ... */
'use strict';
const output = process.env.CODEGRAPH_PROFILE_OUTPUT;
if (output) {
  const wt = require('node:worker_threads');
  const protocolMessage = message => message && typeof message === 'object' &&
    Object.getPrototypeOf(message) === Object.prototype && typeof message.type === 'string';
  const clock = () => Number(process.hrtime.bigint()) / 1e6;
  const threadCpu = () => typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null;
  const elapsedCpu = (before) => { const after = threadCpu(); return before && after ? (after.user + after.system - before.user - before.system) / 1000 : null; };
  if (!wt.isMainThread && wt.parentPort) {
    const port = wt.parentPort, on = port.on, post = port.postMessage;
    let active;
    port.on = function (event, listener) {
      if (event !== 'message') return on.call(this, event, listener);
      return on.call(this, event, function (message) {
        const previous = active;
        const current = { start: clock(), cpu: threadCpu(), sent: message?.__cgSent };
        if (message && typeof message === 'object') delete message.__cgSent;
        active = current;
        const finish = () => { if (active === current) active = previous; };
        try {
          const result = listener.call(this, message);
          if (result && typeof result.then === 'function') return result.finally(finish);
          finish(); return result;
        } catch (error) { finish(); throw error; }
      });
    };
    port.postMessage = function (message, ...args) {
      if (active && protocolMessage(message)) {
        message = { ...message, __cgProfile: { thread: wt.threadId, start: active.start, end: clock(),
          cpuMs: elapsedCpu(active.cpu), sent: active.sent } };
      }
      return post.call(this, message, ...args);
    };
  } else if (wt.isMainThread) {
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const { PerformanceObserver } = require('node:perf_hooks');
    const startedAt = new Date().toISOString();
    const start = clock(), events = [], tasks = [], workers = [], samples = [], gc = [];
    const parsePools = new Set(), resolverPools = new Set(), writers = new Set(), pipelines = new Set(), requests = new WeakMap();
    const patched = new WeakSet();
    let nextWorker = 0, nextTask = 0;
    const OriginalWorker = wt.Worker;
    wt.Worker = class ProfiledWorker extends OriginalWorker {
      constructor(file, options) {
        super(file, options);
        this.__cgId = ++nextWorker;
        const role = path.basename(String(file));
        workers.push({ id: this.__cgId, role, start: clock(), event: 'spawn' });
        this.on('message', message => {
          const profile = message?.__cgProfile;
          if (!profile) return;
          tasks.push({ worker: this.__cgId, role, type: message.type, received: clock(), ...profile });
          delete message.__cgProfile;
        });
        this.on('exit', code => workers.push({ id: this.__cgId, role, end: clock(), event: 'exit', code }));
      }
      postMessage(message, ...args) {
        const before = clock();
        const sent = { id: ++nextTask, time: before, type: message?.type,
          file: message?.filePath ?? message?.bundle?.file?.path,
          refs: message?.refs?.length };
        const result = super.postMessage(protocolMessage(message) ? { ...message, __cgSent: sent } : message, ...args);
        events.push({ name: 'worker.postMessage', worker: this.__cgId, start: before, end: clock(), type: message?.type });
        return result;
      }
    };
    function wrap(object, name, label, before) {
      if (typeof object?.[name] !== 'function') return;
      const original = object[name];
      object[name] = function (...args) {
        before?.call(this, args);
        const at = clock(), cpu = threadCpu();
        const finish = () => events.push({ name: label, start: at, end: clock(), cpuMs: elapsedCpu(cpu) });
        try {
          const result = original.apply(this, args);
          if (result && typeof result.then === 'function') return result.finally(finish);
          finish(); return result;
        } catch (error) { finish(); throw error; }
      };
    }
    const Module = require('node:module'), load = Module._load;
    Module._load = function (request, parent, isMain) {
      const exports = load.apply(this, arguments);
      if (!exports || (typeof exports !== 'object' && typeof exports !== 'function') || patched.has(exports)) return exports;
      // Only decorate the configured CodeGraph build, never another dependency.
      const build = process.env.CODEGRAPH_PROFILE_BUILD;
      if (!build || !parent?.filename?.startsWith(path.resolve(build) + path.sep)) return exports;
      patched.add(exports);
      const q = exports.QueryBuilder?.prototype;
      if (q) for (const name of ['getUnresolvedReferencesBatchAfter','insertEdges','deleteReferencesByRowIds',
        'deleteSpecificResolvedReferences','markReferencesFailedByRowIds','markReferencesFailed']) wrap(q,name,`query.${name}`);
      const r = exports.ReferenceResolver?.prototype;
      if (r) for (const name of ['resolveAll','createEdges','resolveAndPersistBatched','warmCaches']) wrap(r,name,`resolver.${name}`);
      const rp = exports.ResolverPool?.prototype;
      if (rp) wrap(rp,'resolveBatch','pool.resolveBatch',function(){resolverPools.add(this);});
      const pp = exports.ParseWorkerPool?.prototype;
      if (pp) {
        wrap(pp,'requestParse','parse.request',function(args){parsePools.add(this);requests.set(args[0],clock());});
        const dispatch=pp.dispatch;
        pp.dispatch=function(worker,job){const at=requests.get(job.task);if(at!==undefined)events.push({name:'parse.queue',start:at,end:clock()});return dispatch.call(this,worker,job);};
      }
      const sw=exports.StoreWriter?.prototype;
      if(sw)for(const name of ['send','waitBelow','drain'])wrap(sw,name,`store.${name}`,function(){writers.add(this);});
      const db=exports.DatabaseConnection?.prototype;
      if(db)for(const name of ['endBulkParseLoad','endBulkNodeLoad','beginBulkResolutionEdgeLoad',
        'endBulkResolutionEdgeLoad','beginBulkResolutionRefLoad','endBulkResolutionRefLoad','runMaintenance'])wrap(db,name,`db.${name}`);
      const extraction=exports.ExtractionOrchestrator?.prototype;
      if(extraction)for(const name of ['indexAll','buildFreshStoreBundle'])wrap(extraction,name,`extraction.${name}`);
      if(typeof exports.orderedParallelMap==='function'){
        const original=exports.orderedParallelMap;
        exports.orderedParallelMap=async function*(inputs,map,options){
          const state={active:true,running:0,completed:0,admitted:0,awaitingHead:false,consumer:false,maxPending:options.maxPending,maxBuffered:options.maxBuffered??options.maxPending,maxBytes:options.maxEstimatedBytes};pipelines.add(state);
          const iterator=original(inputs,async input=>{state.running++;try{const result=await map(input);state.completed++;return result;}finally{state.running--;}},options);
          try{while(true){
            const at=clock();state.awaitingHead=true;
            let next;try{next=await iterator.next();}finally{state.awaitingHead=false;events.push({name:'pipeline.next',start:at,end:clock()});}
            if(next.done)return;state.completed--;state.admitted++;state.consumer=true;
            try{yield next.value;}finally{state.consumer=false;}
          }}finally{state.active=false;await iterator.return?.();}
        };
      }
      return exports;
    };
    const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())gc.push({at:clock(),durationMs:entry.duration,kind:entry.detail?.kind});});
    observer.observe({entryTypes:['gc']});
    let previousAt=start,previousCpu=process.cpuUsage(),previousThread=threadCpu();
    const hostBusy=()=>os.cpus().reduce((sum,c)=>sum+c.times.user+c.times.nice+c.times.sys+c.times.irq,0);
    let previousHost=hostBusy();
    const timer=setInterval(()=>{
      const at=clock(),cpu=process.cpuUsage(),thread=threadCpu(),host=hostBusy(),ms=at-previousAt;
      samples.push({at,intervalMs:ms,processCores:(cpu.user+cpu.system-previousCpu.user-previousCpu.system)/1000/ms,
        mainCores:thread&&previousThread?(thread.user+thread.system-previousThread.user-previousThread.system)/1000/ms:null,
        hostCores:(host-previousHost)/ms,memory:process.memoryUsage(),
        parse:[...parsePools].filter(p=>!p.destroyed).map(p=>({size:p.maxSize,queue:p.queue.length,inflight:p.inflight.size,idle:p.idle.length,starting:p.pending.size})),
        pipeline:[...pipelines].filter(p=>p.active).map(p=>({...p})),
        resolve:[...resolverPools].filter(p=>!p.destroying).map(p=>({workers:p.workers.map(w=>w.busy),waiting:p.waiters.size})),
        writer:[...writers].filter(w=>!w.exited).map(w=>({outstanding:w.outstanding,bytes:w.outstandingBytes,waiters:w.belowWaiters.length}))});
      previousAt=at;previousCpu=cpu;previousThread=thread;previousHost=host;
    },1000);timer.unref();
    process.once('exit',()=>{
      clearInterval(timer);observer.disconnect();
      fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});
      fs.writeFileSync(output,JSON.stringify({version:1,node:process.version,pid:process.pid,cpus:os.availableParallelism(),startedAt,start,end:clock(),
        note:'Times are monotonic milliseconds; cpuMs is current-thread CPU. Nested/async spans overlap and must not be summed. Sent-to-start includes transfer/deserialization and queue wait.',
        events,tasks,workers,samples,gc}));
    });
  }
}
