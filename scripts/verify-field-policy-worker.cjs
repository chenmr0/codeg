const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CodeGraph}=require('../dist');const {ResolverPool}=require('../dist/resolution/resolver-pool');const {ToolHandler}=require('../dist/mcp/tools');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'field-worker-'));
const source='int helper(){return 1;}\nstruct S { int value; int (*callback)(int); int read(); };\nint S::read(){int sum=0;\n'+Array.from({length:2400},()=> 'sum += value;').join('\n')+'\nreturn sum;}\nint caller(){return helper();}\n';
(async()=>{
 process.env.CODEGRAPH_ALL_LANGUAGES='0';process.env.CODEGRAPH_RESOLVE_WORKERS='1';process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN='1';
 const results=[];
 for(const enabled of ['0','1']){
  process.env.CODEGRAPH_FIELD_REFERENCES=enabled;
  const dir=path.join(root,enabled);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'a.cpp'),source);
  const g=await CodeGraph.init(dir);let pool;const original=ResolverPool.tryCreate;
  try{
   await g.indexFiles(['a.cpp']);
   const refs=g.queries.getUnresolvedReferencesCount();assert.ok(refs>2000,`only ${refs} refs`);
   pool=ResolverPool.tryCreate(path.join(dir,'.codegraph-wx','codegraph.db'),dir);assert.ok(pool);await pool.ready();
   let workerBatches=0;const batch=pool.resolveBatch.bind(pool);pool.resolveBatch=async refs=>{workerBatches++;return batch(refs)};
   ResolverPool.tryCreate=()=>pool;
   await g.resolver.resolveAndPersistBatched(undefined,1000,{dbPath:path.join(dir,'.codegraph-wx','codegraph.db')});
   const d=g.db.getDb();const fieldRefs=d.prepare("SELECT count(*) n FROM edges e JOIN nodes t ON t.id=e.target WHERE e.kind='references' AND t.kind='field'").get().n;
   assert.ok(workerBatches>0);assert.equal(fieldRefs,enabled==='0'?0:2400);
   assert.equal(d.prepare("SELECT count(*) n FROM unresolved_refs WHERE status='pending'").get().n,0);
   const helper=g.getNodesByName('helper').find(n=>n.kind==='function');
   const output=JSON.stringify(await new ToolHandler(g).execute('callers',{symbol:'helper',signature:helper.signature}));assert.ok(output.includes('- caller (function)'),output);
   results.push({enabled,workerBatches,fieldRefs,callersPreserved:true,pending:0});
  } finally {ResolverPool.tryCreate=original;await pool?.destroy();g.close();}
 }
 console.log(JSON.stringify(results,null,2));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
