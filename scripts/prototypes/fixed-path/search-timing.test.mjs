import test from 'node:test';
import assert from 'node:assert/strict';
import {timedSearch} from './real-benchmark/search-timing.mjs';
for(const fail of [false,true])test(`benchmark SQL timing preserves receiver, return/throw and restores db (${fail})`,()=>{
 const error=Error('query error'),db={prepare(sql){assert.equal(this,db);return {all(){if(fail)throw error;return [sql];}};}},queries={db};
 const graph={queries,searchNodes(){return this.queries.db.prepare('SELECT * FROM nodes WHERE lower(name) = lower(?)').all('a');}},timing={};
 if(fail)assert.throws(()=>timedSearch(graph,'a',{},timing),e=>e===error);else assert.deepEqual(timedSearch(graph,'a',{},timing),['SELECT * FROM nodes WHERE lower(name) = lower(?)']);
 assert.equal(queries.db,db);assert.equal(timing.searchSql.supplement.calls,1);assert.equal(timing.searchSql.fts.calls,0);assert(timing.searchSupplementSqlMs>=0);
});
test('cached statements charge only the current scope and never mutate past evidence',()=>{
 const db={prepare(){return{all(){return['ok'];}};}},queries={db};let statement;
 const graph={queries,searchNodes(){statement??=queries.db.prepare('SELECT nodes.* FROM nodes_fts');return statement.all();}},a={},b={};
 timedSearch(graph,'a',{},a);const saved=JSON.stringify(a);graph.searchNodes();timedSearch(graph,'a',{},b);
 assert.equal(JSON.stringify(a),saved);assert.equal(a.searchSql.fts.calls,1);assert.equal(b.searchSql.fts.calls,1);assert.equal(b.searchSql.fts.prepareMs,0);assert.equal(queries.db,db);
});
