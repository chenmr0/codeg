import { describe, expect, it } from 'vitest';
import type { Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import { cppCallArityCompatibility } from '../src/resolution/cpp-call-admission';
import { matchByExactName, matchByQualifiedName, matchFuzzy } from '../src/resolution/name-matcher';

function fixture(call: string, signatures: string[], name = 'run') {
  const nodes: Node[] = signatures.map((signature, i) => ({ id: String(i), name, signature,
    kind: 'function', qualifiedName: name, language: 'cpp', filePath: 'a.cpp',
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 1 }));
  const ref: UnresolvedRef = { fromNodeId: 'caller', referenceName: name, referenceKind: 'calls',
    filePath: 'a.cpp', language: 'cpp', line: 2, column: 0 };
  const source = signatures.join('; ') + ';\n' + call;
  const context: ResolutionContext = {
    getNodesByName: name => nodes.filter(n => n.name === name),
    getNodesByQualifiedName: name => nodes.filter(n => n.qualifiedName === name),
    getNodesByLowerName: name => nodes.filter(n => n.name.toLowerCase() === name),
    getNodesInFile: file => nodes.filter(n => n.filePath === file), getNodesByKind: kind => nodes.filter(n => n.kind === kind),
    readFile: file => file === 'a.cpp' ? source : null, getFileLines: () => source.split('\n'),
    fileExists: file => file === 'a.cpp', getAllFiles: () => ['a.cpp'], getProjectRoot: () => '.', getImportMappings: () => [],
  };
  return { nodes, ref, context };
}

describe('ordinary C++ call arity evidence', () => {
  it.each([
    ['run(1)', 'void run()', 'incompatible'],
    ['run()', 'void run(int value)', 'incompatible'],
    ['run(1)', 'void run(int value)', 'compatible'],
    ['run()', 'void run(int value = 7)', 'compatible'],
    ['run(1, 2, 3)', 'void run(int value, ...)', 'compatible'],
    ['run()', 'void run(Args... values)', 'compatible'],
    ['run(callback)', 'void run(void (*callback)(int, int))', 'compatible'],
    ['run(1)', 'void run(int value,', 'unknown'],
    ['run(values...)', 'void run(int first, int second)', 'unknown'],
    ['run(pair<int, int>{})', 'void run(Pair value)', 'unknown'],
    ['run(x < y, z > w)', 'void run(bool first, bool second)', 'unknown'],
    ['run(x < y, z > w)', 'void run(bool first)', 'unknown'],
    ['run(1, 2)', 'void run(bool first = 1 < 2, bool second = 3 > 2)', 'unknown'],
    ['run(values >> 2, other << 1)', 'void run(int first, int second)', 'unknown'],
  ])('%s against %s is %s', (call, signature, expected) => {
    const { nodes, ref, context } = fixture(call, [signature]);
    expect(cppCallArityCompatibility(nodes[0]!, ref, context)).toBe(expected);
  });

  it('retains defaults supplied by a separate declaration', () => {
    const { nodes, ref, context } = fixture('run()', ['void run(int value)', 'void run(int value = 7)']);
    nodes[1]!.isDeclaration = true;
    expect(cppCallArityCompatibility(nodes[0]!, ref, context)).not.toBe('incompatible');
  });

  it('keeps macro-expanded commas unknown', () => {
    const { nodes, ref, context } = fixture('run(ARGS)', ['void run(int first, int second)']);
    nodes.push({ ...nodes[0]!, id: 'macro', kind: 'macro', name: 'ARGS', qualifiedName: 'ARGS', signature: '#define ARGS 1, 2' });
    expect(cppCallArityCompatibility(nodes[0]!, ref, context)).toBe('unknown');
  });

  it('filters before exact, qualified and fuzzy selection', () => {
    const f = fixture('run(1)', ['void run()', 'void run(int value)']);
    expect(matchByExactName(f.ref, f.context)?.targetNodeId).toBe('1');
    expect(matchFuzzy(f.ref, f.context)?.targetNodeId).toBe('1');
    f.nodes.forEach(n => { n.qualifiedName = 'api::run'; });
    f.ref.referenceName = 'api::run';
    f.context.readFile = () => 'void run(); void run(int);\napi::run(1)';
    f.context.getFileLines = () => ['void run(); void run(int);', 'api::run(1)'];
    expect(matchByQualifiedName(f.ref, f.context)?.targetNodeId).toBe('1');
  });
});
