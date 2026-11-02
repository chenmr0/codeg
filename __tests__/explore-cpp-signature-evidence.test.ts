import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import CodeGraph from '../src';
import { QueryBuilder } from '../src/db/queries';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
import { ToolHandler } from '../src/upstream-explore/mcp/tools';
import { CppSignatureTypeEvidence } from '../src/upstream-explore/mcp/cpp-signature-evidence';
import type { Edge, Node } from '../src/upstream-explore/types';
import type { ExploreDiagnosticReport } from '../src/upstream-explore/mcp/explore-diagnostics';

const roots: string[] = [];
const opened: CodeGraph[] = [];
afterEach(() => {
  for (const cg of opened.splice(0)) cg.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function node(source: string, anchor: string, name = 'work', language: 'c' | 'cpp' = 'cpp'): Node {
  const offset = source.indexOf(anchor);
  if (offset < 0) throw new Error(`Missing anchor ${anchor}`);
  const before = source.slice(0, offset);
  return {
    id: `${name}:${offset}`, kind: 'function', name, qualifiedName: name, language,
    filePath: 'worker.cpp', startLine: before.split('\n').length,
    startColumn: offset - (source.lastIndexOf('\n', offset - 1) + 1),
    endLine: source.split('\n').length, endColumn: 0, updatedAt: 0,
    signature: 'deliberately incomplete...',
  };
}

function evidence(source: string) {
  const read = vi.fn(() => source);
  const rawHelper = new CppSignatureTypeEvidence({
    getProjectRoot: () => '.', getFile: () => null, getVerifiedSource: read,
  });
  const helper = {
    contains(callable: Node, target: Node, edge: Pick<Edge, 'line' | 'column'> = site(source, target.name)) {
      return rawHelper.contains(callable, target, edge);
    },
  };
  return { helper, read };
}

function site(source: string, token: string, from = 0): Pick<Edge, 'line' | 'column'> {
  const offset = source.indexOf(token, from);
  return offset < 0 ? {} : {
    line: source.slice(0, offset).split('\n').length,
    column: offset - (source.lastIndexOf('\n', offset - 1) + 1),
  };
}

function type(name: string): Node {
  return { ...node('int x;', 'int', name), kind: 'class', name };
}

describe('C/C++ signature change-surface evidence', () => {
  it('keeps parameter and return references but excludes body-local types on the same line', async () => {
    const source = 'Result work(Options options) { Scratch scratch; return Result{}; }';
    const { helper, read } = evidence(source);
    const callable = node(source, 'Result');
    expect(await helper.contains(callable, type('Result'))).toBe(true);
    expect(await helper.contains(callable, type('Options'))).toBe(true);
    expect(await helper.contains(callable, type('Scratch'))).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('uses the full source for multiline signatures longer than the display limit', async () => {
    const source = `Result work(\n  ${Array.from({ length: 20 }, (_, i) => `int padding_argument_${i}`).join(',\n  ')},\n  LateParameter value\n) { BodyOnly local; return {}; }`;
    expect(source.indexOf('LateParameter')).toBeGreaterThan(200);
    const { helper } = evidence(source);
    expect(await helper.contains(node(source, 'Result'), type('LateParameter'))).toBe(true);
    expect(await helper.contains(node(source, 'Result'), type('BodyOnly'))).toBe(false);
  });

  it('handles trailing return types and function-pointer parameter types', async () => {
    const source = 'auto work(void (*callback)(CallbackInput), Options input) -> Result { Scratch local; return {}; }';
    const { helper } = evidence(source);
    for (const name of ['CallbackInput', 'Options', 'Result']) {
      expect(await helper.contains(node(source, 'auto'), type(name)), name).toBe(true);
    }
    expect(await helper.contains(node(source, 'auto'), type('Scratch'))).toBe(false);
  });

  it('excludes comments, literals, default lambdas and non-type template expressions', async () => {
    const source = `Result work(Options input = [] { DefaultBody local; return Options{}; }(),
      const char *text = R"tag(CommentType { ) })tag", Buffer<sizeof(ExpressionOnly)> value = {})
      /* CommentType */ { LiteralType local; return {}; }`;
    const { helper } = evidence(source);
    for (const name of ['Result', 'Options', 'Buffer']) {
      expect(await helper.contains(node(source, 'Result'), type(name)), name).toBe(true);
    }
    for (const name of ['DefaultBody', 'CommentType', 'ExpressionOnly', 'LiteralType']) {
      expect(await helper.contains(node(source, 'Result'), type(name)), name).toBe(false);
    }
  });

  it('recognizes declarations and distinguishes same-line overloads by source anchor', async () => {
    const source = 'Result work(First input); Result work(Second input);';
    const { helper } = evidence(source);
    expect(await helper.contains(node(source, 'Result work(First'), type('First'))).toBe(true);
    expect(await helper.contains(node(source, 'Result work(First'), type('Second'))).toBe(false);
    expect(await helper.contains(node(source, 'Result work(Second'), type('Second'))).toBe(true);
  });

  it('does not combine same-name declarators sharing one declaration statement', async () => {
    const source = 'Result work(First input), work(Second input);';
    const { helper } = evidence(source);
    const first = node(source, 'work(First');
    const second = node(source, 'work(Second');
    expect(await helper.contains(first, type('First'))).toBe(true);
    expect(await helper.contains(first, type('Second'))).toBe(false);
    expect(await helper.contains(second, type('Second'))).toBe(true);
    expect(await helper.contains(second, type('First'))).toBe(false);
    // An old index anchored only to the shared statement cannot identify
    // which overload it represents; ambiguity must not union their types.
    expect(await helper.contains(node(source, 'Result'), type('First'))).toBe(false);
  });

  it('keeps source anchors correct after a non-ASCII same-line prefix', async () => {
    const source = '/* 中文🙂 */ Result work(Options input) { Scratch local; return {}; }';
    const { helper } = evidence(source);
    expect(await helper.contains(node(source, 'Result'), type('Options'))).toBe(true);
    expect(await helper.contains(node(source, 'Result'), type('Scratch'))).toBe(false);
  });

  it('does not rescue a body type sharing the qualified signature type name', async () => {
    const source = 'void work(a::Options input) { b::Options local; }';
    const { helper } = evidence(source);
    const signatureType = { ...type('Options'), qualifiedName: 'a::Options' };
    const bodyType = { ...type('Options'), qualifiedName: 'b::Options' };
    expect(await helper.contains(node(source, 'void'), signatureType, site(source, 'Options'))).toBe(true);
    expect(await helper.contains(node(source, 'void'), bodyType, site(source, 'Options', source.indexOf('{')))).toBe(false);
    // Even an incorrectly resolved edge at the signature location cannot
    // contradict its explicit qualification and become a strong dependency.
    expect(await helper.contains(node(source, 'void'), bodyType, site(source, 'Options'))).toBe(false);
  });

  it('requires signature-site evidence for unqualified same-name types', async () => {
    const source = 'using a::Options;\nvoid work(Options input) { b::Options local; }';
    const { helper } = evidence(source);
    const signatureType = { ...type('Options'), qualifiedName: 'a::Options' };
    const bodyType = { ...type('Options'), qualifiedName: 'b::Options' };
    const callable = node(source, 'void');
    expect(await helper.contains(callable, signatureType, site(source, 'Options', source.indexOf('void')))).toBe(true);
    expect(await helper.contains(callable, bodyType, site(source, 'Options', source.indexOf('{')))).toBe(false);
    expect(await helper.contains(callable, signatureType, {})).toBe(false);
    expect(await helper.contains(callable, signatureType, { line: 2 })).toBe(false);
  });

  it('keeps C typedef signature types and C++ qualified member definitions', async () => {
    const c = 'Result work(Options input) { Scratch local; return input.result; }';
    const cpp = 'Result Service::work(Options input) { Scratch local; return {}; }';
    expect(await evidence(c).helper.contains(node(c, 'Result', 'work', 'c'), type('Options'))).toBe(true);
    expect(await evidence(cpp).helper.contains(node(cpp, 'Result'), type('Options'))).toBe(true);
  });

  it('does not invent type evidence for macro-generated or unlocatable signatures', async () => {
    const source = 'DECLARE_WORK(Result, Options)\nint different() { BodyOnly local; }';
    const { helper } = evidence(source);
    expect(await helper.contains(node(source, 'DECLARE_WORK'), type('Result'))).toBe(false);
    expect(await helper.contains(node(source, 'DECLARE_WORK'), type('BodyOnly'))).toBe(false);
  });

  it('preserves non-C/C++ edge semantics without source reads', async () => {
    const { helper, read } = evidence('');
    const callable = { ...node('int x;', 'int'), language: 'typescript' as const };
    expect(await helper.contains(callable, type('AnyType'))).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it('falls back to hash-verified source and refuses changed bytes, even at the same size', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-signature-freshness-'));
    roots.push(root);
    const source = 'Result work(Options value) { return {}; }';
    fs.writeFileSync(path.join(root, 'worker.cpp'), source);
    const graph = { getProjectRoot: () => root, getFile: () => ({ contentHash: createHash('sha256').update(source).digest('hex') }) };
    expect(await new CppSignatureTypeEvidence(graph).contains(node(source, 'Result'), type('Options'), site(source, 'Options'))).toBe(true);
    fs.writeFileSync(path.join(root, 'worker.cpp'), source.replace('Options', 'Changed'));
    expect(await new CppSignatureTypeEvidence(graph).contains(node(source, 'Result'), type('Changed'), site(source, 'Options'))).toBe(false);
  });
});

describe('Explore change-surface admission with stored C++ relation contracts', () => {
  it('rescues source-verified signature type files while leaving stored body references intact', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-signature-rescue-'));
    roots.push(root);
    const files = {
      'entry.cpp': '#include "options.hpp"\n#include "result.hpp"\n#include "scratch.hpp"\nResult runPipeline(Options options) { Scratch scratch; return Result{}; }\n',
      'options.hpp': 'struct Options { int limit; };\n',
      'result.hpp': 'struct Result { int value; };\n',
      'scratch.hpp': 'struct Scratch { int temporary; };\n',
    };
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, file), text);
    vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
    const initialized = CodeGraph.initSync(root);
    opened.push(initialized);
    await initialized.indexAll();
    initialized.close();
    // Explicitly own the writable fixture handle, then return to the public
    // read-only facade before testing Explore consumption.
    const writer = CodeGraph.openPortableRaw(root, path.join(root, '.codegraph-wx', 'codegraph.db'), false);
    opened.push(writer);
    const fixtureGraph = createUpstreamExploreGraph(writer);
    const entry = fixtureGraph.getNodesByName('runPipeline').find(n => !n.isDeclaration)!;
    expect(entry).toBeDefined();
    // Populate the three legal native relation shapes explicitly. This is a
    // consumer regression: extraction may attach a parameter reference to a
    // parameter node instead of its callable in this small fixture.
    const queries = new QueryBuilder(writer.getExploreQueryConnection());
    for (const [name, kind] of [['Options', 'references'], ['Result', 'returns'], ['Scratch', 'references']] as const) {
      const target = fixtureGraph.getNodesByName(name).find(n => ['class', 'struct'].includes(n.kind))!;
      expect(target).toBeDefined();
      queries.insertEdge({ source: entry.id, target: target.id, kind, line: 4,
        column: files['entry.cpp'].split('\n')[3]!.indexOf(name), provenance: 'tree-sitter' });
    }
    writer.close();
    const cg = CodeGraph.openSync(root);
    opened.push(cg);
    expect(() => cg.getExploreQueryConnection().prepare('UPDATE nodes SET name = name').run()).toThrow(/readonly|read.only/i);
    const graph = createUpstreamExploreGraph(cg);
    const raw = graph.getOutgoingEdges(entry.id);
    for (const target of ['Options', 'Result', 'Scratch']) {
      expect(raw.some(e => ['references', 'returns', 'type_of'].includes(e.kind)
        && graph.getNode(e.target)?.name === target), `${target} edge`).toBe(true);
    }
    // Keep the gather fixed so all three type files are buried. The real
    // handler must use the persisted graph and signature source to decide
    // which files deserve rescue; gathering itself is outside this regression.
    vi.spyOn(graph, 'findRelevantContext').mockResolvedValue({
      nodes: new Map([[entry.id, entry]]), edges: [], roots: [entry.id],
    });
    const sidecar = path.join(root, 'diagnostics.jsonl');
    vi.stubEnv('CODEGRAPH_EXPLORE_DEBUG', sidecar);
    const result = await new ToolHandler(graph).execute('codegraph_explore', { query: 'runPipeline', maxFiles: 4 });
    expect(result.isError).not.toBe(true);
    const report: ExploreDiagnosticReport = JSON.parse(fs.readFileSync(sidecar, 'utf8').trim().split('\n').at(-1)!);
    for (const file of ['options.hpp', 'result.hpp']) {
      const selected = report.files.find(f => f.path === file);
      expect(selected?.score, file).toBeGreaterThanOrEqual(45);
      expect(selected?.finalChars, file).toBeGreaterThan(0);
    }
    expect(report.files.some(f => f.path === 'scratch.hpp')).toBe(false);
    expect(graph.getOutgoingEdges(entry.id)).toEqual(raw);
  }, 30000);
});

describe('Signature evidence from actual native C++ extraction', () => {
  it('recovers an explicitly global signature dependency from real body references without rescuing a same-name type', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-signature-native-'));
    roots.push(root);
    const files = {
      'api_a.hpp': 'namespace a { struct Options { int value; }; }\n',
      'api_b.hpp': 'namespace b { struct Options { int value; }; }\n',
      'entry.cpp': '#include "api_a.hpp"\n#include "api_b.hpp"\n#define USE_TYPE(T) sizeof(T)\n'
        + 'int preserveSignatureType(::a::Options input) { return USE_TYPE(::a::Options) + USE_TYPE(::b::Options); }\n'
        + 'int relativeSignatureType(a::Options input) { return USE_TYPE(a::Options) + USE_TYPE(b::Options); }\n',
    };
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, file), text);
    vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
    const cg = CodeGraph.initSync(root);
    opened.push(cg);
    await cg.indexAll();
    const graph = createUpstreamExploreGraph(cg);
    const helper = new CppSignatureTypeEvidence(graph);
    const types = graph.getNodesByName('Options').filter(n => n.kind === 'struct');
    const a = types.find(n => n.qualifiedName === 'a::Options')!;
    const b = types.find(n => n.qualifiedName === 'b::Options')!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    for (const name of ['preserveSignatureType', 'relativeSignatureType']) {
      const callable = graph.getNodesByName(name).find(n => !n.isDeclaration)!;
      expect(callable).toBeDefined();
      const edges = graph.getOutgoingEdges(callable.id);
      const aEdge = edges.find(e => e.kind === 'references' && e.target === a.id);
      const bEdge = edges.find(e => e.kind === 'references' && e.target === b.id);
      expect(aEdge, JSON.stringify(edges)).toBeDefined();
      expect(bEdge, JSON.stringify(edges)).toBeDefined();
      const line = files['entry.cpp'].split('\n')[callable.startLine - 1]!;
      expect(aEdge!.column).toBeGreaterThan(line.indexOf('{'));
      expect(bEdge!.column).toBeGreaterThan(line.indexOf('{'));
      expect(await helper.contains(callable, a, aEdge!)).toBe(name === 'preserveSignatureType');
      expect(await helper.contains(callable, b, bEdge!)).toBe(false);
    }
    const entry = graph.getNodesByName('preserveSignatureType').find(n => !n.isDeclaration)!;
    const original = graph.getOutgoingEdges(entry.id);
    vi.spyOn(graph, 'findRelevantContext').mockResolvedValue({
      nodes: new Map([[entry.id, entry]]), edges: [], roots: [entry.id],
    });
    const sidecar = path.join(root, 'native-diagnostics.jsonl');
    vi.stubEnv('CODEGRAPH_EXPLORE_DEBUG', sidecar);
    const result = await new ToolHandler(graph).execute('codegraph_explore', { query: 'preserveSignatureType', maxFiles: 4 });
    expect(result.isError).not.toBe(true);
    const report: ExploreDiagnosticReport = JSON.parse(fs.readFileSync(sidecar, 'utf8').trim().split('\n').at(-1)!);
    expect(report.files.find(f => f.path === 'api_a.hpp')?.score).toBeGreaterThanOrEqual(45);
    expect(report.files.find(f => f.path === 'api_a.hpp')?.finalChars).toBeGreaterThan(0);
    expect(report.files.some(f => f.path === 'api_b.hpp')).toBe(false);
    expect(graph.getOutgoingEdges(entry.id)).toEqual(original);
  }, 30000);
});
