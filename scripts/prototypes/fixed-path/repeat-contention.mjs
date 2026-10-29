/** Bounded stability probe: retain all three attempts; any failure fails the run. */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../../..');
const evidence=path.resolve(process.env.CONTENTION_EVIDENCE_DIR??path.join(root,'artifacts/fixed-path-contention',`${process.platform}-${Date.now()}`));
fs.mkdirSync(evidence,{recursive:true});const attempts=[];
for(let attempt=1;attempt<=3;attempt++){
 const out=path.join(evidence,`attempt-${attempt}`);fs.mkdirSync(out,{recursive:true});
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--liftoff-only','--test','--test-name-pattern=^five independent prototype participant processes',path.join(here,'acceptance.test.mjs')],{cwd:root,env:{...process.env,CODEGRAPH_PROTOTYPE_READ_GATES:'0',FIXED_PATH_EVIDENCE_DIR:out},stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{process.stdout.write(b);fs.appendFileSync(path.join(out,'run.log'),b);});
  child.on('error',reject);child.on('close',(code,signal)=>resolve({attempt,code,signal}));
 });
 attempts.push(result);fs.writeFileSync(path.join(evidence,'attempts.json'),JSON.stringify(attempts,null,2));
}
process.exitCode=attempts.some(r=>r.code!==0)?1:0;
console.log(`CONTENTION_EVIDENCE=${evidence}`);
