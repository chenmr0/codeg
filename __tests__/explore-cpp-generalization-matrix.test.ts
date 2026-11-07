import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
import { CppTargetIdentity, cppIdentityRankingView } from '../src/upstream-explore/mcp/cpp-target-identity';
import { resolveNamedSymbolFlow } from '../src/upstream-explore/graph/named-symbol-flow';
import { cppLogicalCallTarget } from '../src/upstream-explore/graph/cpp-logical-calls';
import type { Edge, Node } from '../src/upstream-explore/types';
import type { ExploreGraph } from '../src/upstream-explore';

// Independent generalization matrix: no production mocks in indexed cases.
// Synthetic cases isolate evidence boundaries which a parser cannot reliably
// produce (corrupt/missing edges, unavailable adjacency, legacy languages).
const roots: string[] = [], opened: CodeGraph[] = [];
const handlers: ToolHandler[] = [];
const handler = (cg: CodeGraph) => { const instance = new ToolHandler(cg); handlers.push(instance); return instance; };
afterEach(() => {
  for (const instance of handlers.splice(0)) instance.closeAll();
  for (const graph of opened.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function index(files: Record<string, string>) {
  vi.stubEnv('CODEGRAPH_NO_DAEMON', '1'); vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-generalization-')); roots.push(root);
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(root, name), source);
  const writer = CodeGraph.initSync(root);
  try { await writer.indexAll(); } finally { writer.close(); }
  const cg = CodeGraph.openReadOnlySync(root); opened.push(cg);
  return { cg, graph: createUpstreamExploreGraph(cg) };
}
const callable = (id: string, extra: Partial<Node> = {}): Node => ({
  id, name: 'flush_state', qualifiedName: 'outer::inner::Journal::flush_state',
  kind: 'method', language: 'cpp', filePath: id === 'decl' ? 'api.h' : 'api.cpp',
  startLine: 3, endLine: 8, signature: 'int flush_state(int value)',
  isDeclaration: id === 'decl', ...extra,
} as Node);
function fixture(decl = callable('decl'), body = callable('body'), extra: Edge[] = []) {
  const nodes = new Map([decl, body].map(n => [n.id, n]));
  const edges: Edge[] = [{ source: body.id, target: decl.id, kind: 'defines', provenance: 'heuristic', metadata: { synthesizedBy: 'cpp-decl-def' } }, ...extra];
  const graph = {
    getNode: (id: string) => nodes.get(id),
    getIncomingEdges: (id: string) => edges.filter(e => e.target === id),
    getOutgoingEdges: (id: string) => edges.filter(e => e.source === id),
  } as ExploreGraph;
  return { graph, nodes, edges, decl, body };
}

describe('C++ identity evidence boundaries beyond the original regression', () => {
  it.each([
    ['missing signature', { signature: undefined }],
    ['truncated signature', { signature: 'int flush_state(int value, ...' }],
    ['const overload', { signature: 'int flush_state(int value) const' }],
    ['volatile overload', { signature: 'int flush_state(int value) volatile' }],
    ['lvalue overload', { signature: 'int flush_state(int value) &' }],
    ['rvalue overload', { signature: 'int flush_state(int value) &&' }],
    ['argument overload', { signature: 'int flush_state(double value)' }],
    ['other namespace', { qualifiedName: 'unrelated::Journal::flush_state' }],
    ['other kind', { kind: 'function' }],
    ['other language', { language: 'c' }],
    ['declaration instead of body', { isDeclaration: true }],
  ] as [string, Partial<Node>][])('retains declaration for %s', (_label, change) => {
    const { graph, decl } = fixture(callable('decl'), callable('body', change));
    expect(new CppTargetIdentity(graph, new Set()).canonical(decl)).toBe(decl);
    expect(cppLogicalCallTarget(graph)(decl)).toBe(decl);
  });

  it.each(['typescript', 'javascript', 'python', 'java', 'go', 'rust'] as const)('does not reinterpret %s graphs', language => {
    const { graph, decl } = fixture(callable('decl', { language }), callable('body', { language }));
    expect(new CppTargetIdentity(graph, new Set()).canonical(decl)).toBe(decl);
    expect(cppLogicalCallTarget(graph)(decl)).toBe(decl);
  });

  it.each(['missing', 'wrong', 'ambiguous', 'lookup throws', 'explicit file'])('fails closed for %s evidence', mode => {
    const { graph, decl, nodes, edges } = fixture();
    if (mode === 'missing') edges.length = 0;
    if (mode === 'wrong') edges[0]!.metadata = { synthesizedBy: 'name-match' };
    if (mode === 'ambiguous') {
      nodes.set('alternative', callable('alternative'));
      edges.push({ source: 'alternative', target: decl.id, kind: 'defines' });
    }
    if (mode === 'lookup throws') graph.getIncomingEdges = () => { throw new Error('unavailable'); };
    const identity = new CppTargetIdentity(graph, new Set(mode === 'explicit file' ? ['api.h'] : []));
    expect(identity.canonical(decl)).toBe(decl);
  });

  it('deduplicates weights only with both identities present, without changing raw call coordinates or multiplicity', () => {
    const { graph, decl, body, nodes, edges } = fixture();
    edges.push(...[4, 7].map(line => ({ source: 'caller', target: decl.id, kind: 'calls' as const, line, column: 19 })));
    const snapshot = structuredClone(edges);
    const identity = new CppTargetIdentity(graph, new Set());
    expect(identity.aliasesIn(new Map([[decl.id, decl]]))).toEqual(new Map());
    const aliases = identity.aliasesIn(nodes);
    expect(aliases).toEqual(new Map([[decl.id, body.id]]));
    const view = cppIdentityRankingView(nodes, edges, aliases);
    expect(view.nodeIds).toEqual([body.id]);
    expect(view.edges.filter(e => e.kind === 'calls')).toHaveLength(2);
    expect(edges).toEqual(snapshot);
  });
});

describe('Flow declaration adjacency preservation', () => {
  it.each([
    ['outgoing calls', { source: 'decl', target: 'elsewhere', kind: 'calls' }],
    ['outgoing navigation', { source: 'decl', target: 'elsewhere', kind: 'navigates' }],
    ['incoming override', { source: 'base', target: 'decl', kind: 'calls', provenance: 'heuristic', metadata: { synthesizedBy: 'cpp-override' } }],
    ['incoming other synthesized relation', { source: 'base', target: 'decl', kind: 'references', provenance: 'heuristic' }],
    ['outgoing other synthesized relation', { source: 'decl', target: 'base', kind: 'references', provenance: 'heuristic' }],
  ] as [string, Edge][])('does not erase %s', (_name, edge) => {
    const { graph, decl, body, edges } = fixture(undefined, undefined, [edge]);
    const before = structuredClone(edges);
    expect(new CppTargetIdentity(graph, new Set()).canonical(decl)).toBe(body);
    expect(cppLogicalCallTarget(graph)(decl)).toBe(decl);
    expect(edges).toEqual(before);
  });
  it('allows ordinary incoming calls but not unavailable outgoing adjacency', () => {
    const { graph, decl, body } = fixture(undefined, undefined, [{ source: 'caller', target: 'decl', kind: 'calls', line: 47, column: 9 }]);
    expect(cppLogicalCallTarget(graph)(decl)).toBe(body);
    graph.getOutgoingEdges = () => { throw new Error('unavailable'); };
    expect(cppLogicalCallTarget(graph)(decl)).toBe(decl);
  });
});

describe('real indexed owner, macro and overload families', () => {
  it.each(['int', 'const char *', 'double'])('keeps %s overload bodies distinct under namespace-qualified owner selection', async parameter => {
    const { graph } = await index({
      'api.h': `namespace alpha { class Journal { public: int flush_state(${parameter} value); int flush_state(long value); int declaration_only(int value); }; }\nnamespace beta { class Journal { public: int flush_state(int value); }; }\n`,
      'api.cpp': `#include "api.h"\nnamespace alpha {\nint Journal::flush_state(${parameter} value) { return 31001; }\nint Journal::flush_state(long value) { return 31002; }\n}\nnamespace beta { int Journal::flush_state(int value) { return 31003; } }\n`,
    });
    const family = graph.getNodesByName('flush_state');
    const identity = new CppTargetIdentity(graph, new Set());
    expect(family.filter(n => !n.isDeclaration)).toHaveLength(3);
    expect(identity.unique(family)).toHaveLength(3);
    const declarationOnly = graph.getNodesByName('declaration_only');
    expect(declarationOnly).toHaveLength(1);
    expect(declarationOnly[0]!.isDeclaration).toBe(true);
    expect(identity.canonical(declarationOnly[0]!)).toBe(declarationOnly[0]);
  }, 30000);

  it.each(['int flush_state(int value);', 'DECLARE_METHOD(flush_state)'])('keeps source evidence for declaration spelling %s', async declaration => {
    const { cg, graph } = await index({
      'api.h': `#define DECLARE_METHOD(name) int name(int value);\nnamespace archive { class Journal { public: ${declaration} }; }\n`,
      'api.cpp': '#include "api.h"\nnamespace archive { int Journal::flush_state(int value) { return value + 42913; } }\n',
    });
    const family = graph.getNodesByName('flush_state');
    expect(family.filter(n => n.isDeclaration)).toHaveLength(1);
    expect(family.filter(n => !n.isDeclaration)).toHaveLength(1);
    const before = structuredClone(family);
    expect(family.find(node => !node.isDeclaration)?.filePath).toBe('api.cpp');
    const result = await handler(cg).execute('explore', { query: 'archive::Journal flush_state api.h', maxFiles: 2 });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain(declaration);
    expect(result.content[0]!.text).toContain('42913');
    expect(result.content[0]!.text.length).toBeLessThanOrEqual(25000);
    expect(graph.getNodesByName('flush_state')).toEqual(before);
  }, 30000);

  it.each([
    ['ts', 'export function finishFlow(value: number) { return value + 49173; }\nexport function startFlow(value: number) { return finishFlow(value); }\n'],
    ['py', 'def finishFlow(value):\n    return value + 49173\ndef startFlow(value):\n    return finishFlow(value)\n'],
    ['go', 'package example\nfunc finishFlow(value int) int { return value + 49173 }\nfunc startFlow(value int) int { return finishFlow(value) }\n'],
  ])('keeps real %s named bodies and graph evidence', async (extension, source) => {
    const { cg, graph } = await index({ [`flow.${extension}`]: source });
    const nodes = graph.getNodesByName('startFlow'); expect(nodes).toHaveLength(1);
    const edges = graph.getOutgoingEdges(nodes[0]!.id);
    expect(edges.some(e => e.kind === 'calls' && graph.getNode(e.target)?.name === 'finishFlow')).toBe(true);
    const result = await handler(cg).execute('explore', { query: 'startFlow finishFlow', maxFiles: 1 });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('49173');
    // Existing renderer intentionally omits two-node Flow sections.
    expect(resolveNamedSymbolFlow(graph, 'startFlow finishFlow').chains[0]?.steps.map(step => step.node.name)).toEqual(['startFlow', 'finishFlow']);
    expect(result.content[0]!.text).not.toContain('**Flow');
    expect(result.content[0]!.text.length).toBeLessThanOrEqual(25000);
    expect(graph.getOutgoingEdges(nodes[0]!.id)).toEqual(edges);
  }, 30000);
});

describe('real indexed chain depth, bridge and output budgets', () => {
  it.each(['c', 'cpp'])('preserves %s chain limits and call evidence without editing the index', async extension => {
    const { cg, graph } = await index({
      'api.h': 'int middleFlow(int value);\nint finishFlow(int value);\n',
      [`middle.${extension}`]: '#include "api.h"\nint middleFlow(int value) { return finishFlow(value); }\n',
      [`finish.${extension}`]: '#include "api.h"\nint finishFlow(int value) { return value + 12793; }\n',
      [`entry.${extension}`]: '#include "api.h"\nint entryFlow(int value) {\n  if (value > 3) return middleFlow(value);\n  return 0;\n}\n',
    });
    const names = ['entryFlow', 'middleFlow', 'finishFlow'];
    const nodes = names.flatMap(name => graph.getNodesByName(name));
    const before = nodes.map(node => [node.id, graph.getOutgoingEdges(node.id)]);
    const full = resolveNamedSymbolFlow(graph, names.join(' '), { maxHops: 3, maxBridge: 0 });
    expect(full.chains[0]?.steps.map(step => step.node.name)).toEqual(names);
    const call = full.chains[0]!.steps[1]!.edge!;
    expect(call.line).toBe(3);
    expect(graph.getOutgoingEdges(full.chains[0]!.steps[0]!.node.id)).toContainEqual(call);
    const bounded = resolveNamedSymbolFlow(graph, names.join(' '), { maxHops: 2, maxBridge: 0 });
    expect(bounded.chains.every(chain => chain.steps.length <= 2)).toBe(true);
    const noBridge = resolveNamedSymbolFlow(graph, 'entryFlow finishFlow', { maxHops: 3, maxBridge: 0 });
    expect(noBridge.chains).toHaveLength(0);
    const bridge = resolveNamedSymbolFlow(graph, 'entryFlow finishFlow', { maxHops: 3, maxBridge: 1 });
    expect(bridge.chains[0]?.steps.map(step => step.node.name)).toEqual(names);
    const result = await handler(cg).execute('explore', { query: names.join(' '), maxFiles: 4 });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('**Flow');
    expect(result.content[0]!.text).toContain('12793');
    expect(result.content[0]!.text.length).toBeLessThanOrEqual(25000);
    expect(nodes.map(node => [node.id, graph.getOutgoingEdges(node.id)])).toEqual(before);
  }, 30000);

  it.each([1, 3, 8])('respects hard output ceiling with %i requested files and oversized precise bodies', async maxFiles => {
    const files: Record<string, string> = {};
    const owners = ['Journal', 'Ledger', 'Catalog', 'Mailbox'];
    owners.forEach((owner, index) => {
      files[`${owner}.h`] = `class ${owner} { public: int rebuild_state(int value); };\n`;
      files[`${owner}.cpp`] = `#include "${owner}.h"\nint ${owner}::rebuild_state(int value) {\n`
        + Array.from({ length: 420 }, (_, line) => `  value += ${line + index}; // independent budget pressure ${owner} ${line}`).join('\n')
        + `\n  return value + ${78100 + index};\n}\n`;
    });
    const { cg, graph } = await index(files);
    const before = graph.getNodesByName('rebuild_state');
    const result = await handler(cg).execute('explore', {
      query: owners.map(owner => `${owner}::rebuild_state`).join(' '), maxFiles,
    });
    expect(result.isError).not.toBe(true);
    const text = result.content[0]!.text;
    expect(text.length).toBeLessThanOrEqual(25000);
    expect(text).toContain('rebuild_state');
    // Oversized bodies cannot promise completeness: elision must be explicit,
    // rather than silently claiming that a partial implementation is complete.
    const sourceBlocks = [...text.matchAll(/```cpp\n([\s\S]*?)```/g)].map(match => match[1]!);
    const bodyBlocks = sourceBlocks.filter(block => /int (Journal|Ledger|Catalog|Mailbox)::rebuild_state\(int value\)/.test(block));
    expect(bodyBlocks.length).toBeGreaterThan(0);
    for (const block of bodyBlocks) {
      expect(block).toMatch(/lines \d+-\d+ of `rebuild_state` elided/);
      expect(block).toMatch(/value \+= \d+; \/\/ independent budget pressure/);
    }
    expect(graph.getNodesByName('rebuild_state')).toEqual(before);
  }, 30000);
});

// Reproduced by indexing the same fixture with frozen 39a13ebb7ce54bf9
// production CodeGraph + ToolHandler, not only by disabling current helpers.
// Known baseline limitation, not a passing quality claim. A C-shaped .h is
// classified as C even when consumed only by .cpp. The safe identity view must
// not merge language-mismatched nodes; file selection can then spend a slot on
// prototypes and omit an explicitly named Flow endpoint. Keep the desired
// behavior executable with it.fails so a future fix must update this contract.
const mixedHeaderFiles = {
  'api.h': 'int middleFlow(int value);\nint finishFlow(int value);\n',
  'middle.cpp': '#include "api.h"\nint middleFlow(int value) { return finishFlow(value); }\n',
  'finish.cpp': '#include "api.h"\nint finishFlow(int value) { return value + 12793; }\n',
  'entry.cpp': '#include "api.h"\nint entryFlow(int value) { return middleFlow(value); }\n',
};
const mixedHeaderQuery = { query: 'entryFlow middleFlow finishFlow', maxFiles: 3 };
it('establishes mixed-language header file-slot omission also with identity optimization disabled', async () => {
  const { cg, graph } = await index(mixedHeaderFiles);
  expect(graph.getNodesByName('finishFlow').find(node => node.isDeclaration)?.language).toBe('c');
  const current = await handler(cg).execute('explore', mixedHeaderQuery);
  vi.spyOn(CppTargetIdentity.prototype, 'canonical').mockImplementation(node => node);
  const baseline = await handler(cg).execute('explore', mixedHeaderQuery);
  expect(current.isError).not.toBe(true);
  expect(baseline.isError).not.toBe(true);
  expect(current.content[0]!.text).toBe(baseline.content[0]!.text);
  expect(current.content[0]!.text).not.toContain('12793');
  expect(current.content[0]!.text).toContain('finish.cpp: finishFlow:2');
}, 30000);
it.fails('KNOWN BASELINE: three C++ Flow bodies should win three file slots over C-classified prototypes', async () => {
  const { cg } = await index(mixedHeaderFiles);
  const current = await handler(cg).execute('explore', mixedHeaderQuery);
  expect(current.content[0]!.text).toContain('12793');
}, 30000);
