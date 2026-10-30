// Keep streaming-evidence regressions in the prototype CI's root test glob.
import './real-benchmark/request-journal.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('real load-profile journals every request and closes active readers normally',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'benchmark-stream-load-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'main.py'),'class ObServer:\n    pass\n');
 const worker=fileURLToPath(new URL('./real-benchmark/worker.mjs',import.meta.url)),load=fileURLToPath(new URL('./real-benchmark/load-profile.mjs',import.meta.url));
 const env={...process.env,CODEGRAPH_ALL_LANGUAGES:'1',BENCHMARK_IDLE_MS:'100',BENCHMARK_QUERY_INTERVAL_MS:'100'};
 const init=spawnSync(process.execPath,['--liftoff-only',worker,'init',root,path.join(root,'init.json')],{encoding:'utf8',env,timeout:30000});assert.equal(init.status,0,init.stderr);
 const out=path.join(root,'load.json'),r=spawnSync(process.execPath,['--liftoff-only',load,'load',root,out,'idle'],{encoding:'utf8',env,timeout:30000});assert.equal(r.status,0,r.stderr);
 const summary=JSON.parse(fs.readFileSync(out));assert.deepEqual(summary.errors,[]);assert.deepEqual(summary.closeErrors,[]);
 for(let i=0;i<5;i++){
  const report=JSON.parse(fs.readFileSync(`${out}.client-${i}.json`)),records=fs.readFileSync(`${out}.client-${i}.json.ndjson`,'utf8').trim().split('\n').map(x=>JSON.parse(x));
  assert.equal(records[0].type,'start');assert.equal(records.at(-1).type,'stop');assert.deepEqual(records.filter(r=>r.type==='request').map(r=>r.record),report.rows);assert.equal(report.journal.writtenRecords,report.completedRequests+2);assert.ok(report.completedRequests>0);
 }
 for(const suffix of ['-wal','-shm','-journal'])assert.equal(fs.existsSync(path.join(root,'.codegraph-wx/codegraph.db')+suffix),false,'no unleased post-close evidence query');
});
