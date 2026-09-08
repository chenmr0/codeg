// Synthetic benchmark only: creates/removes its OWN temporary database/files.
// Compare the loop-append-only fix (legacy) against bounded resolution (paged).
// Usage: node scripts/benchmark-scoped-references.cjs [refs=200000] [rounds=3] [files=200] [paged|legacy|batches] [new-report.json]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const positive = (value, fallback) => {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Expected a positive integer');
  return number;
};

async function child(mode, count, fileCount, batchSize) {
  const queryModule = require('../dist/db/queries.js');
  const productionBatchSize = queryModule.SCOPED_REFERENCE_BATCH_SIZE;
  batchSize ??= productionBatchSize;
  if (![5000,10000,20000].includes(batchSize)) throw new Error('Unsupported benchmark batch size');
  // Experiment confined to THIS child process: increase the exported guard
  // and pass the requested size explicitly. No source/dist files are edited,
  // no reader/resolver algorithm is replaced, no product default is changed.
  queryModule.SCOPED_REFERENCE_BATCH_SIZE = Math.max(productionBatchSize,batchSize);
  const CodeGraph = require('../dist/index.js').default;
  const { ResolutionDiagnostics } = require('../dist/resolution/diagnostics.js');
  const { syncNameLookupMode } = require('../dist/resolution/name-lookup.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scoped-bench-'));
  let cg;
  try {
    cg = CodeGraph.initSync(root);
    const db = cg.db.db, queries = cg.queries, resolver = cg.resolver;
    const files = Array.from({length:fileCount}, (_,i) => `unit${String(i).padStart(6,'0')}.c`);
    for (const [i, file] of files.entries()) {
      const source = `int caller_${i}(void) { return target(); }\n`;
      fs.writeFileSync(path.join(root,file),source);
      queries.insertNodes([{ id:`caller_${i}`,name:`caller_${i}`,qualifiedName:`caller_${i}`,
        kind:'function',language:'c',filePath:file,startLine:1,endLine:1,startColumn:0,endColumn:source.length,updatedAt:1 }]);
      queries.upsertFile({path:file,contentHash:'fixture',language:'c',size:source.length,modifiedAt:1,indexedAt:1,nodeCount:1});
    }
    queries.insertNodes([{id:'target',name:'target',qualifiedName:'target',kind:'function',language:'c',
      filePath:files[0],startLine:2,endLine:2,startColumn:0,endColumn:30,updatedAt:1}]);
    const insert = db.prepare(`INSERT INTO unresolved_refs(from_node_id,reference_name,reference_kind,line,col,
      file_path,language,status,name_tail) VALUES (?,?,'calls',?,0,?,'c','pending','')`);
    let resolvedExpected = 0;
    db.transaction(() => {
      let written = 0;
      for (let f = 0; f < fileCount; f++) {
        const perFile = Math.floor(count/fileCount) + (f < count % fileCount ? 1 : 0);
        for (let i = 0; i < perFile; i++) {
          const name = written++ % 4 === 0 ? 'target' : 'missing_target';
          if (name === 'target') resolvedExpected++;
          insert.run(`caller_${f}`,name,i+3,files[f]);
        }
      }
    })();
    resolver.clearCaches();
    global.gc?.();
    const rssBeforeMiB = process.memoryUsage().rss / 1048576;
    let heapPeakMiB = process.memoryUsage().heapUsed / 1048576;
    const sample = () => { heapPeakMiB = Math.max(heapPeakMiB,process.memoryUsage().heapUsed / 1048576); };
    // Sample allocation boundaries too: a legacy synchronous call blocks timers.
    for (const method of ['resolveAll','createEdges']) {
      const original = resolver[method].bind(resolver);
      resolver[method] = (...args) => { sample(); const result = original(...args); sample(); return result; };
    }
    const detail = new ResolutionDiagnostics(); detail.files = files.length;
    const started = performance.now();
    if (mode === 'legacy') {
      const refs = detail.measure('loadRefsMs',() => queries.getUnresolvedReferencesByFiles(files));
      sample(); resolver.resolveAndPersist(refs,undefined,detail,syncNameLookupMode(count)); sample();
    } else {
      const consumed = await resolver.resolveFilesAndPersist(files,undefined,{diagnostics:detail,nameLookup:'sync',batchSize});
      if (consumed !== count) throw new Error('Count mismatch');
      if (detail.maxBatchRefs > batchSize) throw new Error('Batch limit exceeded');
      sample();
    }
    const resolutionMs = performance.now() - started;
    // Includes fixture preparation too; report that fact rather than claiming
    // an isolated resolver RSS peak. Preparation is identical in both modes.
    const processPeakRssMiB = process.resourceUsage().maxRSS / 1024;
    const pending = queries.getUnresolvedReferencesCount();
    const failed = db.prepare("SELECT COUNT(*) n FROM unresolved_refs WHERE status='failed'").get().n;
    const edges = db.prepare("SELECT COUNT(*) n FROM edges WHERE kind='calls'").get().n;
    if (pending !== 0 || failed !== count-resolvedExpected || edges !== resolvedExpected) throw new Error('Graph count mismatch');
    const hash = crypto.createHash('sha256');
    for (const row of db.prepare('SELECT source,target,kind,line,col,metadata FROM edges ORDER BY source,target,kind,line,col,metadata').iterate()) {
      hash.update(JSON.stringify(row)); hash.update('\n');
    }
    for (const row of db.prepare('SELECT from_node_id,reference_name,reference_kind,line,col,status,name_tail FROM unresolved_refs ORDER BY from_node_id,reference_name,reference_kind,line,col').iterate()) {
      hash.update(JSON.stringify(row)); hash.update('\n');
    }
    console.log(JSON.stringify({mode,batchSize:mode==='paged'?batchSize:null,productionBatchSize,
      node:process.version,platform:process.platform,arch:process.arch,
      refs:count,files:fileCount,resolutionMs,rssBeforeMiB,processPeakRssMiB,
      sampledHeapPeakMiB:heapPeakMiB,batches:detail.batches,maxBatchRefs:detail.maxBatchRefs,
      timings:detail.timings,pending,failed,edges,hash:hash.digest('hex')}));
  } finally {
    cg?.close();
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved)!==fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('cg-scoped-bench-')) throw new Error('Unsafe cleanup');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}

