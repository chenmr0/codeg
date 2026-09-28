import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['c', 'cpp']);
});

describe.each(['c', 'cpp'] as const)('%s typedef declarator identity', language => {
  const run = (source: string) => extractFromSource(`identity.${language}`, source, language);
  const aliases = (source: string) => run(source).nodes.filter(n => n.kind === 'type_alias').map(n => n.name);

  it('does not redeclare the source type, but preserves its real declaration', () => {
    const result = run('typedef int Existing;\ntypedef Existing Alias;');
    expect(result.nodes.filter(n => n.kind === 'type_alias').map(n => [n.name, n.startLine]))
      .toEqual([['Existing', 1], ['Alias', 2]]);
  });

  it('collects all sibling declarators without borrowing parameters or bounds', () => {
    expect(aliases('typedef Existing Alias, *Pointer, Array[4], (*Callback)(int argument);'))
      .toEqual(['Alias', 'Pointer', 'Array', 'Callback']);
  });

  it.each([
    ['typedef unsigned char Check[sizeof(short) == 2 ? 1 : -1];', ['Check']],
    ['typedef int (*Callback)(int parameter);', ['Callback']],
    ['typedef int (*Factory(int parameter))(double);', ['Factory']],
    ['typedef const char *Text;', ['Text']],
    ['typedef int A, B, C;', ['A', 'B', 'C']],
    ['typedef int APIENTRYP;', ['APIENTRYP']],
  ] as Array<[string, string[]]>)('keeps legal names in %s', (source, names) => {
    expect(aliases(source)).toEqual(names);
  });

  it('preserves the existing tag and field ownership contract', () => {
    const r = run('typedef struct Tag { int value; } Alias, *Pointer;');
    expect(r.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'struct', name: 'Alias' }),
      expect.objectContaining({ kind: 'type_alias', name: 'Tag' }),
      expect.objectContaining({ kind: 'type_alias', name: 'Pointer' }),
      expect.objectContaining({ kind: 'field', qualifiedName: 'Alias::value' }),
    ]));
    const owner = r.nodes.find(n => n.kind === 'struct' && n.name === 'Alias')!;
    const field = r.nodes.find(n => n.kind === 'field' && n.name === 'value')!;
    expect(r.edges.some(e => e.kind === 'contains' && e.source === owner.id && e.target === field.id)).toBe(true);
  });

  it('does not change using declarations or lose declarations after damaged macros', () => {
    const source = language === 'cpp'
      ? 'using Kept = int;\ntypedef void (APIENTRYP Callback)(int);\nint after(int);'
      : 'typedef int Kept;\ntypedef void (APIENTRYP Callback)(int);\nint after(int);';
    const r = run(source);
    expect(r.nodes.some(n => n.kind === 'type_alias' && n.name === 'Kept')).toBe(true);
    expect(r.nodes.some(n => n.kind === 'function' && n.name === 'after')).toBe(true);
  });
});

describe('anonymous C++ enum underlying types', () => {
  it.each(['u32', 'n::u32', '::n::u32'])('does not use %s as the enum name or member owner', base => {
    const r = extractFromSource('enum.cpp', `namespace n { using u32 = unsigned; }\nusing u32 = unsigned;\nstruct Device { enum : ${base} { CLOCK = 1 }; };`, 'cpp');
    const owner = r.nodes.find(n => n.kind === 'struct' && n.name === 'Device')!;
    const member = r.nodes.find(n => n.kind === 'enum_member' && n.name === 'CLOCK')!;
    expect(member?.qualifiedName).toBe('Device::CLOCK');
    expect(r.nodes.some(n => n.kind === 'enum' && n.name === 'u32')).toBe(false);
    expect(r.edges.some(e => e.kind === 'contains' && e.source === owner.id && e.target === member.id)).toBe(true);
  });

  it('preserves named and scoped enums with comments and qualified bases', () => {
    const r = extractFromSource('enum.cpp', `namespace n { using u32 = unsigned; }
enum /* : not an anonymous enum */ Named : n::u32 { A };
enum class Scoped : n::u32 { B };`, 'cpp');
    for (const name of ['Named', 'Scoped']) {
      expect(r.nodes.some(n => n.kind === 'enum' && n.name === name)).toBe(true);
    }
    expect(r.nodes.filter(n => n.kind === 'enum_member').map(n => n.qualifiedName)).toEqual(['Named::A', 'Scoped::B']);
  });

  it('handles an anonymous head with comments and line breaks', () => {
    const r = extractFromSource('enum.cpp', `using u32 = unsigned;
namespace outer { enum /* note */
: u32 { READY = 1 }; }`, 'cpp');
    expect(r.nodes.some(n => n.kind === 'enum_member' && n.qualifiedName === 'outer::READY')).toBe(true);
    expect(r.nodes.some(n => n.kind === 'enum' && n.name === 'u32')).toBe(false);
  });

  it('does not disturb neighboring declarations when enum attributes are unsupported by the grammar', () => {
    // This grammar parses enum [[...]] as an attributed_statement, not an
    // enum_specifier. Do not broaden this fix into regex type recovery.
    const r = extractFromSource('enum.cpp', `using u32=unsigned;
enum [[maybe_unused]] Attributed : u32 { VALUE };
enum Kept : u32 { READY }; int after();`, 'cpp');
    expect(r.nodes.some(n => n.kind === 'enum' && n.name === 'Kept')).toBe(true);
    expect(r.nodes.some(n => n.kind === 'enum_member' && n.qualifiedName === 'Kept::READY')).toBe(true);
    expect(r.nodes.some(n => n.kind === 'function' && n.name === 'after')).toBe(true);
  });

  it('does not invent a tag for an anonymous fixed-base typedef enum', () => {
    const r = extractFromSource('enum.cpp', 'using u32 = unsigned;\ntypedef enum : u32 { READY=1 } State;', 'cpp');
    expect(r.nodes.some(n => n.kind === 'enum' && n.name === 'State')).toBe(true);
    expect(r.nodes.some(n => n.kind === 'enum_member' && n.qualifiedName === 'State::READY')).toBe(true);
    expect(r.nodes.filter(n => n.name === 'u32' && n.startLine === 2)).toHaveLength(0);
  });
});
