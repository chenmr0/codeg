import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, ensureSqlJsReady } from '../src/db/sqlite-adapter';
import { QueryBuilder } from '../src/db/queries';

const directories: string[] = [];
const databases: Array<ReturnType<typeof createDatabase>['db']> = [];
afterEach(()=>{
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for(const db of databases.splice(0))db.close();
  for(const directory of directories.splice(0))fs.rmSync(directory,{recursive:true,force:true});
});
async function fixture(wasm: boolean){
  if(wasm){vi.stubGlobal('fetch',undefined);try{await ensureSqlJsReady();}finally{vi.unstubAllGlobals();}}
  vi.stubEnv('CODEGRAPH_FORCE_WASM',wasm?'1':'');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cg-retry-index-'));directories.push(directory);
  const {db,backend}=createDatabase(path.join(directory,'graph.db'));databases.push(db);
  expect(backend).toBe(wasm?'sql-js':'node-sqlite');
  db.exec(fs.readFileSync(path.join(__dirname,'../src/db/schema.sql'),'utf8'));
  const q=new QueryBuilder(db);
  q.insertNodes([{id:'caller',kind:'function',name:'caller',qualifiedName:'caller',filePath:'caller.cpp',language:'cpp',startLine:1,endLine:1,startColumn:0,endColumn:1}]);
  const insert=db.prepare("INSERT INTO unresolved_refs (from_node_id,reference_name,reference_kind,line,col,file_path,language,status,name_tail) VALUES ('caller',?,'calls',?,0,'caller.cpp','cpp',?,?)");
  let line=1;
  db.transaction(()=>{
    for(const [name,count] of [['alpha',3],['beta',501],['gamma',1],['unrelated',1100]] as const)
      for(let i=0;i<count;i++)insert.run(name,line++,'failed',name);
    insert.run('alpha',line++,'pending','alpha');
  })();
  db.exec("ANALYZE; UPDATE sqlite_stat1 SET stat='1000000 1' WHERE idx='idx_unresolved_status'; UPDATE sqlite_stat1 SET stat='1000000 250' WHERE idx='idx_unresolved_failed_tail'; ANALYZE sqlite_master;");
  const names=Array.from({length:505},(_,i)=>'unknown_'+i);names[0]='alpha';names[250]='beta';names[504]='gamma';
  return {db,q,names};
}
const expected={groups:[{nameTail:'alpha',total:3,maxRowId:3},{nameTail:'gamma',total:1,maxRowId:505}],total:4,skippedGroups:1,skippedRefs:501};
describe.each([false,true])('failed retry planning with wasm=%s',(wasm)=>{
  it('uses covering name lookups despite biased statistics, preserving caps, rows and high-water marks',async()=>{
    const {db,q,names}=await fixture(wasm),sqls:string[]=[];
    const prepare=db.prepare.bind(db);
    vi.spyOn(db,'prepare').mockImplementation((sql:string)=>{sqls.push(sql);return prepare(sql);});
    expect(q.getFailedReferenceRetryPlan([...names,'alpha',''],500)).toEqual(expected);
    const queries=sqls.filter(sql=>sql.startsWith('SELECT name_tail, COUNT(*) AS count'));
    expect(queries).toHaveLength(2);
    for(let i=0;i<queries.length;i++){
      const plan=prepare('EXPLAIN QUERY PLAN '+queries[i]).all(...names.slice(i*500,i*500+500)) as Array<{detail:string}>;
      expect(plan.some(row=>row.detail.includes('idx_unresolved_failed_tail'))).toBe(true);
      expect(plan.some(row=>row.detail.includes('idx_unresolved_status'))).toBe(false);
    }
    expect(q.getFailedReferenceRetryPlan(['alpha','beta','gamma']).total).toBe(505);
    expect(prepare('SELECT COUNT(*) n FROM unresolved_refs').get()).toMatchObject({n:1606});
  });
  it('preserves results while the index is absent and uses it again after recreation',async()=>{
    const {db,q,names}=await fixture(wasm);
    db.exec('DROP INDEX idx_unresolved_failed_tail');
    expect(q.getFailedReferenceRetryPlan(names,500)).toEqual(expected);
    db.exec("CREATE INDEX idx_unresolved_failed_tail ON unresolved_refs(name_tail) WHERE status='failed'");
    expect(q.getFailedReferenceRetryPlan(names,500)).toEqual(expected);
    expect(q.getFailedReferenceRetryPlan([],500)).toEqual({groups:[],total:0,skippedGroups:0,skippedRefs:0});
  });
});