async function main() {
  if (process.argv[2] === '--child') {
    const mode = process.argv[3];
    if (!['legacy','paged'].includes(mode)) throw new Error('Unknown mode');
    await child(mode,positive(process.argv[4]),positive(process.argv[5]),
      process.argv[6] === undefined ? undefined : positive(process.argv[6])); return;
  }
  const count = positive(process.argv[2],200000), rounds = positive(process.argv[3],3), files = positive(process.argv[4],200);
  const only = process.argv[5];
  if (only && !['legacy','paged','batches'].includes(only)) throw new Error('Unknown mode');
  const reportPath = process.argv[6];
  if (reportPath && fs.existsSync(reportPath)) throw new Error('Report already exists; choose a new filename');
  const sizes = [5000,10000,20000];
  const defaultSize = require('../dist/db/queries.js').SCOPED_REFERENCE_BATCH_SIZE;
  let expected;
  const results = [];
  for (let round=1; round<=rounds; round++) {
    // Rotate the first size so each size occupies each position once in three
    // rounds. All runs use a fresh process and freshly seeded identical data.
    const settings = only === 'batches'
      ? sizes.map((_,i)=>({mode:'paged',batchSize:sizes[(i+round-1)%sizes.length]}))
      : (only ? [only] : round%2 ? ['legacy','paged'] : ['paged','legacy']).map(mode=>({mode,batchSize:defaultSize}));
    for (const {mode,batchSize} of settings) {
      const raw = execFileSync(process.execPath,['--expose-gc',__filename,'--child',mode,String(count),String(files),String(batchSize)],
        {encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
      const result = JSON.parse(raw.trim());
      expected ??= result.hash;
      if (result.hash !== expected) throw new Error('Graph parity mismatch');
      results.push({...result,round}); console.log(JSON.stringify({...result,round}));
    }
  }
  const medians = {};
  for (const key of only==='batches' ? sizes.map(String) : ['legacy','paged']) {
    const rows = results.filter(r=>only==='batches' ? String(r.batchSize)===key : r.mode===key);
    if (!rows.length) continue;
    medians[key] = {};
    for (const field of ['resolutionMs','processPeakRssMiB','sampledHeapPeakMiB']) {
      const ordered = rows.map(r=>r[field]).sort((a,b)=>a-b);
      const middle = Math.floor(ordered.length/2);
      medians[key][field] = ordered.length%2 ? ordered[middle] : (ordered[middle-1]+ordered[middle])/2;
    }
  }
  const summary = {summary:true,rounds,refs:count,files,batchSizeComparison:only==='batches',
    parity:only && only!=='batches' ? 'not-compared' : true,hash:expected,medians,
    note:'Synthetic Windows/Linux benchmark; timing excludes fixture setup and verification, process peak RSS includes setup. legacy is loop-append-only, not the crashing original.'};
  console.log(JSON.stringify(summary));
  if (reportPath) fs.writeFileSync(reportPath,JSON.stringify({summary,results},null,2)+'\n',{flag:'wx'});
}
main().catch(error=>{console.error(error);process.exitCode=1;});
