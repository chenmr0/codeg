
import { beforeAll, afterEach, describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { matchReference } from '../src/resolution/name-matcher';
import type { ResolutionContext } from '../src/resolution/types';
import type { Node } from '../src/types';

const projects: Array<{ cg: CodeGraph; root: string }> = [];
beforeAll(async () => { await initGrammars(); await loadAllGrammars(); });
afterEach(() => {
  for (const { cg, root } of projects.splice(0)) {
    cg.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
async function index(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-ts-field-receiver-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const cg = CodeGraph.initSync(root); projects.push({ cg, root });
  await cg.indexAll(); return cg;
}
function callees(cg: CodeGraph, owner: string, name = 'close') {
  const node = cg.getNodesByName(name).find(n => n.kind === 'method' && n.qualifiedName === owner + '::' + name);
  expect(node, owner + '::' + name).toBeDefined();
  return cg.getOutgoingEdges(node!.id).filter(e => e.kind === 'calls')
    .map(e => cg.getNode(e.target)?.qualifiedName).sort();
}

describe('TS/JS this.field calls use declared receiver evidence', () => {
  it('resolves fields and constructor parameter properties onto their type, never the wrapper', async () => {
    const cg = await index({ 'main.ts': [
      'interface Socket { close(): void; }',
      'class FieldWrapper {',
      '  private socket: Socket;',
      '  close() { this.socket.close(); }',
      '}',
      'class ParamWrapper {',
      '  constructor(private readonly socket: Socket) {}',
      '  close() { this.socket.close(); }',
      '}',
    ].join('\n') });
    expect(callees(cg, 'FieldWrapper')).toEqual(['Socket::close']);
    expect(callees(cg, 'ParamWrapper')).toEqual(['Socket::close']);
  });

  it('resolves explicit JS new initializers in a field or constructor, including private fields', async () => {
    const cg = await index({ 'main.js': [
      'class Backend { close() {} }',
      'class FieldWrapper {',
      '  socket = new Backend();',
      '  close() { this.socket.close(); }',
      '}',
      'class ConstructorWrapper {',
      '  constructor() { this.socket = new Backend(); }',
      '  close() { this.socket.close(); }',
      '}',
      'class PrivateWrapper {',
      '  #socket = new Backend();',
      '  close() { this.#socket?.close(); }',
      '}',
    ].join('\n') });
    for (const owner of ['FieldWrapper', 'ConstructorWrapper', 'PrivateWrapper']) {
      expect(callees(cg, owner)).toEqual(['Backend::close']);
    }
  });

  it('honors a resolved import alias and does not use a project namesake for an external import', async () => {
    const cg = await index({
      'backend.ts': 'export class Backend { close() {} }\n',
      'alias.ts': [
        "import { Backend as Link } from './backend';",
        'class AliasWrapper {',
        '  constructor(private socket: Link) {}',
        '  close() { this.socket.close(); }',
        '}',
      ].join('\n'),
      'external.ts': [
        "import { Backend } from 'external-sdk';",
        'class ExternalWrapper {',
        '  constructor(private socket: Backend) {}',
        '  close() { this.socket.close(); }',
        '}',
      ].join('\n'),
      'namespace.ts': [
        "import * as sdk from 'external-sdk';",
        'class NamespaceWrapper {',
        '  constructor(private socket: sdk.Backend) {}',
        '  close() { this.socket.close(); }',
        '}',
      ].join('\n'),
    });
    expect(callees(cg, 'AliasWrapper')).toEqual(['Backend::close']);
    expect(callees(cg, 'ExternalWrapper')).toEqual([]);
    expect(callees(cg, 'NamespaceWrapper')).toEqual([]);
  });

  it('does not bind an unimported type to the only matching export in another module', async () => {
    const cg = await index({
      'backend.ts': 'export class Backend { close() {} }\n',
      'wrapper.ts': [
        'export class Wrapper {',
        '  constructor(private socket: Backend) {}',
        '  close() { this.socket.close(); }',
        '}',
      ].join('\n'),
    });
    expect(callees(cg, 'Wrapper')).toEqual([]);
  });

  it.each(['wrapper.ts', 'backend.ts'])('requires same-file proof for an unimported qualified type (%s)', targetFile => {
    // Exercise the resolver's qualified graph input directly. Native TS namespace
    // extraction currently flattens these names; changing that is a separate task.
    const source = [
      'class Wrapper {',
      '  socket: BackendNS.Backend;',
      '  close() { this.socket.close(); }',
      '}',
      'namespace BackendNS { export class Backend { close() {} } }',
    ].join('\n');
    const node = (id: string, kind: Node['kind'], qualifiedName: string, filePath = 'wrapper.ts'): Node => ({
      id, kind, name: qualifiedName.split('::').at(-1)!, qualifiedName, filePath,
      language: 'typescript', startLine: 1, endLine: 4, startColumn: 0, endColumn: 1, updatedAt: 1,
    });
    const nodes: Node[] = [
      node('wrapper', 'class', 'Wrapper'),
      { ...node('field', 'property', 'Wrapper::socket'), startLine: 2, endLine: 2,
        signature: 'BackendNS.Backend socket' },
      { ...node('caller', 'method', 'Wrapper::close'), startLine: 3, endLine: 3 },
      node('backend', 'class', 'BackendNS::Backend', targetFile),
      node('target', 'method', 'BackendNS::Backend::close', targetFile),
    ];
    const context: ResolutionContext = {
      getNodesInFile: file => nodes.filter(n => n.filePath === file),
      getNodesByName: name => nodes.filter(n => n.name === name),
      getNodesByQualifiedName: name => nodes.filter(n => n.qualifiedName === name),
      getNodesByKind: kind => nodes.filter(n => n.kind === kind),
      getNodesByLowerName: name => nodes.filter(n => n.name.toLowerCase() === name),
      getImportMappings: () => [],
      getProjectRoot: () => '/fixture',
      getAllFiles: () => ['wrapper.ts', 'backend.ts'],
      fileExists: () => true,
      readFile: () => source,
    };
    const result = matchReference({
      fromNodeId: 'caller', referenceName: 'this.socket.close', referenceKind: 'calls',
      line: 3, column: 12, filePath: 'wrapper.ts', language: 'typescript',
    }, context);
    expect(result?.targetNodeId ?? null).toBe(targetFile === 'wrapper.ts' ? 'target' : null);
  });

  it('keeps unknown, primitive, union and ordinary constructor parameters unresolved', async () => {
    const cg = await index({ 'main.ts': [
      'class First { close() {} }',
      'class Second { close() {} }',
      'class Unknown { socket: any; close() { this.socket.close(); } }',
      'class External { socket: OutsideSdk; close() { this.socket.close(); } }',
      'class Primitive { socket: string[]; close() { this.socket.close(); } }',
      'class Union { socket: First | Second; close() { this.socket.close(); } }',
      'class ParameterOnly {',
      '  constructor(socket: First) {}',
      '  close() { this.socket.close(); }',
      '}',
    ].join('\n') });
    for (const owner of ['Unknown', 'External', 'Primitive', 'Union', 'ParameterOnly']) {
      expect(callees(cg, owner)).toEqual([]);
    }
  });

  it('does not guess between ambiguous types or conflicting inferred initializers', async () => {
    const cg = await index({
      'left.ts': 'export class Shared { close() {} }\n',
      'right.ts': 'export class Shared { close() {} }\n',
      'wrapper.ts': [
        'class Ambiguous { socket: Shared; close() { this.socket.close(); } }',
        'class First { close() {} }',
        'class Second { close() {} }',
        'class Assigned {',
        '  constructor(flag: boolean) {',
        '    if (flag) { this.socket = new First(); }',
        '    else { this.socket = new Second(); }',
        '  }',
        '  close() { this.socket.close(); }',
        '}',
      ].join('\n'),
    });
    expect(callees(cg, 'Ambiguous')).toEqual([]);
    expect(callees(cg, 'Assigned')).toEqual([]);
  });

  it('retains genuine direct this recursion', async () => {
    const cg = await index({ 'main.ts': [
      'class Recursive {',
      '  close(n: number) { if (n > 0) this.close(n - 1); }',
      '}',
    ].join('\n') });
    expect(callees(cg, 'Recursive')).toEqual(['Recursive::close']);
  });

  it('does not use a local object, comment or string as a class field declaration', async () => {
    const cg = await index({ 'main.ts': [
      'class Backend { close() {} }',
      'class Opaque {',
      '  // socket: Backend',
      '  note = "socket = new Backend()";',
      '  close() {',
      '    const local: { socket: Backend } = {} as any;',
      '    this.socket.close();',
      '  }',
      '}',
    ].join('\n') });
    expect(callees(cg, 'Opaque')).toEqual([]);
  });
});

