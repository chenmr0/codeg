// Usage: node --liftoff-only sql-benchmark.cjs EXPERIMENT_ROOT OUTPUT
const fs=require('fs'),path=require('path'),{DatabaseSync}=require('node:sqlite'),{performance}=require('perf_hooks'),{createHash}=require('crypto');
const {subgraphEdgeSql}=require('../../dist/upstream-explore/db/subgraph-edge-plan');
const base=path.resolve(process.argv[2]),plans=JSON.parse(fs.readFileSync(path.join(base,'full/query-plans.json'))),out={};
const hash=r=>createHash('sha256').update(JSON.stringify(r)).digest('hex');
for(const arm of ['native','community']){
 const db=new DatabaseSync(path.join(base,'oceanbase',arm==='native'?'.codegraph-wx':'.codegraph','codegraph.db'),{readOnly:true});
 const sample=plans[arm].samples.find(v=>v.id==='ttl-qualified-member'&&v.sql.startsWith('SELECT * FROM edges WHERE source IN'));
 const rows=[];let next;
 for(let pass=0;pass<3;pass++)for(const variant of ['before','after']){
  const start=performance.now();next=variant==='after'?subgraphEdgeSql(db,sample.sql,sample.args):sample.sql;
  const result=db.prepare(next).all(...sample.args);
  rows.push({pass,variant,ms:performance.now()-start,rows:result.length,order_sha:hash(result),changed:next!==sample.sql});
 }
 if(new Set(rows.map(r=>r.order_sha)).size!==1)throw Error('ordered difference: '+arm);
 out[arm]={ids:JSON.parse(sample.args[0]).length,args_sha:hash(sample.args),rows,original_plan:db.prepare('EXPLAIN QUERY PLAN '+sample.sql).all(...sample.args),optimized_plan:db.prepare('EXPLAIN QUERY PLAN '+next).all(...sample.args)};db.close();
}
// Probe overhead is measured separately on a tiny graph and a source hub.
for (const shape of ['tiny', 'source-hub']) {
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT);CREATE INDEX idx_edges_source_kind ON edges(source,kind);CREATE INDEX idx_edges_target_kind ON edges(target,kind)');
 const ins=db.prepare('INSERT INTO edges(source,target,kind) VALUES(?,?,?)');
 ins.run('a','b','calls');
 for(let i=0;i<(shape==='tiny'?10:10000);i++)ins.run(shape==='tiny'?'outside':'a','outside'+i,'calls');
 const sql='SELECT * FROM edges WHERE source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?)) AND kind IN (?)',args=['["a","b"]','["a","b"]','calls'];
 const rows=[];
 for(const variant of ['before','after']){const start=performance.now();let result;let rewrites=0;for(let i=0;i<200;i++){const next=variant==='after'?subgraphEdgeSql(db,sql,args):sql;if(next!==sql)rewrites++;result=db.prepare(next).all(...args);}rows.push({variant,per_call_ms:(performance.now()-start)/200,rewrites,order_sha:hash(result)});}
 if(rows[0].order_sha!==rows[1].order_sha)throw Error('ordered difference: '+shape);
 out[shape]={rows};db.close();
}
fs.writeFileSync(process.argv[3],JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));
