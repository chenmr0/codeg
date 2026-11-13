import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { separateGitDirectoryLinks } from '../src/extraction/git-linked-roots';
import { scanDirectory } from '../src/extraction';
import { indexConfigFingerprints } from '../src/sync/index-policy';
import CodeGraph from '../src/index';
let base: string, root: string, shared: string;
const git = (...args: string[]) => execFileSync('git', args, {cwd: root, stdio:'pipe'});
beforeEach(() => {
 base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cg-boundary-')));
 root=path.join(base,'repo'); shared=path.join(base,'shared');
 fs.mkdirSync(root);fs.mkdirSync(shared);git('init','-q');
 fs.writeFileSync(path.join(root,'local.c'),'int local_fn(void){return 0;}');
 fs.writeFileSync(path.join(shared,'remote.c'),'int remote_fn(void){return 1;}');
 fs.symlinkSync(shared,path.join(root,'linked'),'junction');
 vi.stubEnv('CODEGRAPH_ALLOWED_SOURCE_ROOTS',shared);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();fs.rmSync(base,{recursive:true,force:true});});
it('does not read symlink ignore controls during scanning or fingerprinting',ctx=>{
 const outside=path.join(base,'private-ignore');fs.writeFileSync(outside,'remote.c\n');
 try { fs.symlinkSync(outside,path.join(shared,'.gitignore')); } catch(error) {
 if(process.platform==='win32' && (error as NodeJS.ErrnoException).code==='EPERM') { ctx.skip(); return; } throw error;
 }
 const read=fs.readFileSync; const spy=vi.spyOn(require('fs'),'readFileSync').mockImplementation((p:any,...args:any[])=>{
 if (String(p)===path.join(root,'linked/.gitignore')) throw new Error('FORBIDDEN CONTROL READ');
 return (read as any)(p,...args);
 });
 expect(scanDirectory(root).sort()).toEqual(['linked/remote.c','local.c']);
 expect(()=>indexConfigFingerprints(root,[{path:'linked/remote.c'}])).not.toThrow();
});
it('honors global excludes and does not fall back on unrelated ELOOP',()=>{
 const excludes=path.join(base,'excludes');fs.writeFileSync(excludes,'*.private.c\n');
 git('config','core.excludesFile',excludes);
 fs.writeFileSync(path.join(shared,'secret.private.c'),'int secret;');
 fs.writeFileSync(path.join(root,'root.private.c'),'int root_secret;');
 expect(scanDirectory(root).sort()).toEqual(['linked/remote.c','local.c']);
 if(process.platform!=='win32') fs.symlinkSync('loop',path.join(root,'loop'));
 expect(scanDirectory(root).sort()).toEqual(['linked/remote.c','local.c']);
});
it('does not expand unrelated internal directory aliases when external roots are configured',()=>{
 fs.mkdirSync(path.join(root,'vault'));fs.writeFileSync(path.join(root,'vault/hidden.c'),'int hidden;');
 fs.writeFileSync(path.join(root,'.gitignore'),'/vault/\n');
 fs.symlinkSync(path.join(root,'vault'),path.join(root,'public'),'junction');
 expect(scanDirectory(root).sort()).toEqual(['linked/remote.c','local.c']);
});
it('applies nested negations after parent file patterns',()=>{
 fs.writeFileSync(path.join(root,'.gitignore'),'*.c\n');
 fs.writeFileSync(path.join(shared,'.gitignore'),'!keep.c\n');
 fs.writeFileSync(path.join(shared,'keep.c'),'int keep;');
 expect(scanDirectory(root)).toEqual(['linked/keep.c']);
});
for (const fault of ['directory','ignore']) it.skipIf(process.platform === 'win32')(`fails closed on real ${fault} EACCES without deleting indexed symbols`,()=>{
 if (fault === 'ignore') fs.writeFileSync(path.join(shared,'.gitignore'),'hidden.c\n');
 const denied = fault === 'directory' ? shared : path.join(shared,'.gitignore');
 const uid = process.getuid?.() === 0 ? 65534 : undefined;
 for(const dir of [base,root,shared]) fs.chmodSync(dir,0o777);
 if(uid !== undefined) {fs.chownSync(shared,uid,uid);if(fault==='ignore')fs.chownSync(denied,uid,uid);}
 const script=path.join(base,'probe.cjs');
 fs.writeFileSync(script,`
 const fs=require('fs');
 const CodeGraph=require(${JSON.stringify(path.resolve('dist/index.js'))}).default;
 (async()=>{const cg=CodeGraph.initSync(${JSON.stringify(root)});try{
 await cg.indexAll();fs.chmodSync(${JSON.stringify(denied)},${fault==='directory'?'0o111':'0o000'});
 let failed=false;try{await cg.sync({adaptive:false})}catch(e){failed=/scan incomplete/.test(String(e));}
 if(!failed)throw Error('sync accepted incomplete scan');
 if(!cg.getNodesByKind('function').some(n=>n.name==='remote_fn'))throw Error('old symbol deleted');
 }finally{fs.chmodSync(${JSON.stringify(denied)},0o777);cg.close();}})().catch(e=>{console.error(e);process.exitCode=1});
 `);
 expect(()=>execFileSync(process.execPath,['--liftoff-only',script],{uid,gid:uid,env:process.env,stdio:'pipe'})).not.toThrow();
},60000);

it('filters Git-expanded junction descendants and delegates them once to bounded traversal',()=>{
 const other=path.join(base,'other');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'secret.c'),'int secret;');
 fs.symlinkSync(other,path.join(root,'denied'),'junction');
 fs.symlinkSync(shared,path.join(shared,'cycle'),'junction');
 const selected=separateGitDirectoryLinks(root,new Set(['local.c','linked/remote.c','linked/cycle/remote.c','denied/secret.c']));
 expect([...selected.ordinary]).toEqual(['local.c']);
 expect(selected.external).toEqual(['linked']);
 expect(scanDirectory(root).filter(x=>x.endsWith('/remote.c'))).toHaveLength(1);
 fs.writeFileSync(path.join(root,'.codegraphignore'),'linked/\n');
 expect(scanDirectory(root)).toEqual(['local.c']);
});
it('preserves CodeGraph override priority over nested negations',()=>{
 fs.writeFileSync(path.join(root,'.codegraphignore'),'*.c\n');
 fs.writeFileSync(path.join(shared,'.gitignore'),'!remote.c\n');
 expect(scanDirectory(root)).toEqual([]);
});
it('deduplicates physical files reached by distinct aliases and hard links',()=>{
 fs.linkSync(path.join(shared,'remote.c'),path.join(shared,'duplicate.c'));
 expect(scanDirectory(root).filter(f=>f.startsWith('linked/'))).toHaveLength(1);
});
