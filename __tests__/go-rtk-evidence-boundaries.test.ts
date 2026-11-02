
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import * as grammars from '../src/extraction/grammars';
import { synthesizeCallbackEdges } from '../src/resolution/callback-synthesizer';

const projects: Array<{ root: string; cg: CodeGraph }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { root, cg } of projects.splice(0)) {
    cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
async function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-go-rtk-boundaries-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const cg = CodeGraph.initSync(root);
  projects.push({ root, cg });
  await cg.indexAll();
  return { root, cg };
}
async function rebuildSynthesisFixture(cg: CodeGraph): Promise<CodeGraph> {
  const record = projects.find(project => project.cg === cg)!;
  cg.close();
  const writer = CodeGraph.openPortableRaw(record.root, path.join(record.root, '.codegraph-wx', 'codegraph.db'), false);
  try {
    // Synthesis is a writer operation; this isolated fixture owns that handle.
    const internal = writer as any;
    await synthesizeCallbackEdges(internal.queries, internal.resolver.context, { replaceExisting: true });
  } finally {
    writer.close();
    record.cg = CodeGraph.openSync(record.root);
  }
  expect(() => record.cg.getExploreQueryConnection().prepare('UPDATE nodes SET name = name').run()).toThrow(/readonly|read.only/i);
  return record.cg;
}
function thunkEdges(cg: CodeGraph, name: string, file?: string) {
  const nodes = cg.getNodesByName(name).filter(n => !file || n.filePath === file);
  return nodes.flatMap(n => cg.getOutgoingEdges(n.id))
    .filter(e => e.metadata?.synthesizedBy === 'redux-thunk')
    .map(e => ({ edge: e, target: cg.getNode(e.target)! }));
}
const factoryImport = "import { createAsyncThunk } from '@reduxjs/toolkit';\n";

