// Usage: node --liftoff-only scripts/verify-field-policy-upgrade.cjs <real-v36-package-directory>
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {CodeGraph}=require('../dist');
const baseline=path.resolve(process.argv[2]||'');
if(!fs.existsSync(path.join(baseline,'dist/extraction/extraction-version.js')))throw Error('Supply a real v36 package');
assert.equal(require(path.join(baseline,'dist/extraction/extraction-version.js')).EXTRACTION_VERSION,36);
const source='struct S { int value; int (*callback)(int); int read(){return value;} auto get(){return callback;} };\nint helper(){return 1;} int caller(){return helper();}\n';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'field-upgrade-'));
const summary=[];
function data(g){const d=g.db.getDb();return {nodes:d.prepare('SELECT id,kind,name,qualified_name,ordinary_field FROM nodes ORDER BY id').all(),edges:d.prepare('SELECT source,target,kind,line,col FROM edges ORDER BY source,target,kind,line,col').all(),pending:d.prepare("SELECT count(*) n FROM unresolved_refs WHERE status='pending'").get().n};}
(async()=>{
 process.env.CODEGRAPH_FIELD_REFERENCES='0';process.env.CODEGRAPH_ALL_LANGUAGES='0';
 for(const method of ['indexAll','sync']){
  const live=path.join(root,method),freshDir=path.join(root,method+'-fresh');fs.mkdirSync(live);fs.mkdirSync(freshDir);
  fs.writeFileSync(path.join(live,'a.cpp'),source);fs.writeFileSync(path.join(freshDir,'a.cpp'),source);
  const old=cp.spawnSync(process.execPath,['--liftoff-only','-e',`(async()=>{const {CodeGraph}=require(${JSON.stringify(path.join(baseline,'dist'))});const g=await CodeGraph.init(${JSON.stringify(live)});try{const r=await g.indexAll();if(!r.complete)throw Error('incomplete baseline');console.log(JSON.stringify({version:g.getIndexBuildInfo().extractionVersion,refs:g.db.getDb().prepare("SELECT count(*) n FROM edges e JOIN nodes t ON t.id=e.target WHERE e.kind='references' AND t.kind='field' AND t.name='value'").get().n}));}finally{g.close()}})().catch(e=>{console.error(e);process.exitCode=1})`],{encoding:'utf8',env:process.env,timeout:60000});
  assert.equal(old.status,0,old.stderr);const before=JSON.parse(old.stdout.trim().split('\n').at(-1));assert.equal(before.version,36);assert.ok(before.refs>0);
  const upgraded=await CodeGraph.open(live),fresh=await CodeGraph.init(freshDir);
  try{await upgraded[method]();await fresh.indexAll();assert.deepEqual(data(upgraded),data(fresh));assert.equal(upgraded.getIndexBuildInfo().extractionVersion,37);assert.equal(upgraded.isIndexStale(),false);summary.push({method,before,afterVersion:37,freshEqual:true,pending:data(upgraded).pending});}
  finally{upgraded.close();fresh.close();}
 }
 console.log(JSON.stringify({baseline,checks:summary},null,2));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
