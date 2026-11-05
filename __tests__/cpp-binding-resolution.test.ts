import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import CodeGraph from '../src';
import { QueryBuilder } from '../src/db/queries';
import { createDatabase } from '../src/db/sqlite-adapter';
import { ReferenceResolver } from '../src/resolution';
import type { ResolverAdmissionResult } from '../src/resolution/resolver-pool';
import type { UnresolvedReference } from '../src/types';

interface Target { path: string; name: string; qualifiedName?: string; signatureContains?: string }
interface Site { path: string; line: number; sourceName: string; refName: string; kind?: 'calls' | 'references' }
interface BindingCase {
  id: string; group: string; files: Record<string, string>; sourceSha256: Record<string, string>;
  site: Site; allowedTargets: Target[]; forbiddenTargets: Target[]; requireAllowed: boolean;
}
interface Observed { path: string; name: string; qualifiedName: string; signature: string | null; id: string }
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/cpp-binding-cases.json'), 'utf8')) as {
  originalCaseIds: string[]; cases: BindingCase[];
};
const roots: string[] = [], graphs: CodeGraph[] = [];

beforeEach(() => {
  for (const [name, value] of Object.entries({ CODEGRAPH_RUST_SCAN: '0', CODEGRAPH_RUST_MACROS: '0',
    CODEGRAPH_RUST_GIT_IGNORE: '0', CODEGRAPH_PARSE_WORKERS: '1', CODEGRAPH_RESOLVE_WORKERS: '1',
    CODEGRAPH_ALL_LANGUAGES: '1' })) vi.stubEnv(name, value);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const graph of graphs.splice(0)) {
    await graph.whenIdle(); graph.close(); await graph.whenIdle();
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function project(c: BindingCase) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-binding-controls-'));
  roots.push(root);
  for (const [file, source] of Object.entries(c.files)) {
    expect(createHash('sha256').update(source).digest('hex')).toBe(c.sourceSha256[file]);
    const output = path.join(root, file);
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, source);
  }
  const graph = CodeGraph.initSync(root); graphs.push(graph);
  return { root, graph };
}
function db(graph: CodeGraph) { return graph.getExploreQueryConnection(); }
function matches(node: Observed, target: Target): boolean {
  return node.path === target.path && node.name === target.name
    && (!target.qualifiedName || node.qualifiedName === target.qualifiedName)
    && (!target.signatureContains || !!node.signature?.includes(target.signatureContains));
}
function observations(graph: CodeGraph, c: BindingCase): Observed[] {
  return db(graph).prepare(`SELECT t.id, t.file_path path, t.name, t.qualified_name qualifiedName, t.signature
    FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
    WHERE s.file_path=? AND s.name=? AND e.line=? AND e.kind=? ORDER BY t.id`)
    .all(c.site.path, c.site.sourceName, c.site.line, c.site.kind ?? 'calls');
}
function verifyTargets(c: BindingCase, observed: Observed[]) {
  const forbidden = observed.filter(node => c.forbiddenTargets.some(target => matches(node, target)));
  const allowed = observed.filter(node => c.allowedTargets.some(target => matches(node, target)));
  const unexpected = observed.filter(node => !c.allowedTargets.some(target => matches(node, target)));
  expect(forbidden, `${c.id}: forbidden binding`).toEqual([]);
  expect(unexpected, `${c.id}: binding outside frozen allowed targets`).toEqual([]);
  if (c.requireAllowed) expect(allowed.length, `${c.id}: missing required positive`).toBeGreaterThan(0);
  return { forbidden: forbidden.length, allowed: allowed.length };
}

it('preserves the original six-case denominator and the frozen source bytes', () => {
  expect(fixture.originalCaseIds).toHaveLength(6);
  expect(fixture.cases.filter(c => c.group === 'original-six').map(c => c.id)).toEqual(fixture.originalCaseIds);
  expect(fixture.cases.filter(c => c.group === 'general-counterexample')).toHaveLength(14);
  for (const c of fixture.cases) for (const [file, source] of Object.entries(c.files)) {
    expect(createHash('sha256').update(source).digest('hex')).toBe(c.sourceSha256[file]);
  }
});

