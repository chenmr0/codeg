import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { getParser, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(() => loadGrammarsForLanguages(['cpp']));
describe('C++ member comparisons do not swallow later definitions', () => {
  it.each(['.', '->'])('parses %s member comparisons and preserves function/call ownership', access => {
    const source = `void earlier() { if (a${access}x < 1 || a${access}y < 1) { inside(); } }
static int later(void) { return callee(); }`;
    const tree = getParser('cpp')!.parse(source)!;
    try { expect(tree.rootNode.hasError).toBe(false); } finally { tree.delete(); }
    const result = extractFromSource('comparison.cpp', source, 'cpp');
    const later = result.nodes.filter(n => n.name === 'later');
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({kind:'function',startLine:2,endLine:2,isStatic:true});
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({fromNodeId:later[0]!.id,referenceName:'callee',referenceKind:'calls'}),
    ]));
    expect(result.nodes.some(n => n.name === 'earlier')).toBe(true);
  });
  it('keeps member templates, namespace ownership, raw strings and comments distinct', () => {
    const source = `namespace n {
template<class T> void real(T a) { a.template call<1>(); }
const char* text = R"tag(static int ghost() { return 1; })tag";
/* static int phantom() { return 2; } */
static int later() { return 3; }
}`;
    const result = extractFromSource('templates.cpp',source,'cpp');
    expect(result.nodes.find(n=>n.name==='later')?.qualifiedName).toBe('n::later');
    expect(result.nodes.some(n=>['ghost','phantom'].includes(n.name))).toBe(false);
    expect(result.nodes.some(n=>n.name==='real')).toBe(true);
  });
  it.each(['\n','\r\n'])('preserves forwards and real function coordinates in a damaged header (%j)', newline => {
    const source = [
      '/* 中文 header */', '#ifndef GUARD', '#define GUARD', 'class Forward;',
      'struct Record;', 'enum class Mode : int;', 'namespace ns {', 'class Wrapper {', 'public:',
      'struct Options {', '#ifdef DEBUG', 'void validate() const {}', '#endif', '};',
      'struct Args { UNKNOWN(void validate() const;) };',
      'void run(const Args& args) { UNKNOWN(args.validate();) }',
      'static void bounds(const Point&, Rect*);', 'virtual Support support(const Shape&) const {}',
      '};', '}', '#endif', 'static int later() { return callee(); }', '',
    ].join(newline);
    const result = extractFromSource('wrapped.hpp',source,'cpp');
    for (const [name,kind,line] of [['Forward','class',4],['Record','struct',5],['Mode','enum',6]]) {
      expect(result.nodes.find(n=>n.name===name)).toMatchObject({kind,startLine:line,isDeclaration:true});
    }
    expect(result.nodes.filter(n=>n.name==='GUARD').map(n=>n.kind)).toEqual(['macro']);
    const later = result.nodes.filter(n=>n.name==='later');
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({kind:'function',startLine:22,endLine:22,qualifiedName:'later',isStatic:true,signature:'int later()'});
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({fromNodeId:later[0]!.id,referenceName:'callee'}));
    expect(result.errors).toEqual([]);
  });
});
