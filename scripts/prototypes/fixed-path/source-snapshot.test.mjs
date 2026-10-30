/** Isolated snapshot I/O regressions; no timing thresholds or production edits.
 * Run after npm run build: node --liftoff-only --test scripts/prototypes/fixed-path/source-snapshot.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sourceSnapshot } from './graph-adapter.mjs';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'source-snapshot-regression-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function withHooks(target,replacements,action){const originals={};try{for(const [key,fn] of Object.entries(replacements)){originals[key]=target[key];target[key]=fn(originals[key]);}return action();}finally{for(const [key,original] of Object.entries(originals))target[key]=original;}}

test('snapshot hashes full binary bytes across buffer boundaries and preserves metadata',t=>{
 const root=fixture(t),sizes=[0,1,65535,65536,65537,1048576+137],expected=[];
 for(const [i,size] of sizes.entries()){const bytes=Buffer.alloc(size);for(let j=0;j<size;j++)bytes[j]=(j*37+i)%256;const relative=`boundary-${i}.bin`,file=path.join(root,relative);fs.writeFileSync(file,bytes);fs.utimesSync(file,new Date('2020-01-02T03:04:05Z'),new Date('2020-01-02T03:04:05Z'));const stat=fs.statSync(file,{bigint:true});expected.push({path:relative,hash:digest(bytes),size:Number(stat.size),mtimeNs:String(stat.mtimeNs)});}
 const actual=sourceSnapshot(root);assert.deepEqual(actual.rows,expected);assert.equal(actual.digest,digest(JSON.stringify(expected.map(r=>[r.path,r.hash]))));
});

for(const kind of ['file','directory'])test(`snapshot rejects ${kind} symlinks (explicit Windows permission skip)`,t=>{
 const root=fixture(t),target=path.join(root,'target'),link=path.join(root,'link');if(kind==='file')fs.writeFileSync(target,'payload');else fs.mkdirSync(target);
 try{fs.symlinkSync(target,link,kind==='file'?'file':'dir');}catch(error){if(process.platform==='win32'&&['EPERM','EACCES','ENOTSUP'].includes(error.code)){if(process.env.STRICT_SYMLINK_TESTS==='1')throw new Error(`Required Windows symlink test unavailable: ${error.code}; skipping forbidden`,{cause:error});t.skip(`Windows symlink privilege unavailable: ${error.code}; rejection not verified on this host`);return;}throw error;}
 assert.throws(()=>sourceSnapshot(root),/rejects symlink/);
});

test('snapshot propagates enumeration/read errors and closes the failed read descriptor',t=>{
 const root=fixture(t);fs.writeFileSync(path.join(root,'input.bin'),'payload');const denied=Object.assign(new Error('injected directory permission failure'),{code:'EACCES'});
 withHooks(fs,{readdirSync:original=>function(dir,...args){if(dir===root)throw denied;return original.call(this,dir,...args);}},()=>assert.throws(()=>sourceSnapshot(root),error=>error===denied));
 const io=Object.assign(new Error('injected read I/O failure'),{code:'EIO'});let opened,closed;
 withHooks(fs,{
  openSync:original=>function(...args){opened=original.apply(this,args);return opened;},
  readSync:()=>function(){throw io;},
  closeSync:original=>function(fd){closed=fd;return original.call(this,fd);},
 },()=>assert.throws(()=>sourceSnapshot(root),error=>error===io));
 assert.equal(typeof opened,'number');assert.equal(closed,opened,'fd closed even when content read fails');assert.equal(sourceSnapshot(root).rows.length,1,'hooks restored and fixture remains readable');
});

test('snapshot uses one bounded buffer per traversal and one metadata call per file',t=>{
 const root=fixture(t),count=9;fs.mkdirSync(path.join(root,'nested'));for(let i=0;i<count;i++)fs.writeFileSync(path.join(root,i%2?'nested':'',`${i}.bin`),Buffer.alloc(i*19001,i));
 const allocations=[],readBuffers=new Set();let lstat=0,stat=0,files;
 withHooks(Buffer,{allocUnsafe:original=>function(size){allocations.push(size);return original.call(this,size);}},()=>withHooks(fs,{
  lstatSync:original=>function(...args){lstat++;assert.equal(args[1]?.bigint,true);return original.apply(this,args);},
  statSync:original=>function(...args){stat++;return original.apply(this,args);},
  readSync:original=>function(fd,buffer,...args){readBuffers.add(buffer);return original.call(this,fd,buffer,...args);},
 },()=>{files=sourceSnapshot(root).rows.length;}));
 assert.equal(files,count);assert.deepEqual(allocations,[64*1024]);assert.equal(readBuffers.size,1);assert.equal([...readBuffers][0].length,64*1024);assert.equal(lstat,count);assert.equal(stat,0,'no duplicate metadata calls');
});
