/** Phase-one A/B only: default exclusive vs opt-in warm read gate. */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../../..');
const evidence=path.resolve(process.env.GATE_EVIDENCE_DIR??path.join(root,'artifacts/fixed-path-gate-experiment',`${process.platform}-${Date.now()}`));
fs.mkdirSync(evidence,{recursive:true});
for(const [mode,flag]of[['exclusive','0'],['shared-read','1']]){
 const destination=path.join(evidence,mode);
 const code=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(here,'run-source.mjs')],{cwd:root,env:{...process.env,CODEGRAPH_PROTOTYPE_READ_GATES:flag,CODEGRAPH_PROTOTYPE_MEASURE_GATES:'1',SOURCE_EVIDENCE_DIR:destination},stdio:'inherit'});
  child.on('error',reject);child.on('exit',code=>resolve(code??1));
 });
 if(code===0){
  const input=JSON.parse(fs.readFileSync(path.join(destination,`graph-performance-${process.platform}.json`),'utf8'));
  const values=input.roles.flatMap(r=>r.gateMetrics??[]),q=a=>{a=a.slice().sort((a,b)=>a-b);return{count:a.length,mean:a.reduce((s,n)=>s+n,0)/(a.length||1),p50:a[Math.ceil(a.length*.5)-1]??0,p95:a[Math.ceil(a.length*.95)-1]??0,p99:a[Math.ceil(a.length*.99)-1]??0,max:a.at(-1)??0};};
  const labels={};for(const label of [...new Set(values.map(m=>m.label))]){const rows=values.filter(m=>m.label===label);labels[label]={};for(const key of ['totalMs','openMs','beginMs','actionMs','commitMs','closeMs','retries'])labels[label][key]=q(rows.map(r=>r[key]));}
  fs.writeFileSync(path.join(destination,'gate-summary.json'),JSON.stringify({mode,platform:process.platform,queries:input.queries,labels},null,2));
 }
 if(code!==0){console.error(`GATE_AB_FAILED=${mode}`);process.exitCode=code;break;}
}
console.log(`GATE_AB_EVIDENCE=${evidence}`);
