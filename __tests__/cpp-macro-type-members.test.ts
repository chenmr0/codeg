import { beforeAll, describe, expect, it } from 'vitest';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { scanMacroContribution } from '../src/extraction/macro-scan';
import { selectUnambiguousCppMacroDefinitions } from '../src/extraction/declaration-macros';

beforeAll(() => loadGrammarsForLanguages(['c', 'cpp']));

function extract(source: string, project = '') {
  const context = scanMacroContribution(project + '\n' + source);
  const result = extractFromSource('members.hpp', source, 'cpp', undefined,
    new Set(context.names), new Set(context.bodyless), selectUnambiguousCppMacroDefinitions(context.definitions));
  expect(result.errors).toEqual([]);
  const ids = new Set(result.nodes.map(n => n.id));
  expect(ids.size).toBe(result.nodes.length);
  for (const edge of result.edges) {
    expect(ids.has(edge.source)).toBe(true);
    expect(ids.has(edge.target)).toBe(true);
  }
  return result;
}

describe('source members of macro-generated types', () => {
  it.each(['class', 'struct', 'union'])('recovers members after a %s header macro with exact source coordinates', kind => {
    const source = `#define TYPE(name) ${kind} name
namespace example {
TYPE(Owner)
{
public:
    int value;
    int *pointer;
    void namespace_push();
    void run() { int local_only = 1; }
};
}`;
    const result = extract(source);
    const owner = result.nodes.find(n => n.qualifiedName === 'example::Owner')!;
    for (const name of ['value', 'pointer', 'namespace_push', 'run']) {
      const member = result.nodes.find(n => n.qualifiedName === `example::Owner::${name}`)!;
      expect(member).toBeDefined();
      expect(result.edges).toContainEqual(expect.objectContaining({source: owner.id, target: member.id, kind: 'contains'}));
    }
    expect(result.nodes.find(n => n.name === 'value')).toMatchObject({kind:'field', startLine:6, startColumn:8, endColumn:13});
    expect(result.nodes.some(n => n.name === 'local_only')).toBe(false);
  });

  it('expands constructors and method headers but never their local declarations', () => {
    const result = extract(`#define NAME(n) generated_##n
#define TYPE(n) class NAME(n) : public Base
#define CTOR(n) public: NAME(n)() : Base()
#define METHOD(n) void n()
struct Base {};
TYPE(Owner)
{
  CTOR(Owner), value(0) { int constructor_local; }
  METHOD(run) { int method_local; }
private:
  int value;
  static constexpr int limit = 4;
  struct Inner { int nested; };
};`);
    for (const name of ['value', 'limit']) expect(result.nodes).toContainEqual(expect.objectContaining({kind:'field', qualifiedName:`generated_Owner::${name}`}));
    expect(result.nodes).toContainEqual(expect.objectContaining({kind:'field', qualifiedName:'generated_Owner::Inner::nested'}));
    expect(result.nodes).toContainEqual(expect.objectContaining({kind:'method', qualifiedName:'generated_Owner::run'}));
    expect(result.nodes.filter(n => n.name === 'value')).toHaveLength(1);
    expect(result.nodes.some(n => n.name === 'constructor_local' || n.name === 'method_local')).toBe(false);
  });

  it('recovers source class names and constructors supplied by identifier-only macros', () => {
    const result = extract(`#define NAME(n) generated_##n
struct generated_Base {};
class NAME(Derived) : public NAME(Base)
{
public:
  NAME(Derived)() : NAME(Base)(), value(0) { int local_only; }
private:
  int value;
};`);
    expect(result.nodes).toContainEqual(expect.objectContaining({kind:'field', qualifiedName:'generated_Derived::value'}));
    expect(result.nodes).toContainEqual(expect.objectContaining({kind:'method', qualifiedName:'generated_Derived::generated_Derived'}));
    expect(result.nodes.some(n => n.name === 'local_only')).toBe(false);
  });

  it('does not substitute unrelated object macros into healthy source types or fields', () => {
    const result = extract(`#define TYPE(n) struct n
struct Source { int first; };
TYPE(Owner)
{
  int value;
};`, '#define Source Other\n#define value stolen\n');
    expect(result.nodes).toContainEqual(expect.objectContaining({kind:'struct',name:'Source'}));
    expect(result.nodes).toContainEqual(expect.objectContaining({kind:'field',qualifiedName:'Owner::value'}));
    expect(result.nodes.some(n => n.name === 'Other' || n.name === 'stolen')).toBe(false);
  });

  it('keeps unresolved macro-shaped function bodies and lambdas out of member recovery', () => {
    const result = extract(`#define FUNCTION(n) void n()
#define DECL(n) int n;
FUNCTION(run)
{
  int local_only;
  DECL(macro_local)
  auto callback = [] { int lambda_local; };
}
int after;`);
    for (const name of ['local_only','macro_local','lambda_local']) expect(result.nodes.some(n => n.name === name)).toBe(false);
    expect(result.nodes).toContainEqual(expect.objectContaining({kind:'variable',name:'after'}));
  });

  it.each(['\n', '\r\n'])('keeps branches and nested member ownership (%j)', newline => {
    const result = extract(`#define TYPE(n) struct n
TYPE(Owner)
{
#if FEATURE
  int enabled;
#else
  int disabled;
#endif
  struct Inner { int nested; void run() { int hidden; } };
};`.replace(/\n/g, newline));
    for (const name of ['enabled','disabled']) expect(result.nodes).toContainEqual(expect.objectContaining({kind:'field',qualifiedName:`Owner::${name}`}));
    const nested = result.nodes.find(n => n.qualifiedName === 'Owner::Inner::nested')!;
    const inner = result.nodes.find(n => n.qualifiedName === 'Owner::Inner')!;
    const owner = result.nodes.find(n => n.qualifiedName === 'Owner')!;
    expect(result.edges.filter(e => e.kind === 'contains' && e.target === inner.id))
      .toEqual([expect.objectContaining({source:owner.id,target:inner.id})]);
    expect(result.edges).toContainEqual(expect.objectContaining({source:inner.id,target:nested.id,kind:'contains'}));
    expect(result.nodes.some(n => n.name === 'hidden')).toBe(false);
  });

  it('keeps namespace-prefixed member names without treating namespace text as a callable', () => {
    const result = extract(`namespace real {
class Parser { public: void namespace_push(); void namespace_pop(); const char *namespace_prefix() const; };
}`);
    for (const name of ['namespace_push','namespace_pop','namespace_prefix']) expect(result.nodes).toContainEqual(expect.objectContaining({kind:'method',qualifiedName:`real::Parser::${name}`}));
    expect(result.nodes.some(n => n.kind === 'method' && /\s/.test(n.name))).toBe(false);
  });
});
