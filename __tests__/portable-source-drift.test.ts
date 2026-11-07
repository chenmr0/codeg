import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CodeGraph as Graph } from '../src';

const { CodeGraph } = require('../dist') as typeof import('../src');
const publisher = require('../dist/sync/portable/publisher-client') as typeof import('../src/sync/portable/publisher-client');
const { DATABASE_ID } = require('../dist/sync/portable/metadata') as typeof import('../src/sync/portable/metadata');
const { DatabaseSync } = require('node:sqlite');
let root: string;
let graph: Graph;
let previousArgv: string[];

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=test@localhost',
    '-c', 'commit.gpgSign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
}
function write(file: string, contents: string): void {
  fs.writeFileSync(path.join(root, file), contents);
}
function symbol(file: string, name: string): void {
  write(file, `export function ${name}() { return 1; }\n`);
}
function alias(target: string): void {
  write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@target': [target] } } }));
}
function targetPaths(): string[] {
  const caller = graph.getNodesByName('caller')[0]!;
  return graph.getCallees(caller.id).filter(callee => callee.node.name === 'target').map(callee => callee.node.filePath);
}
function storedId(): string {
  const db = new DatabaseSync(graph.getDatabaseFilePath(), { readOnly: true });
  try {
    const id = db.prepare('SELECT value FROM project_metadata WHERE key=?').get(DATABASE_ID)?.value;
    expect(typeof id).toBe('string');
    return id;
  } finally { db.close(); }
}

beforeEach(async () => {
  previousArgv = process.execArgv;
  process.execArgv = ['--liftoff-only'];
  vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-portable-source-drift-'));
  git('init', '--quiet', '-b', 'planned');
  git('config', 'core.autocrlf', 'false');
  write('.gitignore', '.codegraph*/\n');
  symbol('a.ts', 'target');
  symbol('b.ts', 'target');
  write('use.ts', 'import { target } from "@target"; export function caller() { return target(); }\n');
  alias('a.ts');
  symbol('main.ts', 'original');
  symbol('remove.ts', 'removed');
  symbol('old-path.ts', 'renamed');
  symbol('swap.ts', 'previous_file');
  symbol('excluded.ts', 'excluded');
  write('urls.py', 'def view(request): return None\nurlpatterns = [path("orders/", view)]\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'initial');
  graph = await CodeGraph.init(root, { index: true });
  expect(targetPaths()).toContain('a.ts');

  symbol('main.ts', 'trigger_candidate');
  git('commit', '--quiet', '-am', 'trigger rebuild');
  git('switch', '--quiet', '-c', 'latest');
  git('mv', 'old-path.ts', 'new-path.ts');
  git('rm', '--quiet', 'remove.ts');
  git('rm', '--quiet', 'swap.ts');
  fs.mkdirSync(path.join(root, 'swap.ts'));
  symbol('swap.ts/nested.ts', 'nested_symbol');
  symbol('main.ts', 'final_symbol');
  symbol('added.ts', 'added');
  write('.codegraphignore', 'excluded.ts\n');
  alias('b.ts');
  git('add', '.');
  git('commit', '--quiet', '-m', 'change source and index configuration');
  git('switch', '--quiet', 'planned');
  const preload = path.resolve(__dirname, 'fixtures/checkout-during-portable-build.cjs').split(path.sep).join('/');
  vi.stubEnv('NODE_OPTIONS', `--require="${preload}"`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (graph) { graph.close(); await graph.whenIdle(); }
  process.execArgv = previousArgv;
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it.each([false, true])('publishes through a branch switch and repairs the new database (interrupt after publication=%s)', async interrupt => {
  const oldId = storedId();
  const abort = new AbortController();
  if (interrupt) {
    vi.stubEnv('TEST_CHECKOUT_AFTER_RESOLUTION', '1');
    const run = publisher.runPortableRebuild;
    vi.spyOn(publisher, 'runPortableRebuild').mockImplementationOnce(async (...args) => {
      const result = await run(...args);
      abort.abort();
      return result;
    });
  }
  const rebuilding = graph.sync({ signal: abort.signal,
    adaptiveFallback: { minChangedFiles: 1, minChangedFraction: 0.01, minWorkFraction: 0.01 } });
  if (interrupt) {
    await expect(rebuilding).rejects.toThrow(/abort/i);
    graph.close();
    await graph.whenIdle();
    graph = await CodeGraph.open(root);
    expect(storedId()).not.toBe(oldId);
    expect(graph.getPortableCatchup()).toBeTruthy();
    expect(graph.getNodesByName('trigger_candidate')[0]?.filePath).toBe('main.ts');
    expect(targetPaths()).toEqual(['a.ts']);
    expect((await graph.sync({ adaptive: false, paths: ['main.ts'] })).complete).toBe(true);
  } else {
    const result = await rebuilding;
    expect(result.complete).toBe(true);
    expect(result.adaptive?.strategy, result.adaptive?.reason).toBe('rebuild');
  }
  expect(git('branch', '--show-current')).toBe('latest');
  const newId = storedId();
  expect(newId).not.toBe(oldId);
  expect(graph.getPortableCatchup()).toBeNull();
  expect(graph.getIndexCompleteness().status).toBe('complete');
  expect(graph.getFiles().map(file => file.path).filter(file => file.endsWith('.ts')).sort())
    .toEqual(['a.ts', 'added.ts', 'b.ts', 'main.ts', 'new-path.ts', 'swap.ts/nested.ts', 'use.ts']);
  for (const missing of ['removed', 'original', 'trigger_candidate', 'previous_file', 'excluded']) {
    expect(graph.getNodesByName(missing)).toHaveLength(0);
  }
  expect(graph.getNodesByName('final_symbol')[0]?.filePath).toBe('main.ts');
  expect(graph.getNodesByName('added')[0]?.filePath).toBe('added.ts');
  expect(graph.getNodesByName('renamed')[0]?.filePath).toBe('new-path.ts');
  expect(graph.getNodesByName('nested_symbol')[0]?.filePath).toBe('swap.ts/nested.ts');
  expect(targetPaths()).toEqual(['b.ts']);
  expect(await graph.sync()).toMatchObject({ complete: true, filesAdded: 0, filesModified: 0, filesRemoved: 0 });
  expect(storedId()).toBe(newId);
}, 60_000);

it('updates routes in unchanged Python files when the new branch enables Django', async () => {
  const routes = () => graph.getNodesInFile('urls.py').filter(node => node.kind === 'route').map(node => node.name);
  expect(routes()).not.toContain('orders/');
  git('switch', '--quiet', '-c', 'framework-only');
  write('manage.py', 'def manage(): pass\n');
  git('add', 'manage.py');
  git('commit', '--quiet', '-m', 'enable Django through its entry point');
  git('switch', '--quiet', 'planned');
  vi.stubEnv('TEST_CHECKOUT_TARGET', 'framework-only');
  const oldId = storedId();
  const result = await graph.sync({ adaptiveFallback: { minChangedFiles: 1, minChangedFraction: 0.01, minWorkFraction: 0.01 } });
  expect(result.complete).toBe(true);
  expect(result.adaptive?.strategy).toBe('rebuild');
  expect(storedId()).not.toBe(oldId);
  expect(routes()).toContain('orders/');
  expect(graph.getPortableCatchup()).toBeNull();
}, 60_000);
