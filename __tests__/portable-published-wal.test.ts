/** Published native databases must retain WAL reader/writer coexistence. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { CodeGraph as Graph } from '../src';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { DatabaseSync } = require('node:sqlite');

let root: string, previousExecArgv: string[];
const graphs: Graph[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-published-wal-'));
  previousExecArgv = process.execArgv;
  process.execArgv = ['--liftoff-only'];
  vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
  vi.stubEnv('CODEGRAPH_NO_FAST_INIT', '0');
});
afterEach(async () => {
  for (const graph of graphs.splice(0)) { await graph.whenIdle(); graph.close(); await graph.whenIdle(); }
  process.execArgv = previousExecArgv;
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function published(kind: 'initial' | 'rebuild'): Promise<Graph> {
  const count = kind === 'rebuild' ? 130 : 1;
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(root, `f${i}.c`), `int original_${i}(void) { return ${i}; }\n`);
  const graph = await CodeGraph.init(root, { index: true }); graphs.push(graph);
  if (kind === 'rebuild') {
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(root, `f${i}.c`), `int published_${i}(void) { return ${i + 1}; }\n`);
    const result = await graph.sync();
    expect(result.adaptive?.strategy).toBe('rebuild');
    expect(result.adaptive?.reason).toBe('structural-large-change');
    expect(result.complete).toBe(true);
  }
  return graph;
}
const oldName = (kind: 'initial' | 'rebuild') => kind === 'initial' ? 'original_0' : 'published_0';
const sqlCount = 'SELECT COUNT(*) AS n FROM nodes WHERE name = ?';
function changeSource() { fs.writeFileSync(path.join(root, 'f0.c'), 'int after_publication(void) { return 99; }\n'); }

it.each(['initial', 'rebuild'] as const)('%s publication supports indexAll while an SDK reader holds a real snapshot', async kind => {
  const graph = await published(kind);
  const reader = CodeGraph.openReadOnlySync(root); graphs.push(reader);
  const pin = reader.acquirePortableRead();
  const db = (pin.graph as any).db.getDb();
  db.exec('BEGIN');
  try {
    expect(db.prepare(sqlCount).get(oldName(kind)).n).toBe(1); // Materialize the SQLite read lock.
    expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
    changeSource();
    const result = await graph.indexAll();
    expect(result.success).toBe(true);
    expect(result.complete).toBe(true);
    // The writer committed without ending or invalidating the old reader.
    expect(db.prepare(sqlCount).get(oldName(kind)).n).toBe(1);
    expect(db.prepare(sqlCount).get('after_publication').n).toBe(0);
    expect(graph.searchNodes('after_publication').length).toBeGreaterThan(0);
  } finally { db.exec('COMMIT'); pin.release(); }
  expect(reader.searchNodes('after_publication').length).toBeGreaterThan(0);
}, 60_000);

function message(child: ChildProcess): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('SQLite reader IPC timed out')), 15_000);
    const onMessage = (value: any) => done(undefined, value);
    const onExit = (code: number | null, signal: string | null) => done(new Error(`SQLite reader exited: ${code}/${signal}`));
    const onError = (error: Error) => done(error);
    function done(error?: Error, value?: any) {
      clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError);
      error ? reject(error) : resolve(value);
    }
    child.once('message', onMessage); child.once('exit', onExit); child.once('error', onError);
  });
}

it.each(['initial', 'rebuild'] as const)('%s publication supports indexAll with an independent process read transaction', async kind => {
  const graph = await published(kind);
  const file = graph.getDatabaseFilePath();
  // Deliberately use a native read-only SQLite client: an external/older reader
  // must not rely on the current SDK silently switching the database to WAL.
  const child = spawn(process.execPath, ['--liftoff-only', '-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const old = process.argv[2];
    const count = name => db.prepare(${JSON.stringify(sqlCount)}).get(name).n;
    const state = () => ({ old: count(old), fresh: count('after_publication') });
    db.exec('BEGIN');
    process.send({ ...state(), mode: db.prepare('PRAGMA journal_mode').get().journal_mode });
    process.on('message', action => {
      if (action === 'snapshot') process.send(state());
      if (action === 'commit') { db.exec('COMMIT'); process.send(state()); }
      if (action === 'close') { db.close(); process.disconnect(); }
    });
  `, file, oldName(kind)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', chunk => { errors += chunk; });
  try {
    expect(await message(child), errors).toEqual({ old: 1, fresh: 0, mode: 'wal' });
    changeSource();
    expect((await graph.indexAll()).success).toBe(true);
    const snapshot = message(child); child.send('snapshot');
    expect(await snapshot).toEqual({ old: 1, fresh: 0 });
    const committed = message(child); child.send('commit');
    expect(await committed).toEqual({ old: 0, fresh: 1 });
    expect(graph.searchNodes('after_publication').length).toBeGreaterThan(0);
    const inspect = new DatabaseSync(file, { readOnly: true });
    try { expect(inspect.prepare('PRAGMA quick_check').get().quick_check).toBe('ok'); }
    finally { inspect.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill(), 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        if (child.connected) child.send('close'); else child.kill();
      });
    }
  }
}, 60_000);
