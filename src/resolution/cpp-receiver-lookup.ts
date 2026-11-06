import type { Node } from '../types';
import type { ResolutionContext, UnresolvedRef } from './types';
import { cppCallableOwnersMatch } from './cpp-signature';
import { cppCallableSignatureKey } from './cpp-call-admission';
import { cppNamespaceLookupAt, isCppFileDefinitelyVisible, cppSourceNamespaceName } from './cpp-binding-evidence';

type Site = Pick<UnresolvedRef, 'filePath' | 'line' | 'column' | 'language'>;
type NamespaceImport = { scope: string; target: string };
// undefined means no new nominal evidence; null means lookup is ambiguous or
// blocked. A proven lookup barrier must not fall back to the old short name.
type Lookup = { name: string; nodes: Node[] } | null | undefined;
type ScopeBinding = 'namespace' | 'type' | 'blocked' | 'absent';
interface Cache { owners: Map<string, string | null>; fields: Map<string, string | null | undefined>;
  scopes: Map<string, ScopeBinding>; contradictedNamespaces: Map<string, boolean> }
const caches = new WeakMap<ResolutionContext, Cache>();
const NAME = /^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/;

export function clearCppReceiverLookup(context: ResolutionContext): void { caches.delete(context); }

function cacheFor(context: ResolutionContext): Cache {
  let cache = caches.get(context);
  if (!cache) { cache = { owners: new Map(), fields: new Map(), scopes: new Map(), contradictedNamespaces: new Map() }; caches.set(context, cache); }
  return cache;
}

function retain<T>(entries: Map<string, T>, name: string, value: T): void {
  if (name.length > 2048 || typeof value === 'string' && value.length > 2048) return;
  if (entries.size >= 1024) entries.delete(entries.keys().next().value!);
  entries.set(name, value);
}

const parent = (name: string) => name.slice(0, Math.max(0, name.lastIndexOf('::')));
const qualify = (scope: string, name: string) => scope ? `${scope}::${name}` : name;
const cpp = (node: Node) => node.language === 'c' || node.language === 'cpp';

function levels(scope: string): string[] {
  const result = [scope];
  while (scope) { scope = parent(scope); result.push(scope); }
  return result;
}

function commonNamespace(left: string, right: string): string {
  const a = left.split('::').filter(Boolean), b = right.split('::').filter(Boolean);
  let count = 0;
  while (count < Math.min(a.length, b.length) && a[count] === b[count]) count++;
  return a.slice(0, count).join('::');
}

function scopeBinding(name: string, context: ResolutionContext, namespaceOnly = false): ScopeBinding {
  const entries = cacheFor(context).scopes, key = `${namespaceOnly ? 'namespace' : 'qualifier'}:${name}`;
  if (entries.has(key)) return entries.get(key)!;
  // namespace-name lookup only considers namespaces; before ::, lookup only
  // considers namespaces and types. Ordinary values cannot hide these names.
  const kinds = namespaceOnly ? ['namespace'] : ['namespace', 'class', 'struct', 'type_alias', 'enum'];
  const nodes = context.getNodesByQualifiedName(name).filter(n => cpp(n) && kinds.includes(n.kind));
  let result: ScopeBinding = 'absent';
  if (nodes.length) {
    result = nodes.every(n => n.kind === 'namespace') ? 'namespace'
      : nodes.every(n => ['class', 'struct'].includes(n.kind) && !n.typeParameters?.length) ? 'type' : 'blocked';
  }
  retain(entries, key, result);
  return result;
}

/** Namespace-scope using directives are resolved in their source order.
 * An unknown directive can introduce another candidate, so it blocks recovery.
 */
function lookupName(name: string, scope: string, imports: NamespaceImport[], exists: (name: string) => boolean,
  resolveAmbiguity?: (names: string[]) => string[]): string | null | undefined {
  if (name.length > 1024 || !NAME.test(name)) return null;
  if (name.startsWith('::')) return exists(name.slice(2)) ? name.slice(2) : undefined;
  for (const level of levels(scope)) {
    const direct = qualify(level, name);
    const matches = new Set(imports.filter(i => i.scope === level)
      .map(i => qualify(i.target, name)).filter(exists));
    if (exists(direct)) matches.add(direct);
    if (matches.size) {
      const candidates = matches.size > 1 && resolveAmbiguity ? resolveAmbiguity([...matches]) : [...matches];
      return candidates.length === 1 ? candidates[0]! : null;
    }
  }
  return undefined;
}

function namespaceNameContradicted(name: string, context: ResolutionContext): boolean {
  const cache = cacheFor(context).contradictedNamespaces;
  if (cache.has(name)) return cache.get(name)!;
  const nodes = context.getNodesByQualifiedName(name).filter(n => cpp(n) && n.kind === 'namespace');
  let contradicted = nodes.length > 0 && nodes.length <= 8;
  for (const node of nodes.slice(0, 8)) {
    const actual = cppSourceNamespaceName(node, context);
    if (actual === name || actual === null) { contradicted = false; break; }
  }
  retain(cache, name, contradicted);
  return contradicted;
}

/** Resolve the first qualifier once. Finding an inner namespace/type is a
 * lookup barrier even if it lacks the requested remaining member spelling.
 */
