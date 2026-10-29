// Test-only cycle follow-up: reuse a previously fully built standalone candidate.
// All source checks, candidate validation and publishing run unchanged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const [root,candidate,out]=process.argv.slice(2);
const here=path.dirname(fileURLToPath(import.meta.url));
const source=path.resolve(here,'../source-reconciliation.mjs');
const original=fs.readFileSync(source,'utf8');
const needle='await buildGraph(root,op.record.candidate);';
if(original.split(needle).length!==2)throw Error('Unexpected prototype source; refuse injection');
const file=path.resolve(here,`../.cached-cycle-${process.pid}.mjs`);
const transformed="import fs from 'node:fs';\n"+original.replace(needle,`fs.copyFileSync(${JSON.stringify(path.resolve(candidate))},op.record.candidate);`);
const start=performance.now();
try{
 fs.writeFileSync(file,transformed,{flag:'wx'});
 const {reconcileSource}=await import(pathToFileURL(file));
 const result=await reconcileSource(root,{maxBuilds:1});
 fs.writeFileSync(out,JSON.stringify({cachedBuild:true,candidate,sourceSha256:crypto.createHash('sha256').update(original).digest('hex'),substitution:'Only buildGraph call replaced with copy of previously complete standalone B; no validation or source fence bypassed',wallMs:performance.now()-start,result},null,2));
 if(result.status!=='verified-observation')process.exitCode=1;
}finally{fs.rmSync(file,{force:true});}
