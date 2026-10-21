// Fixed-query regression against isolated artifacts; never starts a model.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'artifacts/oceanbase-explore-p0-20261021');
const protocol=JSON.parse(fs.readFileSync(path.join(out,'protocol.json'),'utf8'));
const arm=process.argv[2],mode=process.argv[3]||'final';
const stage=process.argv[4];
if(stage && !['final','verified'].includes(stage))throw Error('Invalid stage');
if(!['ours','community'].includes(arm)||!['runtime-only','rebuild','final'].includes(mode))throw Error('Invalid mode');
const pkg=stage&&arm==='ours'?path.join(out,`candidate-${stage}`):protocol[`${arm}_package`];
const repo=path.join(out,'repos',arm),dest=path.join(out,stage?`${stage}-results`:mode==='runtime-only'?'runtime-only':'results');
fs.mkdirSync(dest,{recursive:true});
const {CodeGraph}=require(path.join(pkg,'dist/index.js'));
const {ToolHandler}=require(path.join(pkg,'dist/mcp/tools.js'));
process.env.CODEGRAPH_ENABLE_EXPLORE='1';
const dump=(name,data)=>fs.writeFileSync(path.join(dest,name),JSON.stringify(data,null,2)+'\n');
async function replay(cg){
 const db=cg.db.getDb(),summary=[];
 const rows=db.prepare("SELECT * FROM nodes WHERE name IN ('need_block','can_unblock','wait_unblocking','ObDtlFlowControl') AND file_path LIKE 'src/sql/dtl/%'").all();
 const edges={};for(const n of rows)edges[n.id]={incoming:cg.getIncomingEdges(n.id),outgoing:cg.getOutgoingEdges(n.id)};
 dump(`${arm}-index-symbols.json`,{rows,edges});
 for(const q of protocol.queries){
  const args={query:q.query,maxFiles:q.maxFiles};
  const traversals=[],gathers=[];const original=cg.traverser.traverseBFS,originalGather=cg.findRelevantContext;
  cg.traverser.traverseBFS=function(id,opts){const result=original.call(this,id,opts);traversals.push({id,options:opts,nodes:result.nodes.size,edges:result.edges.length});return result;};
  cg.findRelevantContext=async function(query,opts){const result=await originalGather.call(this,query,opts);gathers.push(JSON.parse(JSON.stringify({query,options:opts,roots:result.roots,nodes:[...result.nodes.values()],edges:result.edges})));return result;};
  const started=performance.now();
  let response;try{response=await new ToolHandler(cg).execute(arm==='ours'?'explore':'codegraph_explore',args);}finally{cg.traverser.traverseBFS=original;cg.findRelevantContext=originalGather;}
  const text=response.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  if(response.isError)throw Error(text);
  fs.writeFileSync(path.join(dest,`${arm}-${q.label}.txt`),text);
  dump(`${arm}-${q.label}.traversals.json`,traversals);
  dump(`${arm}-${q.label}.gathers.json`,gathers);
  const record={label:q.label,args,chars:text.length,sha256:crypto.createHash('sha256').update(text).digest('hex'),milliseconds:performance.now()-started};
  summary.push(record);console.log(JSON.stringify({arm,mode,...record}));
 }
 dump(`${arm}-summary.json`,{arm,mode,stage,package:pkg,modelCalls:0,probes:summary});
}
async function main(){
 let cg;
 if(mode==='rebuild'){
  if(arm!=='ours')throw Error('Only ours rebuilds');
  const dbdir=path.join(repo,'.codegraph-wx');
  const old=path.join(dbdir,'codegraph.db'),backup=path.join(out,'pre-p0-index.db');
  if(fs.existsSync(backup))throw Error('Refusing to repeat rebuild');
  // Both literal paths are under this new regression directory. Previous
  // experiment directories and their databases are never moved or written.
  fs.renameSync(old,backup);
  for(const suffix of ['-wal','-shm'])if(fs.existsSync(old+suffix))throw Error('Unexpected live database sidecar');
  cg=CodeGraph.initSync(repo);
  try{
   let last=0;
   const result=await cg.indexAll({onProgress:p=>{if(Date.now()-last>10000){console.log(JSON.stringify(p));last=Date.now();}}});
   fs.writeFileSync(path.join(out,'rebuild.json'),JSON.stringify(result,null,2));
   console.log(JSON.stringify({indexSuccess:result.success,files:result.filesIndexed,errors:result.filesErrored,durationMs:result.durationMs}));
   if(!result.success)throw Error('Full rebuild failed; inspect rebuild.json');
   await replay(cg);
  }finally{cg.close();}
 }else{
  cg=CodeGraph.openSync(repo);try{await replay(cg);}finally{cg.close();}
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
