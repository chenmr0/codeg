import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CodeGraph as Graph, SyncOptions } from '../src';

const { CodeGraph } = require('../dist') as typeof import('../src');
const { DatabaseConnection } = require('../dist/db') as typeof import('../src/db');
const { MCPEngine } = require('../dist/mcp/engine') as typeof import('../src/mcp/engine');
const { createDirectory, getCodeGraphDir } = require('../dist/directory') as typeof import('../src/directory');
const { GenerationWriterLock, createGeneration, publishInitialGeneration, cleanupGenerationCandidate,
  drainGenerationCollections, resolveGeneration } = require('../dist/sync/generation-store') as typeof import('../src/sync/generation-store');
const controller = require('../dist/sync/rebuild-controller') as typeof import('../src/sync/rebuild-controller');
const { DatabaseSync } = require('node:sqlite');
const cli = path.resolve(__dirname, '../dist/bin/codegraph.js');

let root: string;
let argv: string[];
const graphs: Graph[] = [];
const engines: InstanceType<typeof MCPEngine>[] = [];
const small = { rules: { fileScale: { minChangedFiles: 1 }, oldNodeScale: { enabled: false } } };
function configure(adaptive: object | string) {
  fs.writeFileSync(path.join(root, '.codegraphrc.json'),
    typeof adaptive === 'string' ? adaptive : JSON.stringify({ sync: { adaptive } }));
}
function edit(name = 'changed_symbol') {
  fs.writeFileSync(path.join(root, 'main.c'), `int ${name}(void) { return 12345; }\n`);
}
function keep(graph: Graph) { graphs.push(graph); return graph; }
function identity(graph: Graph): string {
  if (!graph.isPortableStorage()) return resolveGeneration(graph.getDataDirectory()).id!;
  const db = new DatabaseSync(graph.getDatabaseFilePath(), { readOnly: true });
  try { return db.prepare("SELECT value FROM project_metadata WHERE key='portable:database-id-v1'").get().value; }
  finally { db.close(); }
}
async function fixture(generation = false): Promise<Graph> {
  if (!generation) return keep(await CodeGraph.init(root, { index: true }));
  createDirectory(root);
  const dataDir = getCodeGraphDir(root), lock = new GenerationWriterLock(dataDir);
  lock.acquire();
  const candidate = createGeneration(dataDir, lock);
  try {
    const builder = await CodeGraph.createShadow(root, candidate.databasePath);
    try { expect((await builder.indexAll()).complete).toBe(true); }
    finally { builder.close(); await builder.whenIdle(); }
    await publishInitialGeneration(dataDir, candidate, { lock, validate: () => true });
  } finally { cleanupGenerationCandidate(dataDir, candidate); lock.release(); }
  return keep(CodeGraph.openSync(root));
}
function invoke(...args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--liftoff-only', cli, ...args], {
      cwd: root, env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI timeout: ' + stderr)); }, 30000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

beforeEach(() => {
  argv = process.execArgv; process.execArgv = ['--liftoff-only'];
  vi.stubEnv('NODE_OPTIONS', '');
  vi.stubEnv('CODEGRAPH_ADAPTIVE_SYNC', undefined);
  vi.stubEnv('CODEGRAPH_NO_WATCH', undefined);
  vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '0');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-policy-e2e-'));
  fs.writeFileSync(path.join(root, 'main.c'), 'int original(void) { return 1; }\n');
  fs.writeFileSync(path.join(root, 'other.c'), 'int other(void) { return 2; }\n');
});
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stopAndDrain();
  for (const graph of graphs.splice(0)) {
    graph.unwatch(); await graph.whenIdle(); graph.close(); await graph.whenIdle();
  }
  await drainGenerationCollections();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); process.execArgv = argv;
  fs.rmSync(root, { recursive: true, force: true });
});

it.each([false, true])('SDK reads project rules and leaves old history untouched (CURRENT=%s)', async generation => {
  const graph = await fixture(generation);
  configure(small);
  const history = path.join(graph.getDataDirectory(), 'adaptive-cost-history.json');
  let previous = identity(graph);
  for (const [i, contents] of [undefined, '{broken', '{"version":1,"samples":[{"kind":"full","durationMs":1}]}'].entries()) {
    if (contents !== undefined) fs.writeFileSync(history, contents);
    edit('history_ignored_' + i);
    const result = await graph.sync();
    expect(result).toMatchObject({ complete: true, adaptive: { strategy: 'rebuild', reason: 'structural-large-change' } });
    expect(identity(graph)).not.toBe(previous);
    previous = identity(graph);
    expect(graph.getNodesByName('history_ignored_' + i)).toHaveLength(1);
    if (contents === undefined) expect(fs.existsSync(history)).toBe(false);
    else expect(fs.readFileSync(history, 'utf8')).toBe(contents);
  }
}, 90000);

it('built CLI inherits the project threshold and queries the published database', async () => {
  const graph = await fixture(), before = identity(graph);
  graph.close(); await graph.whenIdle();
  configure(small); edit();
  const result = await invoke('sync', root, '-v');
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stdout + result.stderr).toContain('structural-large-change');
  const reopened = keep(CodeGraph.openReadOnlySync(root));
  expect(identity(reopened)).not.toBe(before);
  expect(reopened.getNodesByName('changed_symbol')).toHaveLength(1);
  const query = await invoke('query', 'changed_symbol', '--path', root, '--json');
  expect(query.code, query.stderr).toBe(0);
  expect(query.stdout).toContain('changed_symbol');
}, 60000);

