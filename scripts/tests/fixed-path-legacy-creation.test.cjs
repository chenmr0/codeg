const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {DatabaseConnection}=require('../../dist');
const adapter=require('../../dist/db/sqlite-adapter');
for(const wasm of [false,true])test(`legacy ${wasm?'WASM':'native'} root creation excludes fixed initialization until root is materialized`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-legacy-create-')),dataDir=path.join(root,'.codegraph-wx'),file=path.join(dataDir,'codegraph.db');
  const original=adapter.createDatabase,previous=process.env.CODEGRAPH_FORCE_WASM;let db,observed=false;
  try{
    if(wasm){await adapter.ensureSqlJsReady();process.env.CODEGRAPH_FORCE_WASM='1';}else delete process.env.CODEGRAPH_FORCE_WASM;
    adapter.createDatabase=function(target,options){
      if(target===file){
        observed=true;assert(!fs.existsSync(file));
        const child=spawnSync(process.execPath,['--liftoff-only','-e',`const {CodeGraph}=require(${JSON.stringify(path.resolve('dist'))});try{CodeGraph.initSync(${JSON.stringify(root)});process.exit(9)}catch(e){if(!/locked|busy/i.test(String(e)))throw e;}`],{env:{...process.env,CODEGRAPH_FIXED_PATH:'1',CODEGRAPH_FORCE_WASM:''},encoding:'utf8',timeout:10000});
        assert.equal(child.status,0,child.stdout+child.stderr);
      }
      return original(target,options);
    };
    db=DatabaseConnection.initialize(file);assert(observed);assert(fs.existsSync(file));
    assert.equal(db.getBackend(),wasm?'sql-js':'node-sqlite');assert(!fs.existsSync(path.join(dataDir,'.runtime/layout.json')));
    db.close();db=undefined;adapter.createDatabase=original;
    delete process.env.CODEGRAPH_FORCE_WASM;const reopened=DatabaseConnection.openReadOnly(file);reopened.close();
  }finally{adapter.createDatabase=original;db?.close();if(previous===undefined)delete process.env.CODEGRAPH_FORCE_WASM;else process.env.CODEGRAPH_FORCE_WASM=previous;fs.rmSync(root,{recursive:true,force:true});}
});

 test('dangling filename alias cannot create an unadmitted fixed root',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-dangling-create-')),dataDir=path.join(root,'.codegraph-wx'),active=path.join(dataDir,'codegraph.db'),alias=path.join(root,'alias.sqlite');
  try {fs.mkdirSync(dataDir);fs.symlinkSync(active,alias,'file');assert.throws(()=>DatabaseConnection.initialize(alias),/Dangling database symlink/);assert(!fs.existsSync(active));}
  finally {fs.rmSync(root,{recursive:true,force:true});}
 });

test('public offline migration cannot bypass a live initializer after its legacy token is released',async()=>{
  const {CodeGraph}=require('../../dist'),{initializeFixedPathStorage}=require('../../dist/sync/fixed-path-initialization');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-init-migrate-')),dataDir=path.join(root,'.codegraph-wx'),original=fs.unlinkSync;
  let pending,intercepted=false;
  try{
    fs.unlinkSync=function(file){const result=original.apply(this,arguments);if(!intercepted&&String(file)===path.join(dataDir,'codegraph.lock')){
      intercepted=true;pending=CodeGraph.migrateStorage(root,{offline:true}).then(()=>null,error=>error);
      assert(!fs.existsSync(path.join(dataDir,'.runtime/layout.json')),'public migration must not commit behind the live initialization owner');
    }return result;};
    initializeFixedPathStorage(dataDir,file=>{const db=DatabaseConnection.initialize(file);db.close();});
    assert(intercepted);assert.match(String(await pending),/locked|busy/i);
    const graph=CodeGraph.openSync(root);graph.close();
  }finally{fs.unlinkSync=original;fs.rmSync(root,{recursive:true,force:true});}
});
