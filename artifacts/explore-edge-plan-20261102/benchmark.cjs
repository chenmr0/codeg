// Serial read-only benchmark. Usage: node --liftoff-only benchmark.cjs EXPERIMENT_ROOT before|after OUTPUT
const fs=require('fs'),path=require('path'),{performance}=require('perf_hooks'),{createHash}=require('crypto');
const base=path.resolve(process.argv[2]),arm=process.argv[3],out=process.argv[4],runtime=path.join(base,'native-runtime/dist');
process.env.CODEGRAPH_ALLOW_UNSAFE_NODE='1';process.env.CODEGRAPH_ALL_LANGUAGES='1';process.env.CODEGRAPH_NO_DAEMON='1';process.env.CODEGRAPH_ENABLE_EXPLORE='1';delete process.env.CODEGRAPH_MCP_TOOLS;
if(arm==='after')require(path.join(runtime,'upstream-explore/db/queries')).QueryBuilder.prototype.findEdgesBetweenNodes=require('../../dist/upstream-explore/db/queries').QueryBuilder.prototype.findEdgesBetweenNodes;
const CG=require(path.join(runtime,'index')).default;
(async()=>{
const cg=CG.openSync(path.join(base,'oceanbase'));const handler=new(require(path.join(runtime,'mcp/tools')).ToolHandler)(cg);
const db=cg.getExploreQueryConnection();const pragma=Object.fromEntries(['cache_size','mmap_size','temp_store','query_only','journal_mode'].map(k=>[k,db.pragma(k)]));
const queries=JSON.parse(fs.readFileSync(path.resolve(base,'../explore-candidate/artifacts/codegraph-explore-upstream-parity-20261024/queries-all-final.json')));
queries.push({id:'ttl-flow-current',query:'ObTableTTLDeleteTask process process_one execute_ttl_delete',maxFiles:12},{id:'dtl-current-range',query:'src/sql/dtl/ob_dtl_basic_channel.cpp:895-965',maxFiles:12});
const results=[];
for(let pass=0;pass<3;pass++)for(const q of queries){const start=performance.now();const r=await handler.execute('explore',{query:q.query,maxFiles:q.maxFiles});const ms=performance.now()-start;const text=r.content.map(c=>c.text||'').join('\n');const row={pass,id:q.id,ms,isError:r.isError||false,chars:text.length,sha:createHash('sha256').update(text).digest('hex')};results.push(row);console.error(JSON.stringify({arm,...row}));}
fs.writeFileSync(out,JSON.stringify({arm,pragma,results},null,2));cg.close();
})().catch(e=>{console.error(e);process.exitCode=1});
