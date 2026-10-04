import type { Node as SyntaxNode } from 'web-tree-sitter';
import { cppIdentityTokens, isCppIdentityIdentifier } from './c-cpp-macro-types';

export interface CppAliasType {
  kind: 'alias';
  node: SyntaxNode;
  type: SyntaxNode;
  declarator: SyntaxNode | null;
  qualifiers: SyntaxNode[];
}
type TypeBinding = CppAliasType | {kind: 'nominal' | 'namespace' | 'opaque'; node: SyntaxNode};
type Entry = {binding: TypeBinding; branch: number[]; visibleFrom: number};
const parentScope = (name: string) => name.slice(0, Math.max(0, name.lastIndexOf('::')));
const qualify = (scope: string, name: string) => scope ? `${scope}::${name}` : name;

function branchOf(node: SyntaxNode): number[] {
  const result: number[] = [];
  let alternative: number | undefined;
  for (let at = node.parent; at; at = at.parent) {
    if (['preproc_else', 'preproc_elif', 'preproc_elifdef'].includes(at.type)) alternative ??= at.id;
    else if (['preproc_if', 'preproc_ifdef', 'preproc_ifndef'].includes(at.type)) {
      result.push(alternative ?? at.id);
      alternative = undefined;
    }
  }
  return result.reverse();
}

/** Local, declaration-point type evidence for macro identity. Owned by one
 * extractor and released before its tree is deleted; no source/AST global
 * cache. Dependent declarations, unknown imports and conditional ambiguity
 * deliberately keep their spelling rather than invent type equivalence.
 */
export class CppTypeBindings {
  private entries = new Map<string, Entry[]>();
  private scopes = new Map<number, string>();
  private opaqueScopes = new Set<number>();
  private directives = new Map<string, SyntaxNode[]>();
  private imports: SyntaxNode[] = [];
  private accessRows = new Map<number, Array<{startRow:number; endRow:number}>>();

  constructor(root: SyntaxNode) { this.scan(root, '', false); }

  accessSections(body: SyntaxNode): Array<{startRow:number; endRow:number}> {
    let rows = this.accessRows.get(body.id);
    if (!rows) {
      rows = body.namedChildren.filter(n => n.type === 'access_specifier')
        .map(n => ({startRow:n.startPosition.row, endRow:n.endPosition.row}));
      this.accessRows.set(body.id, rows);
    }
    return rows;
  }

  /** Declarations needed by a sparse macro replay, including alias targets
   * and lookup barriers. Callers retain their enclosing scope/branch shells
   * and release these nodes with the primary tree before reparsing.
   */
  contextNodes(names: Set<string>): SyntaxNode[] {
    const byLeaf = new Map<string, Entry[]>();
    for (const [name, entries] of this.entries) {
      const key = name.includes('::') ? name.slice(name.lastIndexOf('::') + 2) : name;
      byLeaf.set(key, [...(byLeaf.get(key) ?? []), ...entries]);
    }
    const result = new Map(this.imports.map(n => [n.id, n]));
    for (const name of names) {
      for (const {binding} of byLeaf.get(name) ?? []) {
        const node = binding.node.parent?.type === 'alias_declaration' ? binding.node.parent : binding.node;
        if (result.has(node.id)) continue;
        result.set(node.id, node);
        if (binding.kind === 'alias') for (const token of cppIdentityTokens(binding.node.text)) {
          if (isCppIdentityIdentifier(token)) names.add(token);
        }
      }
    }
    return [...result.values()];
  }

  resolve(node: SyntaxNode, spelling: string): CppAliasType | {kind:'nominal'; name:string} | null {
    const parts = cppIdentityTokens(spelling);
    const absolute = parts[0] === '::';
    if (absolute) parts.shift();
    if (!parts.length || !parts.every((p, i) => i % 2 ? p === '::' : isCppIdentityIdentifier(p))) return null;
    if (parts.length % 2 === 0) return null;
    const names = parts.filter((_, i) => i % 2 === 0);
    let scope = '';
    const qualifiedOwners: SyntaxNode[] = [];
    for (let at: SyntaxNode | null = node; at; at = at.parent) {
      if (at.type === 'compound_statement' || this.opaqueScopes.has(at.id)) return null;
      // The parameters and trailing return of C::method are looked up in C,
      // while its leading return type is still in the enclosing scope.
      if (at.type === 'function_declarator') {
        let name = at.childForFieldName('declarator');
        while (name && name.type !== 'qualified_identifier' && name.type.includes('declarator')) {
          name = name.childForFieldName('declarator');
        }
        const owner = name?.type === 'qualified_identifier' ? name.childForFieldName('scope') : null;
        if (owner) qualifiedOwners.unshift(owner);
      }
      if (this.scopes.has(at.id)) { scope = this.scopes.get(at.id)!; break; }
    }
    const branch = branchOf(node);
    const atScope = (where: string, name: string): Entry | null | undefined => {
      const candidates = (this.entries.get(qualify(where, name)) ?? []).filter(e => e.visibleFrom <= node.startIndex
        && e.branch.every((id, i) => i >= branch.length || branch[i] === id));
      // An unresolved using-directive can introduce a nearer same-named type.
      // We only canonicalize when local declaration evidence is unambiguous.
      if ((this.directives.get(where) ?? []).some(n => n.startIndex < node.startIndex)) return null;
      if (!candidates.length) return undefined;
      if (candidates.some(e => !e.branch.every((id, i) => branch[i] === id))) return null;
      return candidates[candidates.length - 1];
    };
    const find = (components: string[], from: string, global: boolean): {entry: Entry; full: string} | null => {
      let entry: Entry | null | undefined;
      let full = '';
      for (let at = global ? '' : from;; at = parentScope(at)) {
        entry = atScope(at, components[0]!);
        if (entry !== undefined) { full = qualify(at, components[0]!); break; }
        if (global || !at) return null;
      }
      for (const name of components.slice(1)) {
        if (!entry || !['namespace', 'nominal'].includes(entry.binding.kind)) return null;
        entry = atScope(full, name);
        full = qualify(full, name);
      }
      return entry ? {entry, full} : null;
    };
    for (const owner of qualifiedOwners) {
      const spelling = cppIdentityTokens(owner.text).join('').replace(/::$/, '');
      const components = spelling.replace(/^::/, '').split('::');
      if (!components.every(isCppIdentityIdentifier)) return null;
      const found = find(components, scope, spelling.startsWith('::'));
      if (!found || !['namespace', 'nominal'].includes(found.entry.binding.kind)) return null;
      scope = found.full;
    }
    const {entry, full} = find(names, scope, absolute) ?? {};
    if (entry?.binding.kind === 'alias') return entry.binding;
    return entry?.binding.kind === 'nominal' ? {kind:'nominal', name:`::${full}`} : null;
  }