it.each(['disabled', 'invalid'] as const)('keeps a healthy empty sync read-only with %s project configuration', async mode => {
  const graph = await fixture();
  await graph.sync();
  configure(mode === 'disabled' ? { enabled: false } : '{broken');
  const writer = vi.spyOn(DatabaseConnection, 'open');
  const planner = vi.spyOn(controller, 'runAdaptiveReadWorker');
  const before = identity(graph);
  expect(await graph.sync()).toMatchObject({ complete: true, filesAdded: 0, filesModified: 0, filesRemoved: 0 });
  expect(writer).not.toHaveBeenCalled();
  expect(planner).not.toHaveBeenCalled();
  expect(identity(graph)).toBe(before);
  expect(graph.getFiles()).toHaveLength(2);
});

it('SDK rule and threshold overrides compose without reenabling a disabled rule', async () => {
  const graph = await fixture();
  configure({ enabled: false, rules: { fileScale: { enabled: false }, oldNodeScale: { enabled: false } } });
  const before = identity(graph);
  edit();
  expect((await graph.sync({ adaptive: true, adaptiveFallback: { minChangedFiles: 1 } })).filesModified).toBe(1);
  expect(identity(graph)).toBe(before);
  edit('sdk_enabled_symbol');
  const result = await graph.sync({
    adaptive: true, adaptiveFallback: { minChangedFiles: 1 },
    adaptiveRules: { fileScale: true, oldNodeScale: false },
  });
  expect(result.adaptive?.strategy).toBe('rebuild');
  expect(identity(graph)).not.toBe(before);
}, 30000);

it.each(['environment', 'internal', 'invalid'] as const)('honors %s disabling over permissive SDK settings', async mode => {
  const graph = await fixture(), before = identity(graph);
  configure(mode === 'invalid' ? '{broken' : small);
  if (mode === 'environment') vi.stubEnv('CODEGRAPH_ADAPTIVE_SYNC', '0');
  edit();
  const options: SyncOptions = { adaptive: mode !== 'internal', adaptiveFallback: { minChangedFiles: 1 },
    adaptiveRules: { fileScale: true, oldNodeScale: true } };
  expect(await graph.sync(options)).toMatchObject({ complete: true, filesModified: 1 });
  expect(identity(graph)).toBe(before);
  expect(graph.getNodesByName('changed_symbol')).toHaveLength(1);
});

it('carries the admitted policy through publisher IPC and reloads edits on the next sync', async () => {
  const graph = await fixture(), before = identity(graph);
  configure(small); edit();
  let changedPolicy = false;
  const result = await graph.sync({ onAdaptiveDecision(decision) {
    if (decision.strategy === 'rebuild') {
      changedPolicy = true;
      configure({ enabled: false });
    }
  } });
  expect(changedPolicy).toBe(true);
  expect(result.adaptive?.strategy).toBe('rebuild');
  const published = identity(graph);
  expect(published).not.toBe(before);
  edit('next_sync_incremental');
  expect(await graph.sync()).toMatchObject({ complete: true, filesModified: 1 });
  expect(identity(graph)).toBe(published);
  expect(graph.getNodesByName('next_sync_incremental')).toHaveLength(1);
}, 30000);

it('MCP startup catch-up uses project configuration before a public tool query', async () => {
  const graph = await fixture(), before = identity(graph);
  graph.close(); await graph.whenIdle();
  configure(small); edit('mcp_configured_symbol');
  vi.stubEnv('CODEGRAPH_MCP_CATCHUP_BUDGET_MS', '30000');
  const engine = new MCPEngine({ watch: false }); engines.push(engine);
  await engine.ensureInitialized(root);
  const response = await engine.getToolHandler().execute('search', { query: 'mcp_configured_symbol', limit: 5 });
  const text = response.content.map(item => item.text ?? '').join('\n');
  expect(response.isError, text).toBeFalsy();
  expect(text).toContain('### mcp_configured_symbol (');
  const reader = keep(CodeGraph.openReadOnlySync(root));
  expect(identity(reader)).not.toBe(before);
}, 60000);

it('the native watcher reloads project rules on successive source events', async () => {
  const graph = await fixture();
  configure(small);
  let completed: ((value: { filesChanged: number; durationMs: number }) => void) | undefined;
  let failed: ((error: Error) => void) | undefined;
  expect(graph.watch({
    debounceMs: 50,
    onSyncComplete(value) { if (value.filesChanged) completed?.(value); },
    onSyncError(error) { failed?.(error); },
  })).toBe(true);
  await graph.waitUntilWatcherReady();
  const change = async (name: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const done = new Promise<{ filesChanged: number; durationMs: number }>((resolve, reject) => {
        completed = resolve; failed = reject;
        timer = setTimeout(() => reject(new Error('Native watcher did not complete the source event')), 15000);
      });
      edit(name);
      expect((await done).filesChanged).toBe(1);
      await graph.whenIdle();
    } finally { clearTimeout(timer); completed = undefined; failed = undefined; }
  };
  const before = identity(graph);
  await change('watcher_rebuilt_symbol');
  const published = identity(graph);
  expect(published).not.toBe(before);
  configure({ enabled: false });
  await change('watcher_incremental_symbol');
  expect(identity(graph)).toBe(published);
  expect(graph.getNodesByName('watcher_incremental_symbol')).toHaveLength(1);
}, 60000);
