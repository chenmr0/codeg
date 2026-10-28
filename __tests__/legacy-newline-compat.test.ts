/** Runs the real old release with only schema file line endings transformed.
 * No version/ownership/recovery stamps are manufactured or modified. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const baseline = process.env.CODEGRAPH_LEGACY_DIST ?? path.resolve(__dirname, '../../adaptive-perf-20261028/codeg-baseline/dist');
const current = path.resolve(__dirname, '../dist');
const roots: string[] = [];
const variants = ['lf', 'crlf', 'mixed'];
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const transformHook = `
 process.execArgv=['--liftoff-only'];
 const fs=require('node:fs'),path=require('node:path');
 const read=fs.readFileSync;
 const target=path.resolve(process.argv[1],'db/schema.sql');
 fs.readFileSync=function(file,...args){
  const value=read.call(this,file,...args);
  if(process.argv[3]==='native'||typeof file!=='string'||path.resolve(file)!==target)return value;
  const text=String(value).replace(/\\r\\n?/g,'\\n'); let n=0;
  const converted=text.replace(/\\n/g,()=>process.argv[3]==='crlf'?'\\r\\n':process.argv[3]==='mixed'?(++n%2?'\\r\\n':'\\n'):'\\n');
  return Buffer.isBuffer(value)?Buffer.from(converted):converted;
 };
`;
function run(code: string, dist: string, root: string, variant: string) {
 const result=spawnSync(process.execPath,['--liftoff-only','-e',transformHook+code,dist,root,variant],{encoding:'utf8',timeout:60000});
 expect(result.status,result.stdout+result.stderr).toBe(0); return result.stdout;
}
afterAll(()=>roots.forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
describe.skipIf(!fs.existsSync(path.join(baseline,'index.js')))('official legacy newline compatibility',()=>{
 const databases=new Map<string,string>();
 beforeAll(()=>{
  for(const variant of variants){
   const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-legacy-newline-'));roots.push(root);
   fs.writeFileSync(path.join(root,'main.c'),'int original(void){ return 1; }\n');
   run(`const {CodeGraph}=require(process.argv[1]);(async()=>{const g=await CodeGraph.init(process.argv[2],{index:true});if(g.getIndexCompleteness().status!=='complete')throw Error('legacy incomplete');g.close()})().catch(e=>{console.error(e);process.exitCode=1});`,baseline,root,variant);
   databases.set(variant,root);
  }
 },60000);
 for(const oldVariant of variants) for(const templateVariant of variants){
  it(`admits ${oldVariant} official schema against ${templateVariant} template without writes`,()=>{
   const root=databases.get(oldVariant)!;const file=path.join(root,'.codegraph-wx/codegraph.db');const before=hash(file);
   run(`const {DatabaseConnection}=require(path.join(process.argv[1],'db'));const {inspectLegacySourceProvenance,isSourceOwned}=require(path.join(process.argv[1],'sync/source-ownership'));const db=DatabaseConnection.openReadOnly(path.join(process.argv[2],'.codegraph-wx/codegraph.db'));try{const r=inspectLegacySourceProvenance(db.getDb());if(!r.eligible||isSourceOwned(db.getDb()))throw Error(JSON.stringify(r));}finally{db.close()}`,current,root,templateVariant);
   expect(hash(file)).toBe(before);
  });
 }
 it.each(variants)('ordinary sync upgrades actual %s legacy without manual init',async variant=>{
  const root=databases.get(variant)!;
  run(`const {CodeGraph}=require(process.argv[1]);(async()=>{const g=CodeGraph.openSync(process.argv[2]);try{const r=await g.sync();if(r.adaptive?.strategy!=='rebuild')throw Error(JSON.stringify(r));if(!fs.existsSync(path.join(process.argv[2],'.codegraph-wx/CURRENT')))throw Error('missing CURRENT');if(!g.searchNodes('original').length)throw Error('missing symbol');}finally{g.close()}})().catch(e=>{console.error(e);process.exitCode=1});`,current,root,'native');
 });
});
