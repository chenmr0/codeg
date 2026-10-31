/** Disk-only assertions: never remove product files or trigger recovery while polling. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const allowed = new Set(['.runtime', 'codegraph.db', 'codegraph.db-wal', 'codegraph.db-shm']);
function tree(root, relative = '') {
  let names;
  try { names=fs.readdirSync(path.join(root,relative)).sort(); }
  catch(error) { if(error.code==='ENOENT')return [];throw error; }
  return names.flatMap(name => {
    const file=path.join(relative,name);let stat;
    try { stat=fs.lstatSync(path.join(root,file)); }
    catch(error) { if(error.code==='ENOENT')return [];throw error; }
    return [{path:file.split(path.sep).join('/'), type:stat.isDirectory()?'directory':stat.isFile()?'file':'other',bytes:stat.size}, ...(stat.isDirectory()?tree(root,file):[])];
  });
}
function snapshot(root) {
  const entries = tree(root), runtime = entries.filter(e=>e.path.startsWith('.runtime/'));
  const taskDirectories = runtime.filter(e=>e.type==='directory' && /^(?:[0-9a-f-]{36}|bootstrap-.+)$/.test(path.basename(e.path)));
  const businessCopies = runtime.filter(e=>e.type==='file' && /(?:^|\/)(?:codegraph|candidate|old|backup|snapshot)\.db(?:-(?:wal|shm|journal))?$/.test(e.path));
  return {at:new Date().toISOString(),atomic:false,root,rootEntries:fs.existsSync(root)?fs.readdirSync(root).sort():[],entries,runtimeBytes:runtime.filter(e=>e.type==='file').reduce((n,e)=>n+e.bytes,0),taskDirectoryCount:taskDirectories.length,taskDirectories,businessCopyCount:businessCopies.length,businessCopyBytes:businessCopies.reduce((n,e)=>n+e.bytes,0),businessCopies};
}
function contract(s) {
  assert.deepEqual(s.rootEntries.filter(x=>!allowed.has(x)),[],`unexpected root entries: ${JSON.stringify(s.rootEntries)}`);
  assert(s.rootEntries.includes('.runtime'),'missing .runtime');
  assert(s.rootEntries.includes('codegraph.db'),'missing active business database');
  assert.equal(s.entries.find(e=>e.path==='codegraph.db')?.type,'file');
  assert.equal(s.entries.find(e=>e.path==='.runtime')?.type,'directory');
}
async function reclaimed(root, timeoutMs=10000) {
  const start=Date.now(); let current;
  do {
    current=snapshot(root);
    if(current.taskDirectoryCount===0 && current.businessCopyCount===0){contract(current);return current;}
    await new Promise(r=>setTimeout(r,25));
  } while(Date.now()-start<timeoutMs);
  assert.fail(`automatic cleanup timeout after ${timeoutMs}ms (no query/recovery/manual delete): ${JSON.stringify(current)}`);
}
module.exports={tree,snapshot,contract,reclaimed};