describe('native Go/RTK evidence boundaries', () => {
  it('keeps Go package aliases, ignores multiline comments, and confines inference to the calling scope', async () => {
    const { cg } = await project({
      'go.mod': 'module example.com/check\n\ngo 1.22\n',
      'good/service.go': 'package good\ntype Service struct{}\nfunc(s *Service) Send(){}\n',
      'decoy/service.go': 'package decoy\ntype Service struct{}\nfunc(s *Service) Send(){}\n',
      'api/api.go': [
        'package api',
        'import chosen "example.com/check/good"',
        'type Wrong struct{}',
        'func(w *Wrong) Send(){}',
        'type Router struct {',
        ' /* multiline field prose:',
        ' worker *Wrong',
        ' */',
        ' worker *chosen.Service',
        '}',
        'func(r *Router) Send(){ r.worker.Send() }',
        'func seed(){ ghost := &Router{}; _ = ghost }',
        'func opaque(ghost any){ ghost.worker.Send() }',
      ].join('\n'),
    });
    const caller = cg.getNodesByName('Send').find(n => n.filePath === 'api/api.go' && n.qualifiedName.includes('Router'))!;
    expect(caller).toBeDefined();
    expect(cg.getCallees(caller.id).map(c => c.node.filePath)).toContain('good/service.go');
    expect(cg.getCallees(caller.id).filter(c => c.node.name === 'Send').map(c => c.node.filePath)).toEqual(['good/service.go']);
    const unknown = cg.getNodesByName('opaque')[0]!;
    expect(cg.getCallees(unknown.id).some(c => c.node.name === 'Send')).toBe(false);
  });


  it('does not take Go type evidence from struct tags, log strings or exited inner bindings', async () => {
    const tick = String.fromCharCode(96);
    const { cg } = await project({
      'go.mod': 'module example.com/check\n',
      'types.go': [
        'package app',
        'import "database/sql"',
        'type LocalStore struct{}',
        'func(s *LocalStore) Exec(){}',
        'type WrongStore struct{}',
        'func(s *WrongStore) Exec(){}',
        'type External struct {',
        ' info string ' + tick + 'json:"conn *LocalStore"' + tick,
        ' conn *sql.DB',
        '}',
        'type Good struct{ conn *LocalStore }',
        'type Wrong struct{ conn *WrongStore }',
        'func(h *External) Tag(){ h.conn.Exec() }',
        'func(h *Good) Log(){ _ = "h := Wrong{}"; h.conn.Exec() }',
        'func(h *Good) Exit(){ { h := &Wrong{}; _ = h }; h.conn.Exec() }',
        'func SameLine(){ h := &Good{}; { h := &Wrong{}; h.conn.Exec() } }',
        'func UnknownLine(){ h := &Good{}; { h = unknown(); h.conn.Exec() } }',
      ].join('\n'),
    });
    const calls = (name: string) => cg.getCallees(cg.getNodesByName(name)[0]!.id)
      .filter(x => x.node.name === 'Exec').map(x => x.node.qualifiedName);
    expect(calls('Tag')).toEqual([]);
    expect(calls('Log')).toHaveLength(1);
    expect(calls('Log')[0]).toContain('LocalStore');
    expect(calls('Exit').some(x => x.includes('WrongStore'))).toBe(false);
    expect(calls('SameLine')).toEqual([]);
    expect(calls('UnknownLine')).toEqual([]);
  });

  it('does not pick one of duplicate Go package-local method declarations by file order', async () => {
    const { cg } = await project({
      'go.mod': 'module example.com/check\n',
      'service.go': 'package app\ntype Service struct{}\ntype Router struct{ service *Service }\nfunc(r *Router) Start(){ r.service.Run() }\n',
      'a.go': 'package app\nfunc(s *Service) Run(){}\n',
      'b.go': 'package app\nfunc(s *Service) Run(){}\n',
    });
    expect(cg.getNodesByName('Run').filter(n => n.kind === 'method')).toHaveLength(2);
    const start = cg.getNodesByName('Start')[0]!;
    expect(cg.getCallees(start.id).some(c => c.node.name === 'Run')).toBe(false);
  });

  it('requires real AST dispatch calls, not strings, regex, comments or template text', async () => {
    const quote = String.fromCharCode(96);
    const { cg } = await project({
      'actions.ts': factoryImport + [
        "export const fake = createAsyncThunk('fake', async () => 0);",
        "export const real = createAsyncThunk('real', async () => 1);",
        "export const outer = createAsyncThunk('outer', async (_, { dispatch }) => {",
        ' const message = "dispatch(fake())";',
        ' const single = \'dispatch(fake())\';',
        ' const matcher = /dispatch(fake())/;',
        ' const template = ' + quote + 'dispatch(fake())' + quote + ';',
        ' // dispatch(fake());',
        ' /* dispatch(fake()); */',
        ' return dispatch(real());',
        '});',
      ].join('\n'),
    });
    const edges = thunkEdges(cg, 'outer');
    expect(edges.map(e => e.target.name)).toEqual(['real']);
    expect(edges[0]!.edge.line).toBe(11);
    expect(edges[0]!.edge.metadata?.registeredAt).toBe('actions.ts:11');
  });

  it('keeps local/imported bindings and does not guess a remote same-named thunk', async () => {
    const { cg } = await project({
      'a.ts': factoryImport + "export const action = createAsyncThunk('a', async () => 1);\n",
      'b.ts': factoryImport + "export const action = createAsyncThunk('b', async () => 2);\n",
      'caller.ts': factoryImport + [
        "import { action as selected } from './b';",
        'function action() { return { type: "local" }; }',
        "export const outer = createAsyncThunk('outer', async (_, { dispatch: send }) => {",
        ' send(action());',
        ' return send(selected());',
        '});',
      ].join('\n'),
      'unbound.ts': factoryImport + "export const unknown = createAsyncThunk('unknown', async (_, api) => api.dispatch(action()));\n",
      'shadowed.ts': factoryImport + [
        "import { action } from './a';",
        "export const shadowed = createAsyncThunk('shadowed', async (action, { dispatch }) => dispatch(action()));",
      ].join('\n'),
    });
    expect(thunkEdges(cg, 'outer').map(e => e.target.filePath).sort()).toEqual(['b.ts', 'caller.ts']);
    expect(thunkEdges(cg, 'unknown')).toEqual([]);
    expect(thunkEdges(cg, 'shadowed')).toEqual([]);
  });

  it('does not infer thunk edges into or out of C++ even in a mixed-language project', async () => {
    const { cg } = await project({
      'foreign.cpp': 'int foreignAction(){return 1;}\nconst auto cppThunk = createAsyncThunk("cpp", [](auto x, auto api){ dispatch(real()); });\n',
      'actions.ts': factoryImport + [
        "export const real = createAsyncThunk('real', async () => 1);",
        "export const outer = createAsyncThunk('outer', async (_, { dispatch }) => dispatch(foreignAction()));",
      ].join('\n'),
    });
    expect(cg.getNodesByName('foreignAction').some(n => n.language === 'cpp')).toBe(true);
    expect(cg.getNodesByName('cppThunk').some(n => n.kind === 'constant')).toBe(true);
    expect(thunkEdges(cg, 'outer')).toEqual([]);
    expect(thunkEdges(cg, 'cppThunk')).toEqual([]);
  });


  it('loads main-thread grammars when rebuilding synthesis after worker-only extraction', async () => {
    const { cg } = await project({
      'actions.ts': factoryImport + [
        "export const inner = createAsyncThunk('inner', async () => 1);",
        "export const outer = createAsyncThunk('outer', async (_, { dispatch }) => dispatch(inner()));",
      ].join('\n'),
    });
    const parse = grammars.getParser;
    const load = grammars.loadGrammarsForLanguages;
    let loaded = false;
    vi.spyOn(grammars, 'getParser').mockImplementation(lang => loaded ? parse(lang) : null);
    vi.spyOn(grammars, 'loadGrammarsForLanguages').mockImplementation(async langs => {
      await load(langs); loaded = true;
    });
    const reader = await rebuildSynthesisFixture(cg);
    expect(loaded).toBe(true);
    expect(thunkEdges(reader, 'outer')).toHaveLength(1);
  });


  it('treats rewritten dispatch/API bindings as opaque rather than Redux calls', async () => {
    const { cg } = await project({
      'actions.ts': factoryImport + [
        "export const real = createAsyncThunk('real', async () => 1);",
        "export const rewritten = createAsyncThunk('r', async (_, { dispatch }) => {",
        ' dispatch = customDispatch; return dispatch(real());',
        '});',
        "export const rewrittenApi = createAsyncThunk('r', async (_, api) => {",
        ' api.dispatch = customDispatch; return api.dispatch(real());',
        '});',
      ].join('\n'),
    });
    expect(thunkEdges(cg, 'rewritten')).toEqual([]);
    expect(thunkEdges(cg, 'rewrittenApi')).toEqual([]);
  });

  it('does not load synthesis grammars for a JS/C++ project without a JS thunk candidate', async () => {
    const { cg } = await project({
      'plain.ts': 'export const value = 1;\n',
      'fake.cpp': 'const auto cppThunk = createAsyncThunk("cpp", [](auto x, auto api){ dispatch(value()); });\n',
    });
    const load = vi.spyOn(grammars, 'loadGrammarsForLanguages');
    await rebuildSynthesisFixture(cg);
    expect(load).not.toHaveBeenCalled();
  });

  it('withdraws removed dispatch edges on sync while retaining C++ declaration-definition relations', async () => {
    const initial = factoryImport + [
      "export const inner = createAsyncThunk('inner', async () => 1);",
      "export const outer = createAsyncThunk('outer', async (_, { dispatch }) => dispatch(inner()));",
    ].join('\n');
    const { root, cg } = await project({
      'actions.ts': initial,
      'worker.h': 'class Worker { public: int work(); };\n',
      'worker.cpp': '#include "worker.h"\nint Worker::work() { return 1; }\n',
    });
    expect(thunkEdges(cg, 'outer')).toHaveLength(1);
    fs.writeFileSync(path.join(root, 'actions.ts'), initial.replace('dispatch(inner())', '0'));
    await cg.sync({ paths: ['actions.ts'] });
    expect(thunkEdges(cg, 'outer')).toEqual([]);
    const cpp = cg.getNodesByName('work');
    expect(cpp.flatMap(n => cg.getOutgoingEdges(n.id)).some(e => e.kind === 'defines')).toBe(true);
  });
});

