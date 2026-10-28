import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fork, ChildProcess, spawnSync } from 'child_process';
import ts from 'typescript';
import { acquireCurrentGenerationLease, acquireGenerationLease, cleanupGenerationCandidate, collectRetiredGenerations, drainGenerationCollections, createGeneration, GenerationCandidate, GenerationWriterLock, publishGeneration, resolveGeneration } from '../src/sync/generation-store';

let root: string, code: string, lock: GenerationWriterLock;
let candidates: GenerationCandidate[], children: ChildProcess[];
function next() { const c = createGeneration(root, lock); candidates.push(c); fs.writeFileSync(c.databasePath, c.id); return c; }
async function publish(c: GenerationCandidate) { await publishGeneration(root, c, { lock, expectedPreviousId: resolveGeneration(root).id, success: true, complete: true, validate: () => true, sourceUnchanged: () => true }); cleanupGenerationCandidate(root, c); }
function message(child: ChildProcess): Promise<any> { return new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`child exited ${code}`))); }); }
async function reader(id?: string) {
  const child = fork(path.join(code, 'reader.cjs'), [root, id ?? 'CURRENT'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] }); children.push(child);
  const result = await message(child); expect(result.error).toBeUndefined(); return { child, result };
}
async function stop(child: ChildProcess, crash = false) {
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  if (crash) child.kill('SIGKILL'); else child.send('close');
  await exit;
}
function restartGC() {
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(code, 'generation-store.js'))}).collectRetiredGenerations(process.argv[1])`, root], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lifecycle-test-'));
  code = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lifecycle-code-'));
  for (const name of ['generation-store', 'generation-lifecycle']) fs.writeFileSync(path.join(code, name + '.js'), ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/sync', name + '.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText);
  fs.writeFileSync(path.join(code, 'reader.cjs'), `const fs=require('fs'),store=require('./generation-store.js'); let lease; try {lease=process.argv[3]==='CURRENT'?store.acquireCurrentGenerationLease(process.argv[2]):store.acquireGenerationLease(process.argv[2],process.argv[3]); process.send({id:lease.id,path:lease.databasePath});}catch(e){process.send({error:e.message});process.exitCode=1;} process.on('message',async m=>{if(m==='close'){lease.release();await store.collectRetiredGenerations(process.argv[2]);process.exit(0);}else if(m==='read'){process.send({value:fs.readFileSync(lease.databasePath,'utf8')});}});`);
  fs.writeFileSync(path.join(root, 'codegraph.db'), 'legacy');
  lock = new GenerationWriterLock(root); lock.acquire(); candidates = []; children = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) await stop(child, true);
  for (const c of candidates) cleanupGenerationCandidate(root, c);
  await collectRetiredGenerations(root);
  lock.release(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(code, { recursive: true, force: true });
});

describe('cross-process generation ownership and reclamation', () => {
  it('pins two independent reader processes; new readers see CURRENT; reclaims only after last old reader exits', async () => {
    const a = next(); await publish(a);
    const first = await reader(), second = await reader(); expect(first.result.id).toBe(a.id); expect(second.result.id).toBe(a.id);
    const b = next(); await publish(b); const newest = await reader(); expect(newest.result.id).toBe(b.id);
    first.child.send('read'); expect((await message(first.child)).value).toBe(a.id);
    restartGC(); expect(fs.existsSync(a.databasePath)).toBe(true);
    await stop(first.child); expect(fs.existsSync(a.databasePath)).toBe(true);
    await stop(second.child); expect(fs.existsSync(a.directory)).toBe(false);
    expect(fs.existsSync(b.databasePath)).toBe(true); expect(fs.readFileSync(path.join(root, 'codegraph.db'), 'utf8')).toBe('legacy');
  });
  it('reclaims a killed reader after restart without deleting or requiring takeover of the writer lock', async () => {
    const a = next(); await publish(a); const old = await reader(); const b = next(); await publish(b);
    await stop(old.child, true); expect(fs.existsSync(a.directory)).toBe(true);
    const lockContents = fs.readFileSync(lock.lockPath, 'utf8'); restartGC();
    expect(fs.existsSync(a.directory)).toBe(false); expect(fs.readFileSync(lock.lockPath, 'utf8')).toBe(lockContents);
  });
  it('protects an unpublished candidate until both parent and child build leases have closed', async () => {
    const candidate = next(); const worker = await reader(candidate.id);
    cleanupGenerationCandidate(root, candidate); restartGC(); expect(fs.existsSync(candidate.databasePath)).toBe(true);
    await stop(worker.child, true); restartGC(); expect(fs.existsSync(candidate.directory)).toBe(false);
    expect(resolveGeneration(root).id).toBeNull();
  });
  it('resumes a sealed partial deletion after restart and rejects exact-id acquisition', async () => {
    const a = next(); await publish(a); const lease = acquireCurrentGenerationLease(root);
    const b = next(); await publish(b);
    const unlink = fs.promises.unlink; vi.spyOn(fs.promises, 'unlink').mockImplementation(async file => { if (file === a.databasePath) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' }); return unlink(file); });
    lease.release(); await collectRetiredGenerations(root); expect(fs.existsSync(a.directory)).toBe(true);
    expect(() => acquireGenerationLease(root, a.id)).toThrow(/reclaimed|reclaim/);
    vi.restoreAllMocks(); restartGC(); expect(fs.existsSync(a.directory)).toBe(false);
  });
  it('never deletes unknown directories, custom files, or legacy databases', async () => {
    const unknown = path.join(root, 'generations', 'g-unknown'); fs.mkdirSync(unknown, { recursive: true }); fs.writeFileSync(path.join(unknown, 'codegraph.db'), 'unknown');
    const a = next(); await publish(a); fs.writeFileSync(path.join(a.directory, 'custom.data'), 'mine'); const b = next(); await publish(b);
    await collectRetiredGenerations(root); expect(fs.existsSync(a.directory)).toBe(true); expect(fs.existsSync(unknown)).toBe(true); expect(fs.existsSync(path.join(root, 'codegraph.db'))).toBe(true);
  });

  it('keeps a real child lease after its builder parent is killed, then reclaims on restart', async () => {
    lock.release();
    fs.writeFileSync(path.join(code, 'builder.cjs'), `const fs=require('fs'),s=require('./generation-store.js'); const root=process.argv[2],lock=new s.GenerationWriterLock(root);lock.acquire();const c=s.createGeneration(root,lock);fs.writeFileSync(c.databasePath,'building');process.send({id:c.id,directory:c.directory});process.on('message',()=>{});`);
    const builder = fork(path.join(code, 'builder.cjs'), [root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] }); children.push(builder);
    const candidate = await message(builder); const worker = await reader(candidate.id);
    await stop(builder, true); restartGC(); expect(fs.existsSync(candidate.directory)).toBe(true);
    await stop(worker.child, true); restartGC(); expect(fs.existsSync(candidate.directory)).toBe(false);
    expect(fs.existsSync(lock.lockPath)).toBe(true); expect(resolveGeneration(root).id).toBeNull();
  });
  it('cleans failed validation candidates without changing the usable previous generation', async () => {
    const a = next(); await publish(a); const lease = acquireCurrentGenerationLease(root);
    const failed = next();
    await expect(publishGeneration(root, failed, { lock, expectedPreviousId: a.id, success: true, complete: true, validate: () => false, sourceUnchanged: () => true })).rejects.toThrow(/validation/);
    cleanupGenerationCandidate(root, failed); await collectRetiredGenerations(root);
    expect(fs.existsSync(failed.directory)).toBe(false); expect(fs.readFileSync(lease.databasePath, 'utf8')).toBe(a.id); expect(resolveGeneration(root).id).toBe(a.id); lease.release();
  });
  it('includes the actual build-result artifact in managed cleanup', async () => {
    const a = next(); fs.writeFileSync(path.join(a.directory, 'build-result.json'), '{}'); await publish(a);
    const b = next(); await publish(b); await collectRetiredGenerations(root); expect(fs.existsSync(a.directory)).toBe(false);
  });
  it('refuses a symlink generations ancestor even with a valid registry and ownership token', async () => {
    if (process.platform === 'win32') return;
    const c = next(); c.buildLease!.release(); c.buildLease = undefined;
    const generations = path.join(root, 'generations'), outside = path.join(root, 'outside-generations');
    fs.renameSync(generations, outside); fs.symlinkSync(outside, generations);
    await collectRetiredGenerations(root); expect(fs.existsSync(path.join(outside, c.id, 'codegraph.db'))).toBe(true);
    fs.unlinkSync(generations); fs.renameSync(outside, generations);
  });
  it('resumes after a crash-equivalent empty sealed directory without reviving the ID', async () => {
    const a = next(); await publish(a); const lease = acquireCurrentGenerationLease(root); const b = next(); await publish(b);
    const rmdir = fs.promises.rmdir; vi.spyOn(fs.promises, 'rmdir').mockImplementation(async directory => { if (directory === a.directory) throw new Error('interrupted after marker deletion'); return rmdir(directory); });
    lease.release(); await collectRetiredGenerations(root); expect(fs.readdirSync(a.directory)).toEqual([]);
    vi.restoreAllMocks(); restartGC(); expect(fs.existsSync(a.directory)).toBe(false); expect(() => acquireGenerationLease(root, a.id)).toThrow(/reclaimed/);
  });


  it('does not publish when the asynchronous writable DB flush fails', async () => {
    const a = next(); await publish(a); const c = next();
    const open = fs.promises.open; let closed = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === c.databasePath) {
        vi.spyOn(handle, 'sync').mockRejectedValue(Object.assign(new Error('flush denied'), { code: 'EPERM' }));
        const close = handle.close.bind(handle); vi.spyOn(handle, 'close').mockImplementation(async () => { closed = true; await close(); });
      }
      return handle;
    });
    await expect(publish(c)).rejects.toThrow(/flush denied/); expect(closed).toBe(true); expect(resolveGeneration(root).id).toBe(a.id);
    cleanupGenerationCandidate(root, c); await collectRetiredGenerations(root); expect(fs.existsSync(c.directory)).toBe(false);
  });


  it('fails closed during a bounded cross-process gate conflict and recovers on the next acquisition', async () => {
    const a = next(); await publish(a);
    fs.writeFileSync(path.join(code, 'gate-holder.cjs'), `const fs=require('fs'),path=require('path'),{withLifecycleGate}=require('./generation-lifecycle.js');withLifecycleGate(process.argv[2],()=>{process.send({held:true});const until=Date.now()+5000;while(!fs.existsSync(path.join(process.argv[2],'release-test-gate'))&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);});process.disconnect();`);
    const holder = fork(path.join(code, 'gate-holder.cjs'), [root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] }); children.push(holder);
    const exit = new Promise<void>(resolve => holder.once('exit', () => resolve()));
    expect((await message(holder)).held).toBe(true);
    try {
      const started = performance.now(); expect(() => acquireCurrentGenerationLease(root)).toThrow();
      expect(performance.now() - started).toBeLessThan(150);
    } finally { fs.writeFileSync(path.join(root, 'release-test-gate'), 'release'); }
    await exit;
    const recovered = acquireCurrentGenerationLease(root); expect(recovered.id).toBe(a.id); recovered.release();
  });


  it('retains a crashed-worker lock artifact while any builder lease survives, then reclaims only that candidate lock', async () => {
    const c = next(); fs.writeFileSync(path.join(c.directory, 'codegraph.lock'), 'crashed candidate writer');
    const worker = await reader(c.id); const rootLock = fs.readFileSync(lock.lockPath, 'utf8');
    cleanupGenerationCandidate(root, c); await collectRetiredGenerations(root);
    expect(fs.existsSync(path.join(c.directory, 'codegraph.lock'))).toBe(true);
    await stop(worker.child, true); restartGC();
    expect(fs.existsSync(c.directory)).toBe(false); expect(fs.readFileSync(lock.lockPath, 'utf8')).toBe(rootLock);
  });


  it('drains scheduled asynchronous cleanup without expiring a still-held reader', async () => {
    const a = next(); await publish(a); const lease = acquireCurrentGenerationLease(root); const b = next(); await publish(b);
    await drainGenerationCollections(); expect(fs.existsSync(a.directory)).toBe(true);
    lease.release(); await drainGenerationCollections(); expect(fs.existsSync(a.directory)).toBe(false);
  });

  it('opens the candidate DB with writable non-truncating flags and flushes it asynchronously', async () => {
    const c = next(); const open = vi.spyOn(fs.promises, 'open'); await publish(c);
    expect(open).toHaveBeenCalledWith(c.databasePath, 'r+'); expect(fs.readFileSync(c.databasePath, 'utf8')).toBe(c.id);
  });
});