describe('frozen C/C++ binding controls', () => {
  for (const c of fixture.cases) it(c.id, async () => {
    const { graph } = project(c);
    const indexed = await graph.indexAll();
    expect(indexed.complete).toBe(true); expect(indexed.errors).toEqual([]);
    const observed = observations(graph, c);
    const unresolved = db(graph).prepare(`SELECT u.* FROM unresolved_refs u JOIN nodes s ON s.id=u.from_node_id
      WHERE s.file_path=? AND s.name=? AND u.line=? AND u.reference_kind=?`)
      .all(c.site.path, c.site.sourceName, c.site.line, c.site.kind ?? 'calls');
    // Report absence separately even for conservative controls that permit it.
    // Neither unresolved nor missing contributes an allowed-evidence result.
    console.info('BINDING_CASE_OUTCOME ' + JSON.stringify({ id: c.id, group: c.group,
      observed, unresolved: unresolved.length, missing: observed.length === 0 && unresolved.length === 0 }));
    verifyTargets(c, observed);
    expect(db(graph).prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }, 30_000);
});

function workerRequest(worker: Worker, message: unknown, expectedType: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`resolver worker timed out waiting for ${expectedType}`)), 20_000);
    function finish(error?: Error, result?: unknown) {
      clearTimeout(timeout); worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit);
      error ? reject(error) : resolve(result);
    }
    function onMessage(value: any) {
      if (value.type === 'error') finish(new Error(value.error));
      else if (value.type === expectedType) finish(undefined, value);
    }
    function onError(error: Error) { finish(error); }
    function onExit(code: number) { finish(new Error(`resolver worker exited before ${expectedType}: ${code}`)); }
    worker.on('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
    worker.postMessage(message);
  });
}

it('uses the actual worker open/resolve protocol and matches main-thread admission on tiny fixtures', async context => {
  for (const id of ['direct-call-positive', 'external-declaration-vs-private-static', 'typed-parameter-receiver']) {
    const c = fixture.cases.find(item => item.id === id)!;
    const { graph, root } = project(c);
    const probe = createDatabase(graph.getDatabaseFilePath(), { readOnly: true });
    const backend = probe.backend;
    probe.db.close();
    if (backend !== 'node-sqlite') {
      // The production worker explicitly requires native SQLite. This is not
      // replaced by a mock when testing on a WASM-only runtime.
      context.skip(); return;
    }
    expect((await graph.indexAll()).complete).toBe(true);
    await graph.whenIdle();
    const source = graph.getNodesByName(c.site.sourceName).find(node => node.filePath === c.site.path)!;
    const sourceLine = c.files[c.site.path]!.split('\n')[c.site.line - 1]!;
    const refs: UnresolvedReference[] = [{ fromNodeId: source.id, referenceName: c.site.refName,
      referenceKind: c.site.kind ?? 'calls', line: c.site.line,
      column: sourceLine.indexOf(c.site.refName.replace('.', '->')) >= 0
        ? sourceLine.indexOf(c.site.refName.replace('.', '->')) : sourceLine.indexOf(c.site.refName),
      filePath: c.site.path, language: 'cpp' }];
    const resolver = new ReferenceResolver(root, new QueryBuilder(graph.getExploreQueryConnection())); resolver.initialize();
    const sequential = resolver.resolveListForAdmission(refs);
    // Only loading is adapted to run TypeScript source in Node. The imported
    // worker, native readonly database and message protocol are production code.
    const worker = new Worker(`
      const fs = require('node:fs');
      const { workerData } = require('node:worker_threads');
      const ts = require(workerData.typescript);
      require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(
        fs.readFileSync(filename, 'utf8'), { compilerOptions: {
          target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true
        }, fileName: filename }).outputText, filename);
      require(workerData.entry);
    `, { eval: true, workerData: { typescript: require.resolve('typescript'),
      entry: path.resolve(__dirname, '../src/resolution/resolver-worker.ts') } });
    try {
      await workerRequest(worker, { type: 'open', dbPath: graph.getDatabaseFilePath(), projectRoot: root }, 'ready');
      const message = await workerRequest(worker, { type: 'resolve', id: 1, refs }, 'result');
      const result = message.result as ResolverAdmissionResult;
      expect(message.id).toBe(1); expect(result).toEqual(sequential);
      const targets = result.resolved.map(ref => db(graph).prepare(`SELECT id, file_path path, name,
        qualified_name qualifiedName, signature FROM nodes WHERE id=?`).get(ref.targetNodeId));
      verifyTargets(c, targets);
    } finally { await worker.terminate(); }
  }
}, 60_000);
