import { beforeAll, describe, expect, it } from 'vitest';
import { detectLanguage, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { extractFromSource } from '../src/extraction/tree-sitter';

describe('.h struct inheritance language detection', () => {
  it.each([
    ['implicit public base', 'struct Receiver : Left {};'],
    ['final with inheritance', 'struct Receiver final : Left {};'],
    ['final definition', 'struct Receiver final {};'],
    ['qualified base', 'struct Receiver : owners::Left {};'],
    ['globally qualified base', 'struct Receiver : ::owners::Left {};'],
    ['qualified record', 'struct Outer::Receiver : Left {};'],
    ['qualified final record', 'struct Outer :: Receiver final : Left {};'],
    ['multiple bases', 'struct Receiver : Left, Right {};'],
    ['access-qualified multiple bases', 'struct Receiver : public Left, protected Right {};'],
    ['virtual access-qualified base', 'struct Receiver : virtual public Left {};'],
    ['access-qualified virtual base', 'struct Receiver : private virtual Left {};'],
    ['template base', 'struct Receiver : owners::Base<int, 2> {};'],
    ['nested template base', 'struct Receiver : owners::Base<owners::Pair<int, long>, 2> {};'],
    ['template-qualified base', 'struct Receiver : owners::Base<int>::Nested<long> {};'],
    ['empty template base', 'struct Receiver : Base<> {};'],
    ['template pointer and integral arguments', 'struct Receiver : Base<const Item*, 2UL> {};'],
    ['multiple template bases', 'struct Receiver : Base<int>, Other<Box<long>> {};'],
    ['multiline inheritance', 'struct\nReceiver\n:\nLeft\n{};'],
    ['multiline final inheritance', 'struct\r\nReceiver\r\nfinal\r\n:\r\nLeft\r\n{};'],
    ['comments within declaration head', 'struct /* tag */ Receiver /* base */ : /* name */ Left {};'],
  ])('recognizes %s', (_label, source) => {
    expect(detectLanguage('record.h', source)).toBe('cpp');
  });

  it('recognizes inheritance after a large C macro prefix', () => {
    const source = '#define DATA_ROW(x) x\n'.repeat(600) + 'struct Derived : Base {};';
    expect(source.indexOf('struct')).toBeGreaterThan(8192);
    expect(detectLanguage('record.h', source)).toBe('cpp');
  });

  it.each([
    ['named record', 'struct Record { int value; };'],
    ['anonymous record', 'typedef struct { int value; } Record;'],
    ['nested anonymous record', 'struct Record { struct { int value; }; };'],
    ['named bitfields', 'struct Flags { unsigned ready : 1; unsigned size : 7; };'],
    ['anonymous bitfields', 'struct Flags { unsigned : 0; unsigned ready : 1; };'],
    ['ternary bitfield width', 'struct Flags { unsigned size : ENABLED ? 3 : 1; };'],
    ['function-pointer member', 'struct Callbacks { int (*step)(int value); };'],
    ['global function pointer', 'struct Record *(*make_record)(void);'],
    ['global C function', 'int step(int value) { return value + 1; }'],
    ['global function returning a record', 'struct Record make_record(void) { struct Record r = {0}; return r; }'],
    ['record tag ending in final', 'struct Recordfinal { int value; };'],
    ['variable named final', 'struct Record final;'],
    ['forward declaration', 'struct Record;'],
    ['macro generic association', 'struct Foo { int value; };\n#define IS_FOO(x) _Generic((x), struct Foo: 1, default: 0)'],
    ['inline generic association', 'struct Foo { int value; };\nstatic inline int is_foo(struct Foo x) { return _Generic(x,struct Foo:1,default:0); }'],
    ['macro identifier generic association', 'struct Foo { int value; };\n#define IS_FOO(x) _Generic((x), struct Foo: match, default: fallback)'],
    ['inline identifier generic association', 'struct Foo { int value; };\nstatic inline int is_foo(struct Foo x) { int match = 1; return _Generic(x, struct Foo: match, default: 0); }'],
    ['generic association before a later body', 'struct Foo { int value; };\nstatic inline int is_foo(struct Foo x) { int match = 1; if (_Generic(x, struct Foo: match, default: 0)) { return 1; } return 0; }'],
    ['generic comparison expression', 'struct Foo { int value; };\n#define IS_FOO(x) _Generic((x), struct Foo: low < middle > high, default: 0)\nint after(void) { return 0; }'],
    ['generic compound literal expression', 'struct Foo { int value; };\n#define COPY_FOO(x) _Generic((x), struct Foo: (struct Foo){1}, default: (struct Foo){0})'],
  ])('preserves C for %s', (_label, source) => {
    expect(detectLanguage('record.h', source)).toBe('c');
  });

  it.each([
    ['missing base', 'struct Receiver : {};'],
    ['missing body', 'struct Receiver : Base;'],
    ['unclosed template', 'struct Receiver : Base<int {};'],
    ['unsupported template expression', 'struct Receiver : Base<compute()> {};'],
    ['unproven function-like base', 'struct Receiver : Base(extra) {};'],
    ['association-like continuation', 'struct Receiver : Base, Other: value;\nvoid after(void) {}'],
  ])('does not promote an incomplete or unsupported head: %s', (_label, source) => {
    expect(detectLanguage('record.h', source)).toBe('c');
  });

  it.each([
    ['line comment', '// struct Fake : Base {};\n'],
    ['block comment', '/* struct Fake final : Base {}; */'],
    ['string literal', 'const char *text = "struct Fake : Base {};";'],
    ['escaped string literal', 'const char *text = "\\\" struct Fake final {};";'],
    ['raw string literal', 'const char *text = R"tag(struct Fake : Base {}; "quoted")tag";'],
    ['prefixed multiline raw string literal', 'const char *text = u8R"tag(\nstruct Fake final\n: Base {};\n)tag";'],
    ['character literal', "int marker = 'struct Fake : Base';"],
  ])('ignores inheritance inside a %s', (_label, maskedSource) => {
    // This checks heuristic masking, even for literal forms unavailable in C.
    expect(detectLanguage('record.h', maskedSource + '\nstruct Record { int value; };')).toBe('c');
  });

  it('still finds a real declaration after masked inheritance examples', () => {
    const source = '/* struct Fake : Missing {}; */\n' +
      'const char *text = R"tag(struct Other final {};)tag";\n' +
      'struct Actual : Base {};';
    expect(detectLanguage('record.h', source)).toBe('cpp');
  });

  it('does not promote an explicit .c source', () => {
    expect(detectLanguage('record.c', 'struct Derived : Base {};')).toBe('c');
  });
});

describe('struct inheritance header extraction', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['cpp']);
  });

  it('retains the receiver and its base when language comes from the header content', () => {
    const source = '#include "owners.h"\nstruct Receiver : Left {};\n';
    const language = detectLanguage('receiver.h', source);
    const result = extractFromSource('receiver.h', source, language);
    expect(language).toBe('cpp');
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Receiver', kind: 'struct', language: 'cpp' }),
    ]));
    expect(result.nodes.some(node => node.name === 'Left' && node.kind === 'function')).toBe(false);
    const receiver = result.nodes.find(node => node.name === 'Receiver')!;
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: receiver.id, referenceName: 'Left', referenceKind: 'extends' }),
    ]));
  });
});
