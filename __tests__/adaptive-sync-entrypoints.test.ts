import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import type { CodeGraph as Graph } from '../src';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { getCodeGraphDir } = require('../dist/directory') as typeof import('../src/directory');
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
beforeEach(async context => {
  argv = process.execArgv; process.execArgv = ['--liftoff-only'];
  nodeOptions = process.env.NODE_OPTIONS; delete process.env.NODE_OPTIONS;
  noWatch = process.env.CODEGRAPH_NO_WATCH; delete process.env.CODEGRAPH_NO_WATCH;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-adaptive-entry-'));
  fs.writeFileSync(path.join(root, 'main.cpp'), 'int entry_original_symbol() { return 1; }\n');
  if (context.task.name.startsWith('built CLI')) {
    // Same on-disk ownership layout as an interrupted pre-upgrade portable sync.
    const { DatabaseConnection } = require('../dist/db');
    const { installSourceOwnership, beginSourceWrite } = require('../dist/sync/source-ownership');
    const dataDir = getCodeGraphDir(root);
    fs.mkdirSync(dataDir);
    const old = DatabaseConnection.initialize(path.join(dataDir, 'codegraph.db'));
    try {
      expect(installSourceOwnership(old.getDb())).toBe(true);
      expect(beginSourceWrite(old.getDb())).not.toBeNull();
    } finally { old.close(); await old.whenIdle(); }
    graph = await CodeGraph.open(root);
    expect((await graph.indexAll()).complete).toBe(true);
    const db = new DatabaseSync(graph.getDatabaseFilePath(), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'adaptive_owner_*'").get().n).toBe(18);
      expect(db.prepare("SELECT value FROM project_metadata WHERE key='adaptive:source-owner-v1'").get()).toBeUndefined();
    } finally { db.close(); }
  } else {
    graph = await CodeGraph.init(root, { index: true });
  }
});
afterEach(async () => {
  graph?.unwatch(); graph?.close(); await graph?.whenIdle();
  for (const reader of readers.splice(0)) { reader.close(); await reader.whenIdle(); }
  process.execArgv = argv;
  if (nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = nodeOptions;
  if (noWatch === undefined) delete process.env.CODEGRAPH_NO_WATCH; else process.env.CODEGRAPH_NO_WATCH = noWatch;
  fs.rmSync(root, { recursive: true, force: true });
});
function prepareLargeChange(): void {
  fs.writeFileSync(path.join(root, 'main.cpp'), 'int entry_rebuilt_symbol() { return 222; }\n');
  for (let i = 0; i < 127; i++) {
    fs.writeFileSync(path.join(root, 'added_' + i + '.c'), 'int added_' + i + '(void) { return 1; }\n');
  }
}
function queryNames(reader: Graph, query: string): string[] { return reader.searchNodes(query).map(row => row.node.name); }

describe('adaptive sync production entry points', () => {
  it('built CLI sync replaces the fixed root and built CLI status/query read the new database', async () => {
    const old = CodeGraph.openReadOnlySync(root); readers.push(old);
    const oldIdentity = databaseIdentity();
    expect(queryNames(old, 'entry_original_symbol')).toContain('entry_original_symbol');
    prepareLargeChange();
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
    expect(report.fileCount).toBe(128);
    expect(report.pendingChanges).toEqual({ added: 0, modified: 0, removed: 0 });
    const query = await invoke('query', 'entry_rebuilt_symbol', '--path', root, '--json');
    expect(query.status, query.stderr).toBe(0);
    expect(query.stdout).toContain('entry_rebuilt_symbol');
    expect(queryNames(old, 'entry_original_symbol')).not.toContain('entry_original_symbol');
    expect(queryNames(old, 'entry_rebuilt_symbol')).toContain('entry_rebuilt_symbol');
  }, 60_000);

  it('real native watcher updates the fixed database and refreshes an already-open reader', async () => {
    const old = CodeGraph.openReadOnlySync(root); readers.push(old);
    prepareLargeChange();
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
