import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
import { CppTargetIdentity, cppIdentityRankingView } from '../src/upstream-explore/mcp/cpp-target-identity';
import type { Edge } from '../src/upstream-explore/types';
import type { ExploreDiagnosticReport } from '../src/upstream-explore/mcp/explore-diagnostics';

let root: string;
const opened: CodeGraph[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-cpp-identity-'));
  vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
  vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
});
afterEach(() => {
  for (const graph of opened.splice(0)) graph.close();
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function index(files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  const cg = CodeGraph.initSync(root);
  opened.push(cg);
  await cg.indexAll();
  return { cg, graph: createUpstreamExploreGraph(cg) };
}

const files = {
  'worker.hpp': [
    'namespace app {', 'class Worker {', 'public:',
    '  int run(int value);', '  int run(const char *value);',
    '  int dormant();', '  int inlineValue() { return 8; }', '};', '}', '',
  ].join('\n'),
  'worker.cpp': [
    '#include "worker.hpp"', 'namespace app {',
    'int Worker::run(int value) {', '  return value + 17;', '}',
    'int Worker::run(const char *text) {', '  return text ? 42 : 0;', '}', '}', '',
  ].join('\n'),
};

describe('Explore C/C++ logical target identity', () => {
  it('uses proven pairs without merging overloads or removing declarations', async () => {
    const { graph } = await index(files);
    const nodes = graph.getNodesByName('run');
    const declarations = nodes.filter(n => n.isDeclaration);
    const definitions = nodes.filter(n => !n.isDeclaration);
    expect(declarations).toHaveLength(2);
    expect(definitions).toHaveLength(2);
    const identity = new CppTargetIdentity(graph, new Set());
    const mapped = declarations.map(n => identity.canonical(n));
    expect(new Set(mapped.map(n => n.id)).size).toBe(2);
    expect(mapped.every(n => n.filePath === 'worker.cpp')).toBe(true);
    expect(identity.unique(nodes)).toHaveLength(2);
    const all = new Map(nodes.map(n => [n.id, n]));
    expect(identity.aliasesIn(all).size).toBe(2);
    expect(identity.aliasesIn(new Map(declarations.map(n => [n.id, n]))).size).toBe(0);
    expect(graph.getNodesByName('run')).toEqual(nodes);
  });

  it('keeps unpaired declarations and inline header-only definitions', async () => {
    const { graph } = await index(files);
    const identity = new CppTargetIdentity(graph, new Set());
    for (const name of ['dormant', 'inlineValue']) {
      const nodes = graph.getNodesByName(name);
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) expect(identity.canonical(node)).toBe(node);
    }
  });

  it('keeps all identities when the query explicitly requests the declaration file', async () => {
    const { graph } = await index(files);
    const nodes = graph.getNodesByName('run');
    const identity = new CppTargetIdentity(graph, new Set(['worker.hpp']));
    expect(identity.unique(nodes)).toHaveLength(4);
    expect(identity.aliasesIn(new Map(nodes.map(n => [n.id, n]))).size).toBe(0);
  });

  it('checks all definitions, including alternatives outside the gathered nodes', async () => {
    const { graph } = await index({
      'variant.h': 'class Variant { public: int value(); };\n',
      'one.cpp': '#include "variant.h"\nint Variant::value() { return 1; }\n',
      'two.cpp': '#include "variant.h"\nint Variant::value() { return 2; }\n',
    });
    const nodes = graph.getNodesByName('value');
    const decl = nodes.find(n => n.isDeclaration)!;
    expect(graph.getIncomingEdges(decl.id).filter(e => e.kind === 'defines')).toHaveLength(2);
    const identity = new CppTargetIdentity(graph, new Set());
    expect(identity.canonical(decl)).toBe(decl);
    expect(identity.aliasesIn(new Map([decl, nodes.find(n => !n.isDeclaration)!].map(n => [n.id, n]))).size).toBe(0);
  });

  it('does not equate cv/ref overloads from parameter identity alone', async () => {
    const { graph } = await index({
      'qualifier.h': 'class Reader { public: int read(int value); };\n',
      'qualifier.cpp': '#include "qualifier.h"\nint Reader::read(int value) const { return value; }\n',
    });
    const decl = graph.getNodesByName('read').find(n => n.isDeclaration)!;
    expect(decl).toBeDefined();
    expect(new CppTargetIdentity(graph, new Set()).canonical(decl)).toBe(decl);
  });

  it('uses C bridges but leaves unrelated languages unchanged', async () => {
    const { graph } = await index({
      'counter.h': 'int count_items(int value);\n',
      'counter.c': '#include "counter.h"\nint count_items(int value) { return value + 1; }\n',
      'shape.ts': 'export interface Reader { read(value: number): number; }\nexport function read(value: number) { return value; }\n',
    });
    const identity = new CppTargetIdentity(graph, new Set());
    const cNodes = graph.getNodesByName('count_items');
    expect(cNodes.some(n => n.language === 'c' && n.isDeclaration)).toBe(true);
    expect(identity.unique(cNodes)).toHaveLength(1);
    for (const node of graph.getNodesByName('read')) expect(identity.canonical(node)).toBe(node);
  });

  it('requires a trusted bridge and does not infer pairing from a shared name', async () => {
    const { cg, graph } = await index(files);
    const decl = graph.getNodesByName('run').find(n => n.isDeclaration)!;
    cg.getExploreQueryConnection().prepare("UPDATE edges SET metadata = ? WHERE kind = 'defines' AND target = ?")
      .run(JSON.stringify({ synthesizedBy: 'unverified' }), decl.id);
    expect(new CppTargetIdentity(graph, new Set()).canonical(decl)).toBe(decl);
  });

  it('uses a topology-only view without mutating original nodes or source coordinates', async () => {
    const { graph } = await index(files);
    const nodes = new Map(graph.getNodesByName('run').map(n => [n.id, n]));
    const edges: Edge[] = [...nodes.keys()].flatMap(id => graph.getOutgoingEdges(id));
    const original = JSON.stringify({ nodes: [...nodes], edges });
    const aliases = new CppTargetIdentity(graph, new Set()).aliasesIn(nodes);
    const ranked = cppIdentityRankingView(nodes, edges, aliases);
    expect(ranked.nodeIds).toHaveLength(2);
    expect(ranked.edges).toHaveLength(edges.length);
    for (const edge of ranked.edges) {
      expect(edge).not.toHaveProperty('line');
      expect(edge).not.toHaveProperty('column');
    }
    expect(JSON.stringify({ nodes: [...nodes], edges })).toBe(original);
  });
});

describe('Explore consumes C++ identity through ranking and explicit targets', () => {
  it('keeps an oversize caller focused on its real call to a paired declaration', async () => {
    const callerLines = [
      '#include "sink.h"', 'int runDriver() {', '  int total = 0;',
      ...Array.from({ length: 420 }, (_, i) => `  total += ${i}; // ${'padding '.repeat(12)}`),
      '  total += Sink::commit(total);',
      ...Array.from({ length: 120 }, (_, i) => `  total -= ${i}; // ${'padding '.repeat(12)}`),
      '  return total;', '}', '',
    ];
    const callLine = callerLines.indexOf('  total += Sink::commit(total);') + 1;
    const { cg, graph } = await index({
      'sink.h': 'class Sink { public: static int commit(int value); };\n',
      'sink.cpp': '#include "sink.h"\nint Sink::commit(int value) { return value + 7; }\n',
      'driver.cpp': callerLines.join('\n'),
    });
    const caller = graph.getNodesByName('runDriver')[0]!;
    const targets = graph.getNodesByName('commit');
    const declaration = targets.find(n => n.isDeclaration)!;
    const definition = targets.find(n => !n.isDeclaration)!;
    expect(new CppTargetIdentity(graph, new Set()).canonical(declaration).id).toBe(definition.id);
    const callEdges = graph.getOutgoingEdges(caller.id).filter(e =>
      e.kind === 'calls' && targets.some(n => n.id === e.target) && e.line === callLine);
    expect(callEdges.length).toBeGreaterThan(0);
    // Both native resolution strategies are legitimate: a call can point to a
    // header prototype or directly to its implementation. Pin this fixture to
    // the former using the real parsed edge and its unchanged source location.
    for (const edge of callEdges) {
      cg.getExploreQueryConnection().prepare("UPDATE edges SET target = ? WHERE source = ? AND target = ? AND kind = 'calls' AND line = ?")
        .run(declaration.id, caller.id, edge.target, callLine);
    }
    const before = graph.getOutgoingEdges(caller.id);
    expect(before.some(e => e.target === declaration.id && e.line === callLine)).toBe(true);
    const response = await new ToolHandler(cg).execute('explore', {
      query: 'runDriver Sink::commit', maxFiles: 3,
    });
    expect(response.isError).not.toBe(true);
    const text = response.content[0]!.text;
    expect(text).toContain(`${callLine}\t  total += Sink::commit(total);`);
    expect(text.length).toBeLessThan(callerLines.join('\n').length / 2); // a window, not a full-body dump
    expect(graph.getOutgoingEdges(caller.id)).toEqual(before);
  });

  it('tiers the implementation and covers qualified overloads while retaining graph evidence', async () => {
    const { cg, graph } = await index(files);
    const before = cg.getStats();
    const allNodes = graph.getNodesByName('run');
    const edgesBefore = allNodes.flatMap(n => graph.getIncomingEdges(n.id));
    const sidecar = path.join(root, 'diagnostics.jsonl');
    vi.stubEnv('CODEGRAPH_EXPLORE_DEBUG', sidecar);
    const handler = new ToolHandler(cg);
    const response = await handler.execute('explore', { query: 'app::Worker::run', maxFiles: 2 });
    expect(response.isError).not.toBe(true);
    const report: ExploreDiagnosticReport = JSON.parse(fs.readFileSync(sidecar, 'utf8').trim().split('\n')[0]!);
    const cpp = report.files.find(f => f.path === 'worker.cpp');
    const header = report.files.find(f => f.path === 'worker.hpp');
    expect(cpp?.named).toBe(true);
    // A single qualified token has no Flow chain; exact target protection is
    // independent of the diagnostic's Flow-only `spine` flag.
    expect(cpp?.allowance).toBeGreaterThan(0);
    expect(header?.named ?? false).toBe(false);
    expect(cpp!.score).toBeGreaterThan(header?.score ?? 0);
    expect(response.content[0]!.text).toContain('return value + 17;');
    expect(response.content[0]!.text).toContain('return text ? 42 : 0;');
    expect(graph.getNodesByName('run')).toEqual(allNodes);
    expect(allNodes.flatMap(n => graph.getIncomingEdges(n.id))).toEqual(edgesBefore);
    expect(cg.getStats().nodeCount).toBe(before.nodeCount);
    expect(cg.getStats().edgeCount).toBe(before.edgeCount);
  });

  it.each(['worker.hpp', 'worker.hpp:4', 'worker.hpp:4-5'])(
    'honors explicit header intent %s', async query => {
      const { cg } = await index(files);
      const response = await new ToolHandler(cg).execute('explore', { query, maxFiles: 1 });
      expect(response.isError).not.toBe(true);
      expect(response.content[0]!.text).toContain('**`worker.hpp`**');
      expect(response.content[0]!.text).toContain('int run(int value);');
    },
  );
});
