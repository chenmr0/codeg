// Small bounded smoke probe; run only after npm run build.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os=require('node:os'); const path=require('node:path');
const {CodeGraph}=require('../dist');
(async()=>{
 process.env.CODEGRAPH_FIELD_REFERENCES='0'; process.env.CODEGRAPH_ALL_LANGUAGES='0';
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'field-policy-probe-'));
 fs.writeFileSync(path.join(root,'types.hpp'),'struct S { int member; int read(); };\n');
 fs.writeFileSync(path.join(root,'use.cpp'),'#include "types.hpp"\nint S::read() { return !!member; }\n');
 let graph;
 try {
  console.log('init'); graph=await CodeGraph.init(root); console.log('index');
  const result=await graph.indexAll(); assert.equal(result.complete,true);
  const db=graph.db.getDb();
  const counts=()=>({refs:db.prepare("SELECT COUNT(*) n FROM edges e JOIN nodes t ON t.id=e.target WHERE e.kind='references' AND t.kind='field'").get().n,suppressed:db.prepare("SELECT COUNT(*) n FROM unresolved_refs WHERE status='suppressed_field'").get().n});
  console.log('ordinary',counts()); assert.equal(counts().refs,0); assert.ok(counts().suppressed>0);
  fs.writeFileSync(path.join(root,'types.hpp'),'struct S { int (*member)(int); int read(); };\n');
  console.log('sync-callback'); await graph.sync(); console.log('callback',counts()); assert.ok(counts().refs>0);
  fs.writeFileSync(path.join(root,'types.hpp'),'struct S { int member; int read(); };\n');
  console.log('sync-data'); await graph.sync(); assert.equal(counts().refs,0);
  process.env.CODEGRAPH_FIELD_REFERENCES='1'; console.log('enable'); await graph.sync(); assert.ok(counts().refs>0);
  console.log('PASS',counts());
 } finally {graph?.close(); fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