function qualifiedLookup(name: string, scope: string, imports: NamespaceImport[],
  context: ResolutionContext, namespaceOnly: boolean, finalExists: (name: string) => boolean): string | null | undefined {
  if (!NAME.test(name) || name.length > 1024) return null;
  if (name.startsWith('::')) return finalExists(name.slice(2)) ? name.slice(2) : undefined;
  const parts = name.split('::');
  if (parts.length === 1 && !namespaceOnly) return lookupName(name, scope, imports, finalExists);
  const first = lookupName(parts[0]!, scope, imports, qn => scopeBinding(qn, context, namespaceOnly) !== 'absent',
    names => names.filter(qn => scopeBinding(qn, context, namespaceOnly) !== 'namespace' || !namespaceNameContradicted(qn, context)));
  if (first === null || first === undefined) return first;
  const usable = (qn: string) => {
    const kind = scopeBinding(qn, context, namespaceOnly);
    return kind === 'namespace' || !namespaceOnly && kind === 'type';
  };
  if (!usable(first)) return null;
  let qualified = first;
  for (let i = 1; i < parts.length; i++) {
    qualified += '::' + parts[i]!;
    if (i + 1 < parts.length && !usable(qualified)) return null;
  }
  return finalExists(qualified) ? qualified : null;
}

function lookupType(name: string, site: Site, context: ResolutionContext, ownerScope?: string): Lookup {
  if (name.length > 1024 || !NAME.test(name)) return null;
  const last = name.replace(/^::/, '').split('::').at(-1)!;
  const candidates = context.getNodesByName(last).filter(n => cpp(n)
    && ['class', 'struct', 'type_alias'].includes(n.kind));
  const select = (found: string | null | undefined): Lookup => {
    if (found === null || found === undefined) return found;
    const nodes = candidates.filter(n => n.qualifiedName === found);
    if (nodes.some(n => n.kind === 'type_alias' || n.typeParameters?.length)) return null;
    return { name: found, nodes };
  };
  // An explicit global qualification bypasses local using directives, even
  // when one of those unrelated directives cannot be interpreted.
  if (name.startsWith('::')) return select(qualifiedLookup(name, '', [], context, false, qn => candidates.some(n => n.qualifiedName === qn)));
  if (!candidates.length) return undefined;
  const hints = cppNamespaceLookupAt(site, context);
  if (!hints || hints.uncertainUsing || !ownerScope && hints.active !== true) return null;
  const imports: NamespaceImport[] = [];
  for (const directive of hints.usings) {
    const target = qualifiedLookup(directive.target, directive.scope, imports, context, true,
      qn => scopeBinding(qn, context, true) === 'namespace');
    if (!target) return null;
    imports.push({ scope: commonNamespace(directive.scope, target), target });
  }
  const found = qualifiedLookup(name, ownerScope ?? hints.namespace, imports, context, false,
    qn => candidates.some(n => n.qualifiedName === qn));
  return select(found);
}

/** Recover only an owner selected by source lookup and a matching declaration.
 * Selecting a matching overload must never choose between ambiguous classes.
 */
export function cppRecoveredCallerOwner(caller: Node, context: ResolutionContext): string | null {
  if (caller.kind !== 'method' || !cpp(caller)) return null;
  const rawOwner = parent(caller.qualifiedName);
  if (!rawOwner) return null;
  const entries = cacheFor(context).owners;
  if (entries.has(caller.id)) return entries.get(caller.id)!;
  const site: Site = { filePath: caller.filePath, line: caller.startLine,
    column: caller.startColumn, language: 'cpp' };
  // The enclosing indexed class already identifies an inline method. Its
  // ownership is unaffected by unrelated namespace directives outside it.
  const enclosing = context.getNodesInFile(caller.filePath).some(n => cpp(n)
    && ['class', 'struct'].includes(n.kind) && n.qualifiedName === rawOwner
    && n.startLine <= caller.startLine && n.endLine >= caller.endLine);
  if (enclosing) { retain(entries, caller.id, rawOwner); return rawOwner; }
  const resolved = lookupType(rawOwner, site, context);
  let result: string | null = resolved === null ? '' : null;
  if (resolved?.name === rawOwner) result = rawOwner;
  else if (resolved && resolved.nodes.some(n => isCppFileDefinitelyVisible(n.filePath, site, context))) {
    const signature = cppCallableSignatureKey({ ...caller, qualifiedName: '<owner>' });
    const declaration = signature && context.getNodesByName(caller.name).some(n => cpp(n)
      && n.kind === 'method' && n.isDeclaration === true && parent(n.qualifiedName) === resolved.name
      && cppCallableOwnersMatch(caller, n)
      && cppCallableSignatureKey({ ...n, qualifiedName: '<owner>' }) === signature
      && isCppFileDefinitelyVisible(n.filePath, site, context)
      && (n.filePath !== caller.filePath || n.startLine <= caller.startLine));
    result = declaration ? resolved.name : '';
  }
  retain(entries, caller.id, result);
  return result;
}

/** Relative field types are looked up in the field's declaring class and its
 * enclosing namespaces, rather than in the out-of-line caller's file scope.
 */
export function cppFieldReceiverType(field: Node, type: string, context: ResolutionContext): string | null | undefined {
  const entries = cacheFor(context).fields, key = `${field.id}:${type}`;
  if (entries.has(key)) return entries.get(key)!;
  const owner = parent(field.qualifiedName);
  const site: Site = { filePath: field.filePath, line: field.startLine,
    column: field.startColumn, language: 'cpp' };
  const found = lookupType(type, site, context, owner);
  const result = found === null || found === undefined ? found : found.name;
  retain(entries, key, result);
  return result;
}
