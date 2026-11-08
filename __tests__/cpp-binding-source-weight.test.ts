import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

interface Snapshot {
  text: string; starts: readonly number[];
  includes: readonly { readonly name?: string }[];
  scopes: readonly { readonly scope: { readonly namespace: string } }[];
}
interface Cache<T> { has(key: string): boolean; get(key: string): T | undefined; set(key: string, value: T): void }

// Exercise the actual private implementation without exporting test-only product
// APIs, importing stale dist, or changing global module loaders. These definitions
// have no runtime dependencies on the rest of the binding parser.
function implementation() {
  const source = readFileSync(new URL('../src/resolution/cpp-binding-evidence.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('binding.ts', source, ts.ScriptTarget.Latest, true);
  const wanted = new Set(['EvidenceCache', 'sourceWeights', 'sourceWeight']);
  const definitions = ast.statements.filter(node => {
    if ((ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name) return wanted.has(node.name.text);
    return ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => wanted.has(decl.name.getText(ast)));
  });
  expect(definitions).toHaveLength(3);
  const body = definitions.map(node => node.getText(ast)).join('\n')
    + '\nexports.EvidenceCache = EvidenceCache; exports.sourceWeight = sourceWeight;';
  const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function('exports', compiled)(exports);
  return exports as unknown as {
    sourceWeight(source: Snapshot | null): number;
    EvidenceCache: new<T>(entries: number, bytes: number, weight: (value: T) => number) => Cache<T>;
  };
}

function originalWeight(source: Snapshot | null): number {
  return source ? 128 + source.text.length * 4 + source.starts.length * 24
    + source.includes.reduce((bytes, include) => bytes + 96 + (include.name?.length ?? 0) * 2, 0)
    + source.scopes.reduce((bytes, point) => bytes + 160 + point.scope.namespace.length * 2, 0) : 8;
}
function snapshot(namespace = 'alpha', text = 'namespace alpha {}') {
  const visits = { includes: 0, scopes: 0 };
  const source: Snapshot = Object.freeze({ text, starts: Object.freeze([0, 12]),
    includes: Object.freeze([Object.freeze({ get name() { visits.includes++; return 'types.h'; } })]),
    scopes: Object.freeze([Object.freeze({ scope: Object.freeze({ get namespace() { visits.scopes++; return namespace; } }) })]),
  });
  return { source, visits };
}

describe('C++ immutable source weight reuse', () => {
  it('preserves the formula and visits source evidence once per snapshot', () => {
    const { sourceWeight } = implementation(), { source, visits } = snapshot();
    const expected = originalWeight(source);
    visits.includes = 0; visits.scopes = 0;
    for (let i = 0; i < 100; i++) expect(sourceWeight(source)).toBe(expected);
    expect(visits).toEqual({ includes: 1, scopes: 1 });
    expect(sourceWeight(null)).toBe(8);
  });

  it('does not reuse weights across reparsed or changed source objects', () => {
    const { sourceWeight } = implementation();
    const first = snapshot('a'), reparsed = snapshot('a'), changed = snapshot('longer_namespace', 'different text');
    expect(sourceWeight(first.source)).toBe(originalWeight(first.source));
    expect(sourceWeight(reparsed.source)).toBe(originalWeight(reparsed.source));
    expect(sourceWeight(changed.source)).toBe(originalWeight(changed.source));
    expect(sourceWeight(changed.source)).not.toBe(sourceWeight(first.source));
    // One computation plus one independent oracle traversal for each identity.
    for (const item of [first, reparsed, changed]) expect(item.visits).toEqual({ includes: 2, scopes: 2 });
  });

  it('retains full per-declaration charging, LRU eviction, replacement, and oversize rejection', () => {
    const { sourceWeight, EvidenceCache } = implementation();
    const { source } = snapshot();
    const amount = 128 + originalWeight(source) + 4;
    // Exactly two one-character keys fit; source sharing must not discount either.
    const budget = 2 * (98 + amount);
    type Value = { source: Snapshot; prefix: string; text: string };
    const weight = (value: Value, measure: typeof sourceWeight) => 128 + measure(value.source) + (value.prefix.length + value.text.length) * 2;
    const cached = new EvidenceCache<Value>(512, budget, value => weight(value, sourceWeight));
    const oracle = new EvidenceCache<Value>(512, budget, value => weight(value, originalWeight));
    const normal = { source, prefix: 'p', text: 't' };
    const large = { source: snapshot('large', 'x'.repeat(budget)).source, prefix: '', text: '' };
    const compare = () => { for (const key of ['a', 'b', 'c', 'z']) expect(cached.has(key)).toBe(oracle.has(key)); };
    const put = (key: string, value: Value) => { cached.set(key, value); oracle.set(key, value); compare(); };
    put('a', normal); put('b', normal);
    expect(cached.get('a')).toBe(oracle.get('a')); // Promote a; b is next out.
    put('c', normal); expect(cached.has('b')).toBe(false); expect(cached.has('a')).toBe(true);
    put('z', large); expect(cached.has('z')).toBe(false); expect(cached.has('a')).toBe(true);
    put('a', normal); // Replacement must still pay full weight.
    put('a', large); expect(cached.has('a')).toBe(false); // Preserve existing remove-before-reject behavior.
    put('b', normal); put('z', normal); expect(cached.has('c')).toBe(false);
  });

  it('also reuses the weight when every attempted cache insertion is oversized', () => {
    const { sourceWeight, EvidenceCache } = implementation(), { source, visits } = snapshot();
    const cache = new EvidenceCache<Snapshot>(2, 16, sourceWeight);
    for (let i = 0; i < 50; i++) { cache.set('snapshot', source); expect(cache.has('snapshot')).toBe(false); }
    expect(visits).toEqual({ includes: 1, scopes: 1 });
  });
});
