/** Follow-up experiment; runs original safety suite plus source reconciliation. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../../..');
if(!fs.existsSync(path.join(root,'dist/index.js')))throw new Error('Run npm run build first');
const evidence=path.resolve(process.env.SOURCE_EVIDENCE_DIR??path.join(root,'artifacts/fixed-path-source-reconciliation',`${process.platform}-${Date.now()}`));fs.mkdirSync(evidence,{recursive:true});
fs.writeFileSync(path.join(evidence,'environment.json'),JSON.stringify({at:new Date().toISOString(),platform:process.platform,node:process.version,arch:process.arch,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemoryBytes:os.totalmem(),scope:'phase-one follow-up, no production integration, conditional eventual convergence'},null,2));
const files=['retirement-contention.test.mjs','admission-cancel.test.mjs','admission-budget.test.mjs','gate-reuse.test.mjs','cold-open.test.mjs','acceptance.test.mjs','graph-integration.test.mjs','graph-performance.test.mjs','source-reconciliation.test.mjs','source-performance.test.mjs','source-snapshot.test.mjs','gate-read.test.mjs','gate-diagnostics.test.mjs','gate-wait-policy.test.mjs','ipc.test.mjs','recovery-observer.test.mjs','source-observation-sequence.test.mjs'].map(n=>path.join(here,n));
const child=spawn(process.execPath,['--liftoff-only','--test','--test-concurrency=1',...files],{cwd:root,env:{...process.env,CODEGRAPH_ALL_LANGUAGES:'1',FIXED_PATH_EVIDENCE_DIR:evidence,SOURCE_EVIDENCE_DIR:evidence},stdio:['ignore','pipe','pipe']});const log=path.join(evidence,'run.log');
for(const [stream,dest]of[[child.stdout,process.stdout],[child.stderr,process.stderr]])stream.on('data',b=>{dest.write(b);fs.appendFileSync(log,b);});
child.on('error',e=>{fs.appendFileSync(log,e.stack);process.exitCode=1;});child.on('close',(code,signal)=>{fs.writeFileSync(path.join(evidence,'exit.json'),JSON.stringify({code,signal,completedAt:new Date().toISOString()},null,2));console.log(`SOURCE_EVIDENCE=${evidence}`);process.exitCode=code??1;});
