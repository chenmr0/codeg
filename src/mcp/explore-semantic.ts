import type CodeGraph from '../index';
import type { Node } from '../types';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { CCppSourceScope } from '../extraction/c-cpp-source-scope';
import { maskCStyleCommentsAndLiterals } from '../extraction/grammars';
import { cppCallableParametersMatch, cppParameterKey } from '../resolution/cpp-signature';
import { validatePathWithinRoot } from '../utils';

export const EXPLORE_TYPES = new Set(['class', 'struct', 'interface', 'trait', 'protocol', 'enum']);
export const EXPLORE_CALLABLES = new Set(['method', 'function', 'component', 'constructor']);

/** Per-query, read-only semantic view. IDs and original declaration rows stay intact. */
export class ExploreSemanticView {
  private names = new Map<string, Node[]>();
  private files = new Map<string, Node[]>();
  private sources = new Map<string, { text: string; masked: string; offsets: number[]; scope: CCppSourceScope } | null>();
  private normalized = new Map<string, Node>();
  private canonical = new Map<string, Node>();
  private owners = new Map<string, string | undefined>();
  private aliases = new Map<string, Set<string>>();
  constructor(private cg: CodeGraph) {}

  byName(name: string): Node[] {
    if (!this.names.has(name)) this.names.set(name, this.cg.getNodesByName(name));
    return this.names.get(name)!;
  }
  inFile(file: string): Node[] {
    if (!this.files.has(file)) this.files.set(file, this.cg.getNodesInFile(file));
    return this.files.get(file)!;
  }
  private source(file: string) {
    if (!this.sources.has(file)) {
      const abs = validatePathWithinRoot(this.cg.getProjectRoot(), file);
      try {
        if (!abs) throw new Error('outside project');
        const text = readFileSync(abs, 'utf8');
        const tracked = this.cg.getFile(file);
        if (tracked && createHash('sha256').update(text).digest('hex') !== tracked.contentHash) {
          throw new Error('source changed since indexing');
        }
        const offsets = [0];
        for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1);
        this.sources.set(file, { text, masked: maskCStyleCommentsAndLiterals(text), offsets, scope: new CCppSourceScope(text) });
      } catch { this.sources.set(file, null); }
    }
    return this.sources.get(file);
  }
  private enclosingType(n: Node): Node | undefined {
    return this.inFile(n.filePath).filter(t => t.id !== n.id && EXPLORE_TYPES.has(t.kind)
      && !t.isDeclaration && t.startLine <= n.startLine && t.endLine >= n.endLine
      && (t.startLine < n.startLine || t.endLine > n.endLine || t.startColumn < n.startColumn))
      .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  }
  private typeName(n: Node): string {
    const source = this.source(n.filePath);
    if (!source) return n.qualifiedName;
    const lineOffset = source.offsets[n.startLine - 1];
    if (lineOffset === undefined) return n.qualifiedName;
    const offset = lineOffset + n.startColumn;
    const parent = this.enclosingType(n);
    return [parent ? this.typeName(parent) : source.scope.namespaceAt(offset), n.name].filter(Boolean).join('::');
  }
  owner(n: Node): string | undefined {
    if (this.owners.has(n.id)) return this.owners.get(n.id);
    // Cache the unresolved state before recursing through type identities.
    this.owners.set(n.id, undefined);
    const parent = this.enclosingType(n);
    if (parent) {
      const owner = this.typeName(parent); this.owners.set(n.id, owner); return owner;
    }
    const source = this.source(n.filePath);
    if (!source) return undefined;
    const lineOffset = source.offsets[n.startLine - 1];
    if (lineOffset === undefined) return undefined;
    const offset = lineOffset + n.startColumn;
    const head = source.masked.slice(offset, source.offsets[Math.min(n.endLine, n.startLine + 16)] ?? source.masked.length);
    const escaped = n.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const spelling = new RegExp('([A-Za-z_]\\w*(?:::[A-Za-z_]\\w*)*)::' + escaped + '\\s*\\(').exec(head)?.[1];
    if (!spelling) return undefined;
    const ns = source.scope.namespaceAt(offset);
    const types = this.byName(spelling.split('::').at(-1)!).filter(t => EXPLORE_TYPES.has(t.kind) && !t.isDeclaration)
      .map(t => this.typeName(t));
    // Lexical declarations hide namespace imports. Walk outward before considering using-directives.
    const namespaces = ns.split('::').filter(Boolean);
    for (let count = namespaces.length; count >= 0; count--) {
      const local = [...namespaces.slice(0, count), spelling].join('::');
      if (types.includes(local)) { this.owners.set(n.id, local); return local; }
    }
    const possible = new Set<string>();
    // Only source-written, preceding namespace directives visible at this scope.
    // Block-local directives do not establish ownership of an out-of-line method.
    const prefix = source.masked.slice(0, offset);
    for (const m of prefix.matchAll(/\busing\s+namespace\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*;/g)) {
      const at = m.index!; const usingScope = source.scope.namespaceAt(at);
      if (source.scope.isExecutable(at) || (usingScope && ns !== usingScope && !ns.startsWith(usingScope + '::'))) continue;
      possible.add(m[1] + '::' + spelling);
      if (usingScope) possible.add(usingScope + '::' + m[1] + '::' + spelling);
    }
    const matches = new Set(types.filter(q => possible.has(q)));
    const owner = matches.size === 1 ? [...matches][0] : undefined;
    this.owners.set(n.id, owner); return owner;
  }
  normalize(n: Node): Node {
    if (this.normalized.has(n.id)) return this.normalized.get(n.id)!;
    let result = n;
    if (n.language === 'cpp' || n.language === 'c') {
      if (EXPLORE_TYPES.has(n.kind)) result = { ...n, qualifiedName: this.typeName(n) };
      else if (EXPLORE_CALLABLES.has(n.kind)) {
        const owner = this.owner(n);
        if (owner) result = { ...n, qualifiedName: owner + '::' + n.name };
        // Stored display signatures may be shortened. Never compare a truncated
        // parameter list: recover its balanced declarator from unchanged source.
        if (cppParameterKey(result) === null) {
          const source = this.source(n.filePath);
          const offset = source?.offsets[n.startLine - 1];
          if (source && offset !== undefined) {
            const head = source.masked.slice(offset + n.startColumn,
              source.offsets[Math.min(n.endLine, n.startLine + 32)] ?? source.masked.length);
            const escaped = n.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const match = new RegExp(escaped + '\\s*\\(').exec(head);
            if (match) {
              const open = head.indexOf('(', match.index + n.name.length);
              let depth = 0;
              for (let i = open; i < head.length; i++) {
                if (head[i] === '(') depth++;
                else if (head[i] === ')' && --depth === 0) {
                  const suffix = head.slice(i + 1).split(/[;{]/, 1)[0]!;
                  result = { ...result, signature: head.slice(0, i + 1) + suffix };
                  break;
                }
              }
            }
          }
        }
      }
    }
    this.normalized.set(n.id, result); return result;
  }
  resolve(n: Node): Node {
    if (this.canonical.has(n.id)) return this.canonical.get(n.id)!;
    const normalized = this.normalize(n);
    this.canonical.set(n.id, normalized);
    if (!n.isDeclaration || (n.language !== 'cpp' && n.language !== 'c')) return normalized;
    let candidates: Node[] = [];
    if (EXPLORE_TYPES.has(n.kind)) {
      candidates = this.byName(n.name).filter(d => d.kind === n.kind && !d.isDeclaration
        && this.normalize(d).qualifiedName === normalized.qualifiedName);
    } else if (EXPLORE_CALLABLES.has(n.kind)) {
      const owner = this.owner(n);
      const qualifiers = (v: Node) => ((v.signature ?? '').slice((v.signature ?? '').lastIndexOf(')') + 1)
        .match(/\bconst\b|\bvolatile\b|&&?/g) ?? []).join(' ');
      candidates = this.byName(n.name).filter(d => !d.isDeclaration && EXPLORE_CALLABLES.has(d.kind)
        // Cheap tail check before loading source for common names like init/run.
        && (owner ? d.qualifiedName.split('::').slice(-2, -1)[0] === owner.split('::').at(-1)
          : d.qualifiedName === n.qualifiedName)
        && d.language === n.language && cppCallableParametersMatch(normalized, this.normalize(d)) === true
        && qualifiers(normalized) === qualifiers(this.normalize(d))
        && (owner ? this.owner(d) === owner : d.kind === 'function' && d.qualifiedName === n.qualifiedName));
      // An unqualified definition shared by two namespaces is not safe to merge.
      if (owner) candidates = candidates.filter(d => this.owner(d) !== undefined);
    }
    if (candidates.length === 1) {
      const definition = this.normalize(candidates[0]!);
      this.canonical.set(n.id, definition);
      const aliases = this.aliases.get(definition.id) ?? new Set<string>();
      aliases.add(n.id); this.aliases.set(definition.id, aliases);
    }
    return this.canonical.get(n.id)!;
  }
  endpoints(n: Node): string[] { return [n.id, ...this.aliases.get(n.id) ?? []]; }
  ownerType(n: Node): Node | undefined {
    if (n.language !== 'cpp' && n.language !== 'c') return undefined;
    const owner = this.owner(n);
    if (!owner) return undefined;
    const matches = this.byName(owner.split('::').at(-1)!).filter(t => EXPLORE_TYPES.has(t.kind)
      && !t.isDeclaration && this.normalize(t).qualifiedName === owner);
    return matches.length === 1 ? this.normalize(matches[0]!) : undefined;
  }
  members(type: Node): Node[] {
    const ids = new Map<string, Node>();
    for (const n of this.inFile(type.filePath)) {
      if (n.id === type.id || !EXPLORE_CALLABLES.has(n.kind)) continue;
      if (this.enclosingType(n)?.id !== type.id) continue;
      const member = this.resolve(n); ids.set(member.id, member);
    }
    return [...ids.values()];
  }
  /** Resolve literal source evidence to the tightest indexed callable body. */
  enclosingBody(file: string, line: number): Node | undefined {
    if (!this.source(file)) return undefined;
    return this.inFile(file).filter(n => EXPLORE_CALLABLES.has(n.kind) && !n.isDeclaration
      && n.startLine <= line && n.endLine >= line)
      .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))
      .map(n => this.resolve(n))[0];
  }
}
