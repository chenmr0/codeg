import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CodeGraph as Graph } from '../src';

const { CodeGraph } = require('../dist') as typeof import('../src');
const publisher = require('../dist/sync/portable/publisher-client') as typeof import('../src/sync/portable/publisher-client');
const { DatabaseSync } = require('node:sqlite');
const { DATABASE_ID, PUBLICATION_MACROS } = require('../dist/sync/portable/metadata');
const roots: string[] = [];
const graphs = new Set<Graph>();
const previousArgv = process.execArgv;

function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-macro-drift-'));
  roots.push(dir);
  return dir;
}

function keep(graph: Graph): Graph {
  graphs.add(graph);
  return graph;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=test@localhost',
    '-c', 'commit.gpgSign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
}

function metadata(graph: Graph, key: string): string | null {
  const db = new DatabaseSync(graph.getDatabaseFilePath(), { readOnly: true });
  try { return db.prepare('SELECT value FROM project_metadata WHERE key=?').get(key)?.value ?? null; }
  finally { db.close(); }
}

function consumerGraph(graph: Graph) {
  const nodes = graph.getNodesInFile('consumer.cpp');
  const record = nodes.find(node => node.kind === 'struct' && node.name === 'Record')!;
  return {
    symbols: nodes.map(node => node.kind + ' ' + node.qualifiedName).sort(),
    members: graph.getChildren(record.id).map(child => child.qualifiedName).sort(),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const graph of graphs) { graph.close(); await graph.whenIdle(); }
  graphs.clear();
  process.execArgv = previousArgv;
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each(['definition', 'comment', 'reverted during repair'] as const)('reconciles a macro header %s change after the candidate macro scan', async change => {
  process.execArgv = ['--liftoff-only'];
  const root = directory();
  const header = 'declarations.ipp';
  const original = '#define DECLARE_RECORD(Name) struct Name { int original_field; };\n';
  const latest = change === 'comment'
    ? original + '// Documentation changed without changing the macro.\n'
    : original.replace('original_field', 'updated_field');
  git(root, 'init', '--quiet', '-b', 'planned');
  git(root, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, header), original);
  fs.writeFileSync(path.join(root, 'consumer.cpp'), 'DECLARE_RECORD(Record)\n');
  fs.writeFileSync(path.join(root, 'trigger.cpp'), 'int original_trigger() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'independent.py'), 'def unrelated(): return 1\n');
  fs.writeFileSync(path.join(root, 'editing.py'), 'def earlier(): return 2\n');
  const sources = [header, 'consumer.cpp', 'trigger.cpp', 'independent.py', 'editing.py'];
  git(root, 'add', ...sources);
  git(root, 'commit', '--quiet', '-m', 'initial');
  let graph = keep(await CodeGraph.init(root, { index: true }));
  const oldId = metadata(graph, DATABASE_ID);
  expect(oldId).toBeTruthy();
  expect(graph.getNodesByName('original_field')).toContainEqual(
    expect.objectContaining({ kind: 'field', filePath: 'consumer.cpp' }));

  fs.writeFileSync(path.join(root, 'trigger.cpp'), 'int rebuilt_trigger() { return 123456; }\n');
  git(root, 'commit', '--quiet', '-am', 'trigger rebuild');
  git(root, 'switch', '--quiet', '-c', 'latest');
  fs.writeFileSync(path.join(root, header), latest);
  git(root, 'commit', '--quiet', '-am', 'edit header');
  git(root, 'switch', '--quiet', 'planned');

  // The hook checks out latest inside the publisher, once the parser has captured
  // the global macros and before it reads even the first source file.
  const preload = path.resolve(__dirname, 'fixtures/checkout-during-portable-build.cjs').split(path.sep).join('/');
  vi.stubEnv('NODE_OPTIONS', `--require="${preload}"`);
  const abort = new AbortController();
  const publish = publisher.runPortableRebuild;
  vi.spyOn(publisher, 'runPortableRebuild').mockImplementationOnce(async (...args) => {
    const result = await publish(...args);
    abort.abort();
    return result;
  });
  await expect(graph.sync({ signal: abort.signal,
    adaptiveFallback: { minChangedFiles: 1, minChangedFraction: 0.01, minWorkFraction: 0.01 },
  })).rejects.toThrow(/abort/i);
  graph.close(); await graph.whenIdle(); graphs.delete(graph);
  graph = keep(await CodeGraph.open(root));
  const publishedId = metadata(graph, DATABASE_ID);
  expect(publishedId).toBeTruthy();
  expect(publishedId).not.toBe(oldId);
  expect(graph.getPortableCatchup()).toBeTruthy();
  expect(metadata(graph, PUBLICATION_MACROS)).toBeTruthy();
  expect(git(root, 'branch', '--show-current')).toBe('latest');
  const publishedFiles = graph.getFiles();
  for (const file of sources) {
    const digest = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    expect(publishedFiles.find(row => row.path === file)?.contentHash).toBe(digest);
  }
  expect(graph.getNodesByName('original_field')).toContainEqual(
    expect.objectContaining({ kind: 'field', filePath: 'consumer.cpp' }));

  if (change === 'reverted during repair') {
    // Interrupt after the first dependent file was replaced, then restore the
    // header to its initial definition. Its current digest alone cannot prove
    // the partially repaired graph still uses that definition throughout.
    let consumerSeen = false;
    await expect(graph.sync({ adaptive: false, onProgress: progress => {
      if (consumerSeen && (progress.phase === 'parsing' || progress.phase === 'resolving')) {
        throw new Error('interrupted after consumer replacement');
      }
      if (progress.currentFile === 'consumer.cpp') consumerSeen = true;
    } })).rejects.toThrow('interrupted after consumer replacement');
    graph.close(); await graph.whenIdle(); graphs.delete(graph);
    fs.writeFileSync(path.join(root, header), original);
    graph = keep(await CodeGraph.open(root));
    expect(graph.getPortableCatchup()).toBeTruthy();
    expect(graph.getNodesByName('updated_field')).toContainEqual(
      expect.objectContaining({ kind: 'field', filePath: 'consumer.cpp' }));
  }

  if (change === 'definition') fs.writeFileSync(path.join(root, 'editing.py'), 'def later(): return 3\n');
  const catchup = await graph.sync({ adaptive: false, paths: ['trigger.cpp'] });
  expect(catchup.complete).toBe(true);
  expect(graph.getPortableCatchup()).toBeNull();
  expect(metadata(graph, PUBLICATION_MACROS)).toBeNull();
  expect(metadata(graph, DATABASE_ID)).toBe(publishedId);
  if (change === 'definition') {
    expect(graph.getNodesByName('updated_field')).toContainEqual(
      expect.objectContaining({ kind: 'field', filePath: 'consumer.cpp' }));
    expect(graph.getNodesByName('original_field')).toHaveLength(0);
    expect(catchup.changedFilePaths).toEqual(expect.arrayContaining([header, 'consumer.cpp', 'trigger.cpp', 'editing.py']));
    expect(catchup.changedFilePaths).not.toContain('independent.py');
    expect(graph.getNodesByName('later')[0]?.filePath).toBe('editing.py');
    const independent = publishedFiles.find(file => file.path === 'independent.py')!;
    expect(graph.getFiles().find(file => file.path === independent.path)?.indexedAt).toBe(independent.indexedAt);
  } else if (change === 'comment') {
    expect(catchup).toMatchObject({ filesModified: 0, filesAdded: 0, filesRemoved: 0 });
    expect(graph.getFiles().map(file => [file.path, file.indexedAt]).sort())
      .toEqual(publishedFiles.map(file => [file.path, file.indexedAt]).sort());
  }
  const clean = directory();
  for (const name of sources) {
    fs.copyFileSync(path.join(root, name), path.join(clean, name));
  }
  const fresh = keep(await CodeGraph.init(clean, { index: true }));
  expect(consumerGraph(graph)).toEqual(consumerGraph(fresh));
}, 60_000);
