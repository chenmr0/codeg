import { cppIdentityTokens } from './c-cpp-macro-types';

interface ImportBinding { target: string; scope: string; branch: number[] }
// undefined means absent; null means lookup was bound but could not be proved.
type Lookup = string | null | undefined;
const qualify = (scope: string, name: string): string => scope ? `${scope}::${name}` : name;
const parentScope = (scope: string): string => scope.slice(0, Math.max(0, scope.lastIndexOf('::')));
const compatible = (binding: number[], branch: number[]): boolean =>
  binding.every((id, index) => index >= branch.length || branch[index] === id);
const certain = (binding: number[], branch: number[]): boolean =>
  binding.every((id, index) => branch[index] === id);

/** Scoped, source-order evidence for the declaration/direct-initializer
 * ambiguity. Unresolved or conflicting imports must not prove an enum value.
 * This intentionally does not attempt a full C++ type/name resolver.
 */
export class CppEnumEvidence {
  private types = new Set<string>();
  private namespaces = new Set<string>(['']);
  private values = new Map<string, number[][]>();
  private bindings = new Map<string, ImportBinding[]>();
  private directives = new Map<string, ImportBinding[]>();

  addSymbol(kind: string, name: string, branch: number[]): void {
    if (kind === 'enum_member') {
      const paths = this.values.get(name) ?? [];
      paths.push(branch);
      this.values.set(name, paths);
    } else if (['class', 'struct', 'enum', 'type_alias', 'namespace'].includes(kind)) {
      this.types.add(name);
      if (kind === 'namespace') {
        for (let at = name; at; at = parentScope(at)) {
          this.namespaces.add(at);
          this.types.add(at);
        }
      }
    }
  }

  addImport(kind: string, text: string, scope: string, branch: number[]): void {
    if (kind !== 'using_declaration' && kind !== 'namespace_alias_definition') return;
    const tokens = cppIdentityTokens(text);
    const add = (map: Map<string, ImportBinding[]>, key: string, target: string) => {
      // C++ imports bind at their declaration point. A later namespace with
      // the same spelling must not redirect an already established binding.
      const resolved = this.lookup(target, scope, branch, new Set());
      const entries = map.get(key) ?? [];
      entries.push({target: typeof resolved === 'string' ? `::${resolved}` : '', scope, branch});
      map.set(key, entries);
    };
    if (kind === 'namespace_alias_definition') {
      const equals = tokens.indexOf('=');
      if (equals === 2 && tokens[1]) add(this.bindings, qualify(scope, tokens[1]), tokens.slice(3).filter(t => t !== ';').join(''));
      return;
    }
    // A using-enum declaration imports enumerators, not the enum's type name.
    if (tokens[1] === 'enum') return;
    if (tokens[1] === 'namespace') {
      add(this.directives, scope, tokens.slice(2).filter(t => t !== ';').join(''));
      return;
    }
    // The bundled grammar represents C++17 comma lists as an ERROR nested in
    // a qualified_identifier. Split this bounded statement's tokens instead
    // of trusting that damaged tree's final name field.
    let part: string[] = [], depth = 0;
    for (const token of [...tokens.slice(1), ';']) {
      if ((token === ',' || token === ';') && depth === 0) {
        const name = part[part.length - 1];
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) {
          add(this.bindings, qualify(scope, name), part.filter(t => t !== 'typename').join(''));
        }
        part = [];
      } else {
        if (['<', '(', '['].includes(token)) depth++;
        if (['>', ')', ']'].includes(token)) depth--;
        part.push(token);
      }
    }
  }

  isValue(name: string, scope: string, branch: number[]): boolean {
    const resolved = this.lookup(name, scope, branch, new Set());
    return typeof resolved === 'string' && !this.types.has(resolved)
      && (this.values.get(resolved)?.some(path => certain(path, branch)) ?? false);
  }

  private combine(candidates: Lookup[]): Lookup {
    const found = candidates.filter(c => c !== undefined);
    if (!found.length) return undefined;
    return found.includes(null) || new Set(found).size !== 1 ? null : found[0];
  }

  private direct(name: string, scope: string, branch: number[], seen: Set<string>): Lookup {
    const full = qualify(scope, name);
    const imports = this.bindings.get(full)?.filter(b => compatible(b.branch, branch)) ?? [];
    if (imports.length) return this.combine(imports.map(b => certain(b.branch, branch)
      ? this.lookup(b.target, b.scope, branch, seen) ?? null : null));
    return this.types.has(full) || this.values.has(full) ? full : undefined;
  }

  private namespaceOf(scope: string): string {
    while (scope && !this.namespaces.has(scope)) scope = parentScope(scope);
    return scope;
  }

  private commonNamespace(left: string, right: string): string {
    while (left && right !== left && !right.startsWith(`${left}::`)) left = parentScope(left);
    return left;
  }

  private member(name: string, scope: string, branch: number[], seen: Set<string>): Lookup {
    const key = `member:${scope}:${name}`;
    if (seen.has(key) || seen.size > 32) return null;
    const next = new Set(seen).add(key);
    const direct = this.direct(name, scope, branch, next);
    if (direct !== undefined) return direct;
    return this.combine((this.directives.get(scope) ?? []).filter(b => compatible(b.branch, branch)
      && !next.has(`directive:${b.scope}:${b.target}`)).map(b => {
      const target = this.lookup(b.target, b.scope, branch, new Set(next).add(`directive:${b.scope}:${b.target}`));
      return typeof target === 'string' && certain(b.branch, branch)
        ? this.member(name, target, branch, next) : null;
    }));
  }

  private lookup(name: string, scope: string, branch: number[], seen: Set<string>): Lookup {
    if (!/^(?:::)?[A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)*$/.test(name)) return null;
    const key = `${scope}:${name}`;
    if (seen.has(key) || seen.size > 32) return null;
    const next = new Set(seen).add(key);
    const absolute = name.startsWith('::');
    const [head, ...tail] = name.replace(/^::/, '').split('::') as [string, ...string[]];
    let resolved: Lookup;
    if (absolute) resolved = this.member(head, '', branch, next);
    else {
      // A using-directive contributes at the nearest common namespace of its
      // declaration and target. It must not jump ahead of nearer direct names.
      const nominated = new Map<string, ImportBinding[]>();
      for (let visible = scope;; visible = parentScope(visible)) {
        for (const binding of this.directives.get(visible) ?? []) {
          if (!compatible(binding.branch, branch)) continue;
          const directiveKey = `directive:${binding.scope}:${binding.target}`;
          if (next.has(directiveKey)) continue;
          const target = this.lookup(binding.target, binding.scope, branch, new Set(next).add(directiveKey));
          const effective = typeof target === 'string'
            ? this.commonNamespace(this.namespaceOf(visible), target) : visible;
          const entries = nominated.get(effective) ?? [];
          entries.push({...binding, target: typeof target === 'string' ? `::${target}` : ''});
          nominated.set(effective, entries);
        }
        if (!visible) break;
      }
      for (let at = scope;; at = parentScope(at)) {
        const candidates: Lookup[] = [this.direct(head, at, branch, next)];
        for (const binding of nominated.get(at) ?? []) {
          candidates.push(binding.target && certain(binding.branch, branch)
            ? this.member(head, binding.target.slice(2), branch, next) : null);
        }
        resolved = this.combine(candidates);
        if (resolved !== undefined || !at) break;
      }
    }
    for (const component of tail) {
      if (typeof resolved !== 'string') return resolved;
      resolved = this.member(component, resolved, branch, next);
    }
    return resolved;
  }
}
