const fs=require('fs'),path=require('path'),crypto=require('crypto');
const arm=process.argv[2],cfgPath=path.resolve(process.argv[3]||'config.json'),cfg=JSON.parse(fs.readFileSync(cfgPath)),resolve=p=>path.resolve(path.dirname(cfgPath),p),root=resolve(cfg.outputDir);fs.mkdirSync(root,{recursive:true});if(!['baseline','final','community'].includes(arm))throw Error('arm must be baseline, final or community');
const frozen = JSON.parse(fs.readFileSync(path.join(__dirname,'FREEZE.json')));
const input = fs.readFileSync(path.join(__dirname,'queries-gold.json'));
if (crypto.createHash('sha256').update(input).digest('hex') !== frozen.sha256) throw Error('bundle gold changed');
if (!fs.existsSync(path.join(root,'queries-gold.json')) || !fs.readFileSync(path.join(root,'queries-gold.json')).equals(input)) throw Error('output directory must contain identical frozen gold');
if (fs.existsSync(path.join(root,arm+'.jsonl')) || fs.existsSync(path.join(root,'outputs',arm))) throw Error('arm already exists; choose a new output directory');
Object.assign(process.env,{CODEGRAPH_ALL_LANGUAGES:'1',CODEGRAPH_NO_DAEMON:'1',CODEGRAPH_ENABLE_EXPLORE:'1'});
const runtime=resolve(cfg.runtimes[arm]);
const CG=require(path.join(runtime,'dist/index.js')).default;
const ToolHandler=require(path.join(runtime,'dist/mcp/tools.js')).ToolHandler;
(async()=>{const db=resolve(arm==='community'?cfg.communityProject:cfg.forkProject);const cg=(CG.openReadOnlySync??CG.openSync).call(CG,db);const qs=JSON.parse(fs.readFileSync(path.join(__dirname,'queries-gold.json')));fs.mkdirSync(path.join(root,'outputs',arm),{recursive:true});
for(const q of qs){const h=new ToolHandler(cg),t=performance.now();try{const r=await h.execute(arm==='community'?'codegraph_explore':'explore',{query:q.query,maxFiles:12});const text=(r.content||[]).map(c=>c.text||'').join('\n');const row={arm,id:q.id,ms:performance.now()-t,chars:text.length,isError:!!r.isError,sha256:crypto.createHash('sha256').update(text).digest('hex')};fs.writeFileSync(path.join(root,'outputs',arm,q.id+'.txt'),text);fs.appendFileSync(path.join(root,arm+'.jsonl'),JSON.stringify(row)+'\n');console.error(JSON.stringify(row));}catch(e){fs.appendFileSync(path.join(root,arm+'.jsonl'),JSON.stringify({arm,id:q.id,error:String(e),ms:performance.now()-t})+'\n');}}
if(cg.close)await cg.close();else if(cg.destroy)await cg.destroy();})().catch(e=>{console.error(e);process.exitCode=1});
