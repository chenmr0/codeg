/** Cross-platform, no network, no real user DB touched. Build dist first. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../../..');
if(!fs.existsSync(path.join(root,'dist/index.js')))throw new Error('Run npm run build before prototype acceptance');
const evidence=path.resolve(process.env.FIXED_PATH_EVIDENCE_DIR??path.join(root,'artifacts/fixed-path-prototype',`${process.platform}-final-${Date.now()}`));
fs.mkdirSync(evidence,{recursive:true});
fs.writeFileSync(path.join(evidence,'environment.json'),JSON.stringify({at:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.version,release:os.release(),cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemoryBytes:os.totalmem(),phase:1,productionFlowChanged:false,scope:'temporary fixtures only; no user database'},null,2));
const files=['acceptance.test.mjs','graph-integration.test.mjs','graph-performance.test.mjs'].map(n=>path.join(here,n));
const child=spawn(process.execPath,['--liftoff-only','--test','--test-concurrency=1',...files],{cwd:root,env:{...process.env,CODEGRAPH_ALL_LANGUAGES:'1',FIXED_PATH_EVIDENCE_DIR:evidence},stdio:['ignore','pipe','pipe']});
const log=path.join(evidence,'run.log');
for(const [stream,dest] of [[child.stdout,process.stdout],[child.stderr,process.stderr]])stream.on('data',chunk=>{dest.write(chunk);fs.appendFileSync(log,chunk);});
child.on('error',e=>{fs.appendFileSync(log,e.stack);process.exitCode=1;});
child.on('close',(code,signal)=>{fs.writeFileSync(path.join(evidence,'exit.json'),JSON.stringify({code,signal,completedAt:new Date().toISOString()},null,2));console.log(`Evidence: ${evidence}`);process.exitCode=code??1;});
