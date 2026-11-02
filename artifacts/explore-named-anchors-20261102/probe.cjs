// Read-only production ToolHandler probe; pass a fully indexed project path.
const fs = require('node:fs'), path = require('node:path'), {performance} = require('node:perf_hooks');
process.env.CODEGRAPH_ENABLE_EXPLORE='1'; process.env.CODEGRAPH_NO_DAEMON='1'; process.env.CODEGRAPH_ALLOW_UNSAFE_NODE='1';
const runtime=process.env.RUNTIME ? path.resolve(process.env.RUNTIME) : path.resolve(__dirname,'../../dist');
const CG=require(runtime).default, {ToolHandler}=require(path.join(runtime,'mcp/tools'));
const root=path.resolve(process.argv[2]);
const cg=CG.openReadOnlySync(root);
const handler=new ToolHandler(cg);
(async()=>{
  const db=cg.getExploreQueryConnection(); let readOnly=false;
  try{db.prepare('UPDATE nodes SET name=name WHERE 0').run()}catch(e){readOnly=/readonly|read.only/i.test(String(e));}
  if(!readOnly)throw Error('Main DB is not verified read-only');
  const query='ObDtlBasicChannel ObDtlFlowControl ObPxTransmitOp DTL_BLOCKING_TIME';
  const out=[];
  for(let pass=0;pass<Number(process.env.PASSES||3);pass++){
    const t=performance.now();const r=await handler.execute('explore',{query,maxFiles:12});
    const text=r.content.map(c=>c.text||'').join('\n');
    if(r.isError)throw Error(text);
    out.push({pass,ms:performance.now()-t,isError:!!r.isError,chars:text.length,text});
    console.error(JSON.stringify({...out.at(-1),text:undefined}));
  }
  fs.writeFileSync(path.join(__dirname,process.env.OUTPUT || 'oceanbase-dtl.json'),JSON.stringify({root,readOnly,query,out},null,2));
  handler.closeAll();cg.close();
})().catch(e=>{console.error(e);process.exitCode=1});
