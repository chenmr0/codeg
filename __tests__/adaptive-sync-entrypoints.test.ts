/** Built CLI and real OS watcher acceptance. Artificial history selects a
 * functional path only; it is not a benchmark or a production calibration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import type { CodeGraph as Graph } from '../src';
import type { AdaptiveCostHistory, AdaptiveCostSample } from '../src/sync/adaptive-plan';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { getCodeGraphDir } = require('../dist/directory') as typeof import('../src/directory');
const { adaptiveRuntimeKey, createAdaptivePlan, chooseAdaptiveStrategy } =
  require('../dist/sync/adaptive-plan') as typeof import('../src/sync/adaptive-plan');
const { PortableCoordinator } = require('../dist/sync/portable/protocol') as typeof import('../src/sync/portable/protocol');
const { DatabaseSync } = require('node:sqlite');
function databaseIdentity(): string {
  const db = new DatabaseSync(path.join(getCodeGraphDir(root), 'codegraph.db'), { readOnly: true });
  try { const id = db.prepare("SELECT value FROM project_metadata WHERE key='portable:database-id-v1'").get()?.value;
    expect(typeof id).toBe('string'); return id; } finally { db.close(); }
}
const cli = path.resolve(__dirname, '../dist/bin/codegraph.js');
let root: string;
let graph: Graph;
const readers: Graph[] = [];
let argv: string[];
let nodeOptions: string | undefined;
let noWatch: string | undefined;
beforeEach(async () => {
  argv = process.execArgv; process.execArgv = ['--liftoff-only'];
  nodeOptions = process.env.NODE_OPTIONS; delete process.env.NODE_OPTIONS;
  noWatch = process.env.CODEGRAPH_NO_WATCH; delete process.env.CODEGRAPH_NO_WATCH;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-adaptive-entry-'));
  fs.writeFileSync(path.join(root, 'main.cpp'), 'int entry_original_symbol() { return 1; }\n');
  graph = await CodeGraph.init(root, { index: true });
});
afterEach(async () => {
  graph?.unwatch(); graph?.close(); await graph?.whenIdle();
  for (const reader of readers.splice(0)) { reader.close(); await reader.whenIdle(); }
  process.execArgv = argv;
  if (nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = nodeOptions;
  if (noWatch === undefined) delete process.env.CODEGRAPH_NO_WATCH; else process.env.CODEGRAPH_NO_WATCH = noWatch;
  fs.rmSync(root, { recursive: true, force: true });
});
async function prepareSyntheticRebuild(): Promise<void> {
  fs.writeFileSync(path.join(root, 'main.cpp'), 'int entry_rebuilt_symbol() { return 222; }\n');
  const plan = await createAdaptivePlan(root, graph.getFiles(), { runtimeKey: adaptiveRuntimeKey(root, graph.getBackend()) });
  const sample: AdaptiveCostSample = { kind: 'incremental', runtimeKey: plan.runtimeKey,
    configFingerprint: plan.snapshot.configFingerprint, semanticConfigFingerprint: plan.snapshot.semanticConfigFingerprint, totalFiles: plan.totalFiles, totalBytes: plan.totalBytes,
    totalNodes: plan.totalNodes, durationMs: 100_000, changedFiles: plan.changedFiles,
    affectedOldNodes: plan.affectedOldNodes, changedBytes: plan.changedBytes,
    addedFiles: plan.added.length, modifiedFiles: plan.modified.length, removedFiles: plan.removed.length,
    shape: plan.shape, recordedAt: Date.now() };
  const history: AdaptiveCostHistory = { version: 1,
    samples: [{ ...sample, kind: 'full', durationMs: 1_000 }, sample, { ...sample }, { ...sample }] };
  expect(chooseAdaptiveStrategy(plan, history).strategy).toBe('rebuild');
  graph.setPortableCostHistory(JSON.stringify(history));
  await graph.whenIdle();
}
function queryNames(reader: Graph, query: string): string[] { return reader.searchNodes(query).map(row => row.node.name); }

describe('adaptive sync production entry points', () => {
  it('built CLI sync replaces the fixed root and built CLI status/query read the new database', async () => {
    const old = CodeGraph.openReadOnlySync(root); readers.push(old);
    const oldIdentity = databaseIdentity();
    expect(queryNames(old, 'entry_original_symbol')).toContain('entry_original_symbol');
    await prepareSyntheticRebuild();
    graph.close(); await graph.whenIdle();
    // Keep the parent event loop available so its idle reader can honor draining.
    const invoke = (...args: string[]) => new Promise<{status:number|null;stdout:string;stderr:string;error?:Error}>(resolve => {
      const child = spawn(process.execPath, ['--liftoff-only', cli, ...args], {cwd:root,env:{...process.env},stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='',error:Error|undefined;
      const timer=setTimeout(()=>{error=new Error('CLI timeout');child.kill('SIGKILL');},30000);
      child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
      child.on('error',value=>{error=value;});child.on('close',status=>{clearTimeout(timer);resolve({status,stdout,stderr,error});});
    });
    const sync = await invoke('sync', root, '--quiet');
    expect(sync.error).toBeUndefined();
    expect(sync.status, sync.stderr + sync.stdout).toBe(0);
    expect(databaseIdentity()).not.toBe(oldIdentity);
    expect(fs.existsSync(path.join(getCodeGraphDir(root), 'CURRENT'))).toBe(false);
    expect(fs.existsSync(path.join(getCodeGraphDir(root), 'codegraph.db'))).toBe(true);
    const status = await invoke('status', root, '--json');
    expect(status.status, status.stderr).toBe(0);
    const report = JSON.parse(status.stdout);
    expect(report.initialized).toBe(true);
    expect(report.index.completeness).toBe('complete');
    expect(report.fileCount).toBe(1);
    expect(report.pendingChanges).toEqual({ added: 0, modified: 0, removed: 0 });
    const query = await invoke('query', 'entry_rebuilt_symbol', '--path', root, '--json');
    expect(query.status, query.stderr).toBe(0);
    expect(query.stdout).toContain('entry_rebuilt_symbol');
    expect(queryNames(old, 'entry_original_symbol')).not.toContain('entry_original_symbol');
    expect(queryNames(old, 'entry_rebuilt_symbol')).toContain('entry_rebuilt_symbol');
  }, 60_000);

  it('real native watcher updates the fixed database and refreshes an already-open reader', async () => {
    const old = CodeGraph.openReadOnlySync(root); readers.push(old);
    await prepareSyntheticRebuild();
    const oldIdentity = databaseIdentity();
    const rebuilt = await graph.sync();
    expect(rebuilt.complete).toBe(true);
    expect(rebuilt.adaptive?.strategy).toBe('rebuild');
    const identity = databaseIdentity();
    expect(identity).not.toBe(oldIdentity);
    expect(queryNames(old, 'entry_rebuilt_symbol')).toContain('entry_rebuilt_symbol');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveSync!: (value: { filesChanged: number; durationMs: number }) => void;
    let rejectSync!: (error: Error) => void;
    const completed = new Promise<{ filesChanged: number; durationMs: number }>((resolve, reject) => {
      resolveSync = resolve; rejectSync = reject;
      timer = setTimeout(() => reject(new Error('native watcher did not sync within 10 seconds')), 10_000);
    });
    try {
      expect(graph.watch({ debounceMs: 50, onSyncComplete: resolveSync, onSyncError: rejectSync })).toBe(true);
      await graph.waitUntilWatcherReady();
      // Actual fs.writeFile event, no synthetic watcher event injection.
      fs.writeFileSync(path.join(root, 'main.cpp'), 'int native_watcher_updated_symbol() { return 33333; }\n');
      const result = await completed;
      expect(result.filesChanged).toBeGreaterThan(0);
      expect(queryNames(graph, 'native_watcher_updated_symbol')).toContain('native_watcher_updated_symbol');
      expect(queryNames(old, 'entry_original_symbol')).not.toContain('entry_original_symbol');
      expect(queryNames(old, 'native_watcher_updated_symbol')).toContain('native_watcher_updated_symbol');
      expect(databaseIdentity()).toBe(identity);
      await graph.whenIdle();
      const lease = new PortableCoordinator(getCodeGraphDir(root)).acquireWriter(); lease.release();
      const log = fs.readFileSync(path.join(getCodeGraphDir(root), '.runtime', 'adaptive-sync.log'), 'utf8');
      expect(log).toContain('incremental');
      expect(log).not.toContain('scoped-watcher-sync');
    } finally { if (timer) clearTimeout(timer); graph.unwatch(); }
  }, 30_000);
});