  private add(scope: string, name: string, binding: TypeBinding, visibleFrom = binding.node.startIndex): void {
    const full = qualify(scope, name);
    const entries = this.entries.get(full) ?? [];
    entries.push({binding, branch:branchOf(binding.node), visibleFrom});
    this.entries.set(full, entries);
  }

  private addLookupBarrier(scope: string, node: SyntaxNode): void {
    const entries = this.directives.get(scope) ?? [];
    entries.push(node);
    this.directives.set(scope, entries);
    this.imports.push(node);
  }

  private scan(node: SyntaxNode, scope: string, dependent: boolean): void {
    if (['compound_statement', 'parameter_list', 'template_argument_list', 'preproc_def', 'preproc_function_def'].includes(node.type)) return;
    dependent ||= node.type === 'template_declaration';
    if (node.type === 'namespace_definition') {
      const name = node.childForFieldName('name');
      const parts = name && cppIdentityTokens(name.text).filter(t => t !== '::');
      if (!parts?.length || !parts.every(isCppIdentityIdentifier)) {
        // Anonymous namespaces and unsupported namespace syntax can inject
        // nearer names. Neither their members nor their enclosing scope may
        // fall back to an unrelated outer alias as proof of equivalence.
        this.opaqueScopes.add(node.id);
        this.addLookupBarrier(scope, node);
        return;
      }
      if (node.children.some(n => n.type === 'inline')) this.addLookupBarrier(scope, node);
      for (const part of parts) {
        this.add(scope, part, {kind:'namespace',node});
        scope = qualify(scope, part);
      }
      this.scopes.set(node.id, scope);
    } else if (['class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(node.type)) {
      const name = node.childForFieldName('name');
      if (!name || !isCppIdentityIdentifier(name.text)) { this.opaqueScopes.add(node.id); return; }
      this.add(scope, name.text, {kind:node.parent?.type === 'template_declaration' ? 'opaque' : 'nominal',node}, name.endIndex);
      scope = qualify(scope, name.text);
      this.scopes.set(node.id, scope);
      if (node.namedChildren.some(n => n.type === 'base_class_clause')) this.addLookupBarrier(scope, node);
    } else if (node.type === 'alias_declaration') {
      const name = node.childForFieldName('name'), descriptor = node.childForFieldName('type');
      const type = descriptor?.childForFieldName('type');
      if (name && descriptor && type) this.add(scope, name.text, dependent || node.hasError ? {kind:'opaque',node}
        : {kind:'alias',node:descriptor,type,declarator:descriptor.childForFieldName('declarator'),
          qualifiers:descriptor.namedChildren.filter(n => n.type === 'type_qualifier')}, name.endIndex);
    } else if (node.type === 'type_definition') {
      const type = node.childForFieldName('type');
      for (const declarator of node.childrenForFieldName('declarator')) {
        let name: SyntaxNode | null = declarator;
        while (name && !['identifier', 'type_identifier'].includes(name.type)) {
          name = name.childForFieldName('declarator') ?? name.namedChildren.find(n => n.type.includes('declarator')) ?? null;
        }
        if (name && type) this.add(scope, name.text, dependent || node.hasError ? {kind:'opaque',node}
          : {kind:'alias',node,type,declarator,qualifiers:node.namedChildren.filter(n => n.type === 'type_qualifier')}, name.endIndex);
      }
    } else if (node.type === 'namespace_alias_definition' || node.type === 'using_declaration') {
      this.imports.push(node);
      const parts = cppIdentityTokens(node.text);
      if (parts[1] === 'namespace' || parts[1] === 'enum') {
        const imports = this.directives.get(scope) ?? []; imports.push(node); this.directives.set(scope, imports);
      } else if (node.type === 'namespace_alias_definition') {
        if (parts[1]) this.add(scope, parts[1], {kind:'opaque',node});
      } else {
        // Every imported leaf is a barrier to outer type lookup, even when
        // the grammar cannot represent a C++17 comma-list without ERROR.
        for (let i = 1; i < parts.length; i++) if (parts[i] === ',' || parts[i] === ';') {
          const name = parts[i - 1];
          if (name && isCppIdentityIdentifier(name)) this.add(scope, name, {kind:'opaque',node});
        }
      }
    }
    const children = node.namedChildren;
    if (['declaration_list', 'field_declaration_list'].includes(node.type)) {
      this.accessRows.set(node.id, children.filter(n => n.type === 'access_specifier')
        .map(n => ({startRow:n.startPosition.row, endRow:n.endPosition.row})));
    }
    for (const child of children) this.scan(child, scope, dependent);
  }
}
