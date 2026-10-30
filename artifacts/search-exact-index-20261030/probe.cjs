// Read-only microbenchmark, not full-build/cutover acceptance evidence.
const {DatabaseSync}=require('node:sqlite');
const assert=require('node:assert/strict');
const db=new DatabaseSync(process.argv[2], {readOnly:true});
const order='is_declaration ASC,length(name) ASC,name ASC,qualified_name ASC,kind ASC,file_path ASC,start_line ASC,start_column ASC,id ASC';
const old=`SELECT * FROM nodes WHERE name = ? COLLATE NOCASE ORDER BY ${order} LIMIT 20`;
const next=`SELECT * FROM nodes WHERE lower(name) = lower(?) ORDER BY ${order} LIMIT 20`;
const result={node:process.version,db:process.argv[2],note:'5 paired alternating-order repeats, readonly native SQLite, warm/cold not controlled; not full-build/cutover gate',plans:{old:db.prepare('EXPLAIN QUERY PLAN '+old).all('ObObj'),next:db.prepare('EXPLAIN QUERY PLAN '+next).all('ObObj')},samples:[]};
for(let round=0;round<5;round++)for(const term of ['ObObj','ObString','ObServer']){
 const sample={round,term};const rows={};
 for(const mode of round%2?['next','old']:['old','next']){const start=performance.now();rows[mode]=db.prepare(mode==='old'?old:next).all(term);sample[mode+'Ms']=performance.now()-start;}
 assert.deepEqual(rows.old,rows.next);sample.count=rows.old.length;result.samples.push(sample);
}
db.close();console.log(JSON.stringify(result,null,2));
