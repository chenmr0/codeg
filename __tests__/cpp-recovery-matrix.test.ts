import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(() => loadGrammarsForLanguages(['c', 'cpp']));
const prefix = [
  '#ifndef HEADER_GUARD', '#define HEADER_GUARD', 'class Forward;', 'struct Record;',
  'namespace ns {', 'class Wrapper {', 'public:', 'struct Options {', '#ifdef DEBUG',
  'void validate() const {}', '#endif', '};', 'struct Args { UNKNOWN(void validate() const;) };',
  'void run(const Args& args) { UNKNOWN(args.validate();) }', 'static void bounds(const Point&, Rect*);',
  'virtual Support support(const Shape&) const {}', '};', '}', '#endif', '',
].join('\n');

describe('extended C++ damaged-header recovery', () => {
  it.each([
    ['multiline', 'static int recovered(\n int x\n) {\n return downstream(x);\n}\n'],
    ['indented', '    static int recovered(int x) { return downstream(x); }\n'],
    ['two-functions', 'static int recovered(int x) { return downstream(x); }\nstatic int next() { return recovered(1); }\n'],
    ['template-neighbor', 'template<class T> T identity(T x) { return x; }\nstatic int recovered(int x) { return downstream(x); }\n'],
  ])('preserves coordinates and calls for %s', (_, tail) => {
    const source = prefix + tail;
    const result = extractFromSource('matrix.hpp', source, 'cpp');
    const offset = source.indexOf('static int recovered');
    const expectedLine = source.slice(0, offset).split('\n').length;
    const expectedColumn = offset - source.lastIndexOf('\n', offset) - 1;
    const recovered = result.nodes.filter(n => n.name === 'recovered');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ kind: 'function', qualifiedName: 'recovered', startLine: expectedLine, startColumn: expectedColumn, isStatic: true });
    expect(recovered[0]!.signature).toContain('recovered');
    expect(result.nodes.find(n => n.name === 'Forward')).toMatchObject({ kind: 'class', isDeclaration: true, startLine: 3 });
    expect(result.nodes.filter(n => n.name === 'HEADER_GUARD').map(n => n.kind)).toEqual(['macro']);
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ fromNodeId: recovered[0]!.id, referenceName: 'downstream' }));
    if (tail.includes('static int next')) expect(result.nodes.filter(n => n.name === 'next')).toHaveLength(1);
  });

  it('does not manufacture symbols from macros, comments, strings or raw strings', () => {
    const source = prefix + [
      '#define MAKE_FN static int macro_ghost() { return 1; }',
      '/* static int comment_ghost() { return 1; } */',
      'const char* text = "static int string_ghost() { return 1; }";',
      'const char* raw = R"tag(', 'static int raw_ghost() { return 1; }', ')tag";',
      'static int recovered() { return 1; }', '',
    ].join('\n');
    const result = extractFromSource('ghosts.hpp', source, 'cpp');
    expect(result.nodes.filter(n => n.name.endsWith('_ghost'))).toEqual([]);
    expect(result.nodes.filter(n => n.name === 'recovered')).toHaveLength(1);
  });

  it.each(['\n', '\r\n'])('rejects a macro-continuation wrapper with %j line endings', (newline) => {
    const source = (prefix + '#define MAKE_FN \\\nstatic int macro_ghost() { return 1; }\nstatic int recovered() { return 2; }\n').replaceAll('\n', newline);
    const result = extractFromSource('continuation.hpp', source, 'cpp');
    expect(result.nodes.filter(n => n.name === 'macro_ghost')).toEqual([]);
    expect(result.nodes.filter(n => n.name === 'MAKE_FN' && n.kind === 'macro')).toHaveLength(1);
    expect(result.nodes.filter(n => n.name === 'recovered')).toEqual([expect.objectContaining({
      kind: 'function', startLine: source.slice(0, source.indexOf('static int recovered')).split('\n').length,
      signature: 'int recovered()',
    })]);
    // The malformed prefix itself loses the namespace wrapper in tree-sitter.
    // Macro recovery must preserve its existing class, not invent ownership.
    const baseline = extractFromSource('baseline.hpp', prefix + 'static int ordinary() { return 1; }\n', 'cpp');
    expect(result.nodes.find(n => n.name === 'Wrapper')).toMatchObject({
      kind:'class', startLine:6, qualifiedName:baseline.nodes.find(n => n.name === 'Wrapper')!.qualifiedName,
    });
  });

  it('keeps namespace methods and a global function separate in healthy C++', () => {
    const source = 'namespace owner { class Box { public: int run() const { return 1; } }; }\nstatic int outside() { return 2; }\n';
    const result = extractFromSource('healthy.hpp', source, 'cpp');
    expect(result.nodes.find(n => n.name === 'run')?.qualifiedName).toBe('owner::Box::run');
    expect(result.nodes.find(n => n.name === 'outside')).toMatchObject({ kind: 'function', qualifiedName: 'outside', startLine: 2 });
    expect(result.errors).toEqual([]);
  });
});
