// Existing same-ID INSERT OR REPLACE integrity defect; NOT a passing equivalence test.
const {DatabaseConnection,QueryBuilder}=require('../../dist');
const {ensureSqlJsReady}=require('../../dist/db/sqlite-adapter');
const fs=require('fs'),os=require('os'),path=require('path');
(async()=>{
 await ensureSqlJsReady();
 for(const backend of ['native','wasm']) {
  process.env.CODEGRAPH_FORCE_WASM=backend==='wasm'?'1':'';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cg-replace-fts-'));
  const c=DatabaseConnection.initialize(path.join(dir,'graph.db')),db=c.getDb(),q=new QueryBuilder(db);
  const n=(id,name)=>({id,name,qualifiedName:name,kind:'class',language:'cpp',filePath:'a.cpp',startLine:1,endLine:1,startColumn:0,endColumn:1,updatedAt:1});
  q.insertNode(n('same','OldAlpha'));q.insertNode(n('same','NewBeta'));q.insertNode(n('valid','OldAlphaLive'));
  const prepare=db.prepare.bind(db),result={backend};
  for(const mode of ['new','old']){
   db.prepare=sql=>prepare(mode==='old'?sql.replace('JOIN nodes ON nodes_fts.rowid = nodes.rowid AND nodes.id IS NOT NULL','JOIN nodes ON nodes_fts.id = nodes.id'):sql);
   result[mode]=q.searchNodes('OldAlpha NewBeta').map(r=>({name:r.node.name,score:r.score}));
  }
  try{db.exec("INSERT INTO nodes_fts(nodes_fts,rank) VALUES('integrity-check',1)");result.integrity='OK'}catch(e){result.integrity=e.message}
  console.log(JSON.stringify(result));c.close();fs.rmSync(dir,{recursive:true,force:true});
 }
})();
