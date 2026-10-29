/** Test-only adapter around REAL CodeGraph extraction/query/resolver objects.
 * Calls the emitted JS constructor because production open() still follows CURRENT.
 * This deliberately does not change the production entry points in phase one.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const { CodeGraph, DatabaseConnection, QueryBuilder, initGrammars } = require('../../../dist/index.js');
const {createAdaptivePlan,adaptiveRuntimeKey}=require('../../../dist/sync/adaptive-plan.js');
const {validateRebuiltDatabase}=require('../../../dist/sync/rebuild-controller.js');
export async function expectedIndex(root){return (await createAdaptivePlan(root,[],{runtimeKey:adaptiveRuntimeKey(root,'node-sqlite'),fullHash:true})).snapshot;}
const { installSourceOwnership, isSourceOwned } = require('../../../dist/sync/source-ownership.js');
export async function prepareGrammars() { await initGrammars(); }
export function graphAt(root, file, { initialize = false, readOnly = false } = {}) {
  if (!initialize) { const fd=fs.openSync(file,'r'), header=Buffer.alloc(16); try { fs.readSync(fd,header,0,16,0); } finally { fs.closeSync(fd); } if(header.toString('binary')!=='SQLite format 3\0') throw new Error('Invalid SQLite header: damaged offline database; no fallback used'); }
  const db = initialize ? DatabaseConnection.initialize(file) : readOnly ? DatabaseConnection.openReadOnly(file) : DatabaseConnection.open(file, { nativeOnly: true });
  try {
    if (initialize) installSourceOwnership(db.getDb());
    // shadowCandidate skips generation indirection but uses the real implementation.
    return new CodeGraph(db, new QueryBuilder(db.getDb()), path.resolve(root), true, readOnly, readOnly);
  } catch (e) { db.close(); throw e; }
}
export async function buildGraph(root, destination) {
  await prepareGrammars();
  const graph = graphAt(root, destination, { initialize: true });
  try { const result = await graph.indexAll(); if (!result.success || !result.complete) throw new Error(`Incomplete candidate: ${JSON.stringify(result)}`); return result; }
  finally { graph.close(); }
}
export function validateGraph(root, file, snapshot) {
  if(snapshot && !validateRebuiltDatabase(file,snapshot))throw new Error('Production rebuilt-index completeness validation failed');
  const graph = graphAt(root, file, { readOnly: true });
  try {
    if (!isSourceOwned(graph.db.getDb())) throw new Error('Candidate source ownership is not complete');
    if (graph.queries.getMetadata('index_synthesis_completed_version') !== '1') throw new Error('Candidate index synthesis is incomplete');
    graph.getStats();
  } finally { graph.close(); }
}
export function sourceSnapshot(root) {
  const rows = [], buffer = Buffer.allocUnsafe(64*1024);
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', '.codegraph-wx', 'node_modules'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name), relative = path.relative(root, file);
      if (entry.isSymbolicLink()) throw new Error(`Prototype source snapshot rejects symlink: ${relative}`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        // One metadata read and one reusable bounded buffer per tree traversal.
        // Keep complete content hashing, regular-file/symlink and I/O error checks.
        const stat=fs.lstatSync(file,{bigint:true});
        if(!stat.isFile() || stat.isSymbolicLink())throw new Error(`Prototype source snapshot rejects non-regular file: ${relative}`);
        const fd=fs.openSync(file,'r'), hash=crypto.createHash('sha256');
        try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));}
        finally{fs.closeSync(fd);}
        rows.push({path:relative,hash:hash.digest('hex'),size:Number(stat.size),mtimeNs:String(stat.mtimeNs)});
      }
    }
  }
  walk(root); rows.sort((a,b)=>a.path.localeCompare(b.path));
  return { rows, digest:crypto.createHash('sha256').update(JSON.stringify(rows.map(r=>[r.path,r.hash]))).digest('hex') };
}
export function cheapSourceFence(root, snapshot) {
  for (const row of snapshot.rows) {
    const stat=fs.statSync(path.join(root,row.path),{bigint:true});
    if (String(stat.mtimeNs)!==row.mtimeNs || Number(stat.size)!==row.size) throw new Error('Source changed after validation; candidate rejected');
  }
}
