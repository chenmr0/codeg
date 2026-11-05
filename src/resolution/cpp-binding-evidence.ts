import * as path from 'node:path';
import type { Node } from '../types';
import { maskCStyleCommentsAndLiterals } from '../extraction/grammars';
import { cppParameterKey } from './cpp-signature';
import type { ResolutionContext, UnresolvedRef } from './types';

/** Unknown is deliberately distinct from both a positive witness and a veto. */
type Evidence = 'allowed' | 'forbidden' | 'unknown';
type StorageLinkage = 'internal' | 'external' | 'unknown';
type Condition = boolean | null;
type Dialect = 'c' | 'cpp';
interface Include { line: number; name?: string; quoted: boolean; active: Condition }
interface Scope { namespace: string; anonymous: boolean; ordinary: boolean; linkage: Dialect | null }
interface ScopePoint { offset: number; scope: Scope }
interface Source {
  text: string; code: string; starts: number[]; active: Condition[];
  includes: Include[]; scopes: ScopePoint[];
}
interface Reachable { definite: Set<string>; possible: Set<string>; open: boolean }
interface IncludeChoices { files: string[]; complete: boolean }
interface Declaration {
  source: Source; offset: number; prefix: string; text: string; scope: Scope;
  active: Condition; linkage: Dialect | null;
}
interface Cache {
  text: EvidenceCache<string | null>; sources: EvidenceCache<Source | null>;
  declarations: EvidenceCache<Declaration | null>; reach: EvidenceCache<Reachable>;
  includeChoices: EvidenceCache<IncludeChoices>;
}
const caches = new WeakMap<ResolutionContext, Cache>();
const MAX_SOURCE_LENGTH = 4 * 1024 * 1024;
const MAX_INCLUDE_FILES = 256;

/** Independent retention budgets; eviction only repeats a pure computation.
 * Charge UTF-16 strings and container overhead conservatively, including source
 * strings retained by declaration slices. These are not exact V8 heap sizes.
 */
class EvidenceCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  constructor(private readonly maxEntries: number, private readonly maxBytes: number,
    private readonly weight: (value: T) => number) {}
  has(key: string): boolean { return this.entries.has(key); }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T): void {
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    const bytes = 96 + key.length * 2 + this.weight(value);
    if (bytes > this.maxBytes) return;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.bytes -= this.entries.get(oldest.value)!.bytes;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
  }
}

function sourceWeight(source: Source | null): number {
  return source ? 128 + source.text.length * 4 + source.starts.length * 24
    + source.includes.reduce((bytes, include) => bytes + 96 + (include.name?.length ?? 0) * 2, 0)
    + source.scopes.reduce((bytes, point) => bytes + 160 + point.scope.namespace.length * 2, 0) : 8;
}

/** Call when the resolver's source/node snapshot changes, including included files. */
export function clearCppBindingEvidence(context: ResolutionContext): void { caches.delete(context); }

function cacheFor(context: ResolutionContext): Cache {
  let cache = caches.get(context);
  if (!cache) {
    cache = {
      text: new EvidenceCache(64, 8 * 1024 * 1024, text => (text?.length ?? 0) * 2),
      sources: new EvidenceCache(64, 32 * 1024 * 1024, sourceWeight),
      // Count the complete source for every declaration holding it. Shared
      // sources are intentionally overcharged, so no hidden unbounded roots
      // survive eviction of the source cache itself.
      declarations: new EvidenceCache(512, 16 * 1024 * 1024, decl => decl
        ? 128 + sourceWeight(decl.source) + (decl.prefix.length + decl.text.length) * 2 : 8),
      reach: new EvidenceCache(128, 4 * 1024 * 1024, reach => 128
        + [...reach.definite, ...reach.possible].reduce((bytes, file) => bytes + 48 + file.length * 2, 0)),
      includeChoices: new EvidenceCache(128, 2 * 1024 * 1024, choices => 64
        + choices.files.reduce((bytes, file) => bytes + 32 + file.length * 2, 0)),
    };
    caches.set(context, cache);
  }
  return cache;
}

function fileKey(file: string): string { return path.posix.normalize(file.replace(/\\/g, '/')); }
function cpp(ref: UnresolvedRef): boolean { return ref.language === 'c' || ref.language === 'cpp'; }
function relevant(node: Node): boolean {
  return (node.language === 'c' || node.language === 'cpp')
    && (node.kind === 'function' || node.kind === 'variable' || node.kind === 'constant');
}
function dialect(file: string, fallback: Dialect): Dialect {
  if (/\.c$/i.test(file)) return 'c';
  if (/\.(?:cpp|cc|cxx|c\+\+|mm)$/i.test(file)) return 'cpp';
  return fallback; // A header's language linkage depends on its includer.
}
function and(left: Condition, right: Condition): Condition {
  return left === false || right === false ? false : left === true && right === true ? true : null;
}
function not(value: Condition): Condition { return value === null ? null : !value; }
function condition(expression: string, language: Dialect): Condition {
  const value = expression.trim();
  if (/^\(?\s*0\s*\)?$/.test(value)) return false;
  if (/^\(?\s*1\s*\)?$/.test(value)) return true;
  if (/^(?:defined\s*(?:\(\s*__cplusplus\s*\)|__cplusplus)|__cplusplus)$/.test(value)) return language === 'cpp';
  if (/^!\s*(?:defined\s*(?:\(\s*__cplusplus\s*\)|__cplusplus)|__cplusplus)$/.test(value)) return language !== 'cpp';
  return null;
}

function sourceFor(file: string, language: Dialect, context: ResolutionContext): Source | null {
  file = fileKey(file);
  const cache = cacheFor(context), key = `${language}:${file}`;
  if (cache.sources.has(key)) return cache.sources.get(key)!;
  let text = cache.text.get(file);
  if (text === undefined) {
    text = context.readFile(file);
    cache.text.set(file, text);
  }
  if (text == null || text.length > MAX_SOURCE_LENGTH) { cache.sources.set(key, null); return null; }
  const masked = maskCStyleCommentsAndLiterals(text);
  const lines = masked.split('\n'), original = text.split('\n');
  const active: Condition[] = [], starts: number[] = [], includes: Include[] = [];
  const stack: Array<{ parent: Condition; taken: Condition }> = [];
  let state: Condition = true, offset = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(offset);
    offset += lines[i]!.length + 1;
    active.push(state);
    const directive = /^\s*#\s*(\w+)\b(.*)/.exec(lines[i]!);
    if (!directive) {
      if (state === false) lines[i] = lines[i]!.replace(/[^\r]/g, ' ');
      continue;
    }
    const command = directive[1]!, argument = directive[2]!.trim();
    if (command === 'include' && state !== false) {
      const literal = /^\s*#\s*include\s*([<"])([^">\r\n]+)[">]\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/.exec(original[i]!);
      includes.push({ line: i + 1, name: literal?.[2], quoted: literal?.[1] === '"', active: state });
    }
    if (command === 'if' || command === 'ifdef' || command === 'ifndef') {
      let branch = command === 'if' ? condition(argument, language)
        : argument === '__cplusplus' ? language === 'cpp' : null;
      if (command === 'ifndef') branch = not(branch);
      stack.push({ parent: state, taken: branch });
      state = and(state, branch);
    } else if (command === 'else' || command === 'elif') {
      const parent = stack.at(-1);
      if (parent) {
        const branch = command === 'else' ? true : condition(argument, language);
        state = and(parent.parent, and(not(parent.taken), branch));
        parent.taken = parent.taken === true || branch === true ? true
          : parent.taken === false && branch === false ? false : null;
      } else state = null;
    } else if (command === 'endif') state = stack.pop()?.parent ?? null;
    // Never interpret braces/semicolons in a macro replacement as source scope.
    lines[i] = lines[i]!.replace(/[^\r]/g, ' ');
    while (/\\\r?$/.test(original[i]!) && i + 1 < lines.length) {
      i++;
      starts.push(offset);
      offset += lines[i]!.length + 1;
      active.push(null);
      lines[i] = lines[i]!.replace(/[^\r]/g, ' ');
    }
  }
  const code = lines.join('\n');
  const scopes: ScopePoint[] = [{ offset: 0,
    scope: { namespace: '', anonymous: false, ordinary: true, linkage: language } }];
  const parents: Scope[] = [];
  let scope = scopes[0]!.scope, boundary = 0, line = 0, uncertainScope = false;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '\n') line++;
    if (code[i] === '{') {
      const prefix = code.slice(boundary, i).trim();
      const rawPrefix = text.slice(boundary, i).trim();
      const namespace = /^(?:inline\s+)?namespace(?:\s+([A-Za-z_]\w*(?:::\w+)*))?\s*$/.exec(prefix);
      const linkage = /^extern\s+"(C|C\+\+)"\s*$/.exec(rawPrefix);
      if (active[line] === null) uncertainScope = true;
      parents.push(scope);
      scope = {
        namespace: namespace?.[1] ? [scope.namespace, namespace[1]].filter(Boolean).join('::') : scope.namespace,
        anonymous: scope.anonymous || (!!namespace && !namespace[1]),
        ordinary: scope.ordinary && (!!namespace || !!linkage) && !uncertainScope,
        linkage: linkage ? linkage[1] === 'C' ? 'c' : 'cpp' : scope.linkage,
      };
      scopes.push({ offset: i + 1, scope });
      boundary = i + 1;
    } else if (code[i] === '}') {
      scope = parents.pop() ?? { namespace: '', anonymous: false, ordinary: false, linkage: null };
      if (uncertainScope) scope = { ...scope, ordinary: false, linkage: null };
      scopes.push({ offset: i + 1, scope });
      boundary = i + 1;
    } else if (code[i] === ';') boundary = i + 1;
    else if (code[i] === '\n' && /^\s*#/.test(original[line - 1] ?? '')) boundary = i + 1;
  }
  const result = { text, code, starts, active, includes, scopes };
  cache.sources.set(key, result);
  return result;
}

function scopeAt(source: Source, offset: number): Scope {
  let low = 0, high = source.scopes.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (source.scopes[middle]!.offset <= offset) low = middle; else high = middle;
  }
  return source.scopes[low]!.scope;
}

function conditionAt(source: Source, offset: number): Condition {
  let low = 0, high = source.starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (source.starts[middle]! <= offset) low = middle; else high = middle;
  }
  return source.active[low] ?? null;
}

function declaration(node: Node, language: Dialect, context: ResolutionContext): Declaration | null {
  language = dialect(node.filePath, language);
  const cache = cacheFor(context), key = `${language}:${node.id}:${node.startLine}:${node.startColumn}`;
  if (cache.declarations.has(key)) return cache.declarations.get(key)!;
  const source = sourceFor(node.filePath, language, context);
  let result: Declaration | null = null;
  if (source && /^[A-Za-z_]\w*$/.test(node.name)) {
    const at = source.starts[node.startLine - 1];
    if (at !== undefined) {
      const declaredAt = at + node.startColumn;
      const end = Math.min(source.code.length, (source.starts[Math.max(node.endLine, node.startLine)] ?? source.code.length), declaredAt + 4096);
      const namePattern = new RegExp(`\\b${node.name}\\b`, 'g');
      namePattern.lastIndex = declaredAt;
      const match = namePattern.exec(source.code);
      if (match && match.index < end) {
        const nameAt = match.index;
        const boundary = Math.max(source.code.lastIndexOf(';', nameAt - 1), source.code.lastIndexOf('{', nameAt - 1),
          source.code.lastIndexOf('}', nameAt - 1), nameAt - 4096);
        const start = boundary + 1;
        const prefix = source.code.slice(start, nameAt).trim();
        const enclosing = scopeAt(source, nameAt);
        // Resolving an out-of-line owner requires class/namespace evidence that
        // this module does not supply; do not classify it as a global function.
        const scope = /::\s*$/.test(prefix) ? { ...enclosing, ordinary: false } : enclosing;
        const rawPrefix = source.text.slice(start, nameAt);
        const explicit = /\bextern\s+"(C|C\+\+)"/.exec(rawPrefix);
        result = { source, offset: nameAt, prefix, text: source.code.slice(start, end).trim(), scope,
          active: source.active[node.startLine - 1] ?? null,
          linkage: explicit ? explicit[1] === 'C' ? 'c' : 'cpp' : scope.linkage };
      }
    }
  }
  cache.declarations.set(key, result);
  return result;
}

function reachable(ref: Pick<UnresolvedRef, 'filePath' | 'line' | 'language'>, context: ResolutionContext): Reachable {
  const cache = cacheFor(context), language: Dialect = ref.language === 'c' ? 'c' : 'cpp';
  const root = fileKey(ref.filePath), source = sourceFor(root, dialect(root, language), context);
  const includeCount = source?.includes.filter(i => i.line < ref.line).length ?? -1;
  const key = `${language}:${root}:${includeCount}`;
  const previous = cache.reach.get(key);
  if (previous) return previous;
  const result: Reachable = { definite: new Set([root]), possible: new Set([root]), open: false };
  const scanned = new Map<string, boolean>();
  const visit = (file: string, definite: boolean, until = Infinity): void => {
    if (scanned.get(file) === true || (scanned.has(file) && !definite)) return;
    if (scanned.size >= MAX_INCLUDE_FILES) { result.open = true; return; }
    scanned.set(file, definite);
    const contents = sourceFor(file, dialect(file, language), context);
    if (!contents) { result.open = true; return; }
    for (const include of contents.includes) {
      if (include.line >= until || include.active === false) continue;
      if (!include.name) { result.open = true; continue; }
      const relative = fileKey(path.posix.join(path.posix.dirname(file), include.name));
      const direct = include.quoted && context.fileExists(relative);
      // Aggregated -I directories are not a per-TU search order. Suffix matches
      // are only possibilities, even if the current graph contains just one.
      let choices: string[];
      if (direct) choices = [relative];
      else {
        let matches = cache.includeChoices.get(include.name);
        if (!matches) {
          matches = { files: [], complete: true };
          for (const indexedFile of context.getAllFiles()) {
            const candidate = fileKey(indexedFile);
            if (candidate !== include.name && !candidate.endsWith(`/${include.name}`)) continue;
            if (matches.files.length >= MAX_INCLUDE_FILES) { matches.complete = false; break; }
            matches.files.push(candidate);
          }
          cache.includeChoices.set(include.name, matches);
        }
        choices = matches.files;
        if (!matches.complete) result.open = true;
      }
      if (!choices.length) { result.open = true; continue; }
      for (const choice of choices) {
        if (!result.possible.has(choice) && result.possible.size >= MAX_INCLUDE_FILES) {
          result.open = true;
          continue;
        }
        const certain = definite && direct && include.active === true;
        result.possible.add(choice);
        if (certain) result.definite.add(choice);
        visit(choice, certain);
      }
    }
  };
  visit(root, true, ref.line);
  cache.reach.set(key, result);
  return result;
}

function visibility(node: Node, decl: Declaration | null, ref: UnresolvedRef, context: ResolutionContext): Evidence {
  if (!decl || decl.active === false) return decl?.active === false ? 'forbidden' : 'unknown';
  if (fileKey(node.filePath) === fileKey(ref.filePath)) {
    return (node.startLine < ref.line || node.startLine === ref.line && node.startColumn <= ref.column)
      && decl.active === true ? 'allowed' : 'unknown';
  }
  return reachable(ref, context).definite.has(fileKey(node.filePath)) && decl.active === true ? 'allowed' : 'unknown';
}

function simpleTypePrefix(prefix: string, allowAuto = false): boolean {
  const words = prefix.replace(/\b(?:static|extern|inline|constexpr|consteval|constinit|register|thread_local|const|volatile|restrict)\b/g, '')
    .replace(/[*&]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every(word => allowAuto && word === 'auto'
    || /^(?:void|bool|_Bool|char|wchar_t|char8_t|char16_t|char32_t|short|int|long|signed|unsigned|float|double)$/.test(word));
}

function isBuiltinNonCallable(node: Node, decl: Declaration): boolean {
  // Deliberately exclude parentheses and user-defined types: function pointers,
  // references, conversion-to-function objects, aliases and lambdas remain unknown.
  return (node.kind === 'variable' || node.kind === 'constant') && simpleTypePrefix(decl.prefix);
}

function hasPriorExtern(node: Node, decl: Declaration, context: ResolutionContext): boolean {
  // Source-written declarations can be absent from the graph (notably variables).
  // This narrow spelling check suppresses const-default linkage inference; it
  // never proves a binding or assumes that an unknown condition is active.
  const pattern = new RegExp(`\\bextern\\s+(?:const\\s+)?[^;{}()=]*\\b${node.name}\\s*(?:;|\\[)`, 'g');
  if (pattern.test(decl.source.code.slice(0, decl.offset))) return true;
  const prior = reachable({ filePath: node.filePath, line: node.startLine, language: node.language }, context);
  for (const file of prior.possible) {
    if (file === fileKey(node.filePath)) continue;
    const source = sourceFor(file, node.language === 'c' ? 'c' : 'cpp', context);
    pattern.lastIndex = 0;
    if (source && pattern.test(source.code)) return true;
  }
  return prior.open;
}

/** A deliberately small, provable parameter identity. Aliases, macros, arrays,
 * templates and nested function declarators need more type information and stay
 * unknown. Normalize builtin spelling and top-level parameter cv: `signed int`
 * and `const int` are the same by-value parameter as `int`.
 */
function bindingParameterKey(node: Pick<Node, 'name' | 'signature'>): string | null {
  const raw = cppParameterKey(node);
  if (raw === null) return null;
  if (raw === '' || raw === 'void') return '';
  const result: string[] = [];
  for (const parameter of raw.split(' , ')) {
    const tokens = parameter.split(' ');
    const modifierAt = tokens.findIndex(token => token === '*' || token === '&' || token === '&&');
    const base = modifierAt < 0 ? tokens : tokens.slice(0, modifierAt);
    const cv = [...new Set(base.filter(token => token === 'const' || token === 'volatile'))].sort();
    const words = base.filter(token => token !== 'const' && token !== 'volatile');
    const count = (word: string): number => words.filter(token => token === word).length;
    let type: string;
    if (words.length === 1 && /^(?:bool|char|wchar_t|char8_t|char16_t|char32_t|float|double|void)$/.test(words[0]!)) type = words[0]!;
    else if (words.length === 2 && count('char') === 1 && count('signed') + count('unsigned') === 1) type = `${count('unsigned') ? 'unsigned' : 'signed'} char`;
    else if (words.length === 2 && count('long') === 1 && count('double') === 1) type = 'long double';
    else if (words.length > 0 && words.every(word => /^(?:int|signed|unsigned|short|long)$/.test(word))
      && count('int') <= 1 && count('signed') + count('unsigned') <= 1 && count('short') <= 1
      && count('long') <= 2 && !(count('short') && count('long'))) {
      type = `${count('unsigned') ? 'unsigned ' : ''}${count('short') ? 'short' : count('long') === 2 ? 'long long' : count('long') ? 'long' : 'int'}`;
    } else return null;
    const modifiers = modifierAt < 0 ? [] : tokens.slice(modifierAt);
    if (!modifiers.length) {
      if (type === 'void') return null;
      result.push(type);
      continue;
    }
    const layers: string[] = [];
    let reference = '';
    for (let i = 0; i < modifiers.length;) {
      const modifier = modifiers[i++]!;
      if (modifier === '&' || modifier === '&&') {
        if (i !== modifiers.length) return null;
        reference = modifier;
        break;
      }
      if (modifier !== '*') return null;
      const qualifiers: string[] = [];
      while (modifiers[i] === 'const' || modifiers[i] === 'volatile') qualifiers.push(modifiers[i++]!);
      layers.push(['*', ...new Set(qualifiers.sort())].join(' '));
    }
    if (!reference && layers.length) layers[layers.length - 1] = '*';
    result.push([...cv, type, ...layers, reference].filter(Boolean).join(' '));
  }
  return result.join(' , ');
}

function priorParameterKey(code: string, start: number, open: number, name: string): string | null {
  let depth = 1;
  for (let i = open + 1; i < Math.min(code.length, open + 4096); i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) {
      // Require a complete declaration/function header, rather than treating
      // an arbitrary call-shaped fragment as a previous static declaration.
      if (!/^\s*(?:noexcept(?:\s*\([^;{}]*\))?\s*)?[;{]/.test(code.slice(i + 1))) return null;
      return bindingParameterKey({ name, signature: code.slice(start, i + 1) });
    }
  }
  return null;
}

function storageLinkage(node: Node, decl: Declaration | null, context: ResolutionContext): StorageLinkage {
  if (!decl?.scope.ordinary) return 'unknown';
  if (decl.scope.anonymous || /\bstatic\b/.test(decl.prefix)) return 'internal';
  // Metadata's missing isStatic/isExported flags never establish external linkage.
  // Only this small source-written declaration grammar provides that witness.
  if (!simpleTypePrefix(decl.prefix, true)) return 'unknown';
  if (node.kind === 'function') {
    const parameterKey = bindingParameterKey(node);
    const prior = reachable({ filePath: node.filePath, line: node.startLine, language: node.language }, context);
    let uncertain = prior.open;
    const previous = new RegExp(`\\bstatic\\s+[^;{}=]*\\b${node.name}\\s*\\(`, 'g');
    for (const file of prior.possible) {
      const source = file === fileKey(node.filePath) ? decl.source
        : sourceFor(file, node.language === 'c' ? 'c' : 'cpp', context);
      if (!source) { uncertain = true; continue; }
      const code = file === fileKey(node.filePath) ? source.code.slice(0, decl.offset) : source.code;
      previous.lastIndex = 0;
      for (let match; (match = previous.exec(code));) {
        const scope = scopeAt(source, match.index);
        if (!scope.ordinary || scope.namespace !== decl.scope.namespace) continue;
        const priorKey = priorParameterKey(code, match.index, match.index + match[0].length - 1, node.name);
        if (parameterKey === null || priorKey === null) { uncertain = true; continue; }
        if (parameterKey !== priorKey) continue;
        if (conditionAt(source, match.index) === true && prior.definite.has(file)) return 'internal';
        uncertain = true;
      }
    }
    return uncertain ? 'unknown' : 'external';
  }
  if (node.language !== 'cpp') return 'external';
  if (/\b(?:extern|inline)\b/.test(decl.prefix)) return 'external';
  if (/\btemplate\b|[&(),=<>]/.test(decl.prefix)) return 'unknown';
  const objectQualifiers = decl.prefix.slice(decl.prefix.lastIndexOf('*') + 1);
  const constant = /\bconstexpr\b/.test(decl.prefix) || /\bconst\b/.test(objectQualifiers);
  if (!constant || /\bvolatile\b/.test(objectQualifiers)) return 'external';
  return hasPriorExtern(node, decl, context) ? 'unknown' : 'internal';
}

function languageLinkage(node: Node, decl: Declaration, context: ResolutionContext): Dialect | null {
  if (decl.linkage !== 'cpp' || node.kind !== 'function' || !decl.scope.ordinary) return decl.linkage;
  const key = bindingParameterKey(node);
  if (key === null) return null;
  const site: UnresolvedRef = { fromNodeId: node.id, referenceName: node.name, referenceKind: 'references',
    filePath: node.filePath, line: node.startLine, column: node.startColumn, language: 'cpp' };
  let uncertain = false;
  for (const other of context.getNodesByName(node.name)) {
    if (other.id === node.id || other.kind !== 'function' || bindingParameterKey(other) !== key) continue;
    const prior = declaration(other, 'cpp', context);
    if (!prior?.scope.ordinary || prior.linkage !== 'c' || prior.scope.namespace !== decl.scope.namespace) continue;
    if (visibility(other, prior, site, context) === 'allowed') return 'c';
    // A possible include can supply the prior language linkage, but is not a
    // positive declaration witness. Same-file declarations after this one do not.
    if (fileKey(other.filePath) !== fileKey(node.filePath)) {
      const files = reachable(site, context);
      if (files.open || files.possible.has(fileKey(other.filePath))) uncertain = true;
    } else if (other.startLine < node.startLine || other.startLine === node.startLine && other.startColumn < node.startColumn) {
      uncertain = true;
    }
  }
  return uncertain ? null : 'cpp';
}

function sameEntity(left: Node, a: Declaration, right: Node, b: Declaration, context: ResolutionContext): boolean {
  if (!a.scope.ordinary || !b.scope.ordinary || a.scope.namespace !== b.scope.namespace
    || a.scope.anonymous || b.scope.anonymous) return false;
  if (left.kind !== 'function' || right.kind !== 'function') return false;
  const leftLinkage = languageLinkage(left, a, context), rightLinkage = languageLinkage(right, b, context);
  if (leftLinkage === null || leftLinkage !== rightLinkage) return false;
  const leftKey = bindingParameterKey(left), rightKey = bindingParameterKey(right);
  if (leftKey === null || rightKey === null || leftKey !== rightKey) return false;
  const type = (decl: Declaration): string => decl.prefix
    .replace(/\b(?:extern|inline|constexpr|consteval)\b/g, '').replace(/\s+/g, ' ').trim();
  return type(a) === type(b);
}

function targetEvidence(node: Node, ref: UnresolvedRef, context: ResolutionContext): Evidence {
  if (!cpp(ref) || !relevant(node) || (ref.referenceKind !== 'calls' && ref.referenceKind !== 'references')) return 'unknown';
  const decl = declaration(node, ref.language as Dialect, context);
  if (decl && ref.referenceKind === 'calls' && isBuiltinNonCallable(node, decl)) return 'forbidden';
  const visible = visibility(node, decl, ref, context);
  if (visible === 'forbidden') return visible;
  if (storageLinkage(node, decl, context) === 'internal') {
    const files = reachable(ref, context);
    if (!files.possible.has(fileKey(node.filePath)) && !files.open) return 'forbidden';
  }
  if (decl?.scope.ordinary && visible !== 'allowed') {
    for (const other of context.getNodesByName(node.name)) {
      if (other.id === node.id || !relevant(other)) continue;
      const witness = declaration(other, ref.language as Dialect, context);
      if (!witness?.scope.ordinary || visibility(other, witness, ref, context) !== 'allowed'
        || witness.scope.namespace !== decl.scope.namespace) continue;
      // A C-linkage declaration and a C++-linkage function cannot be the same
      // entity. Bare-name C declaration/definition synthesis is not evidence.
      if (node.kind === 'function' && other.kind === 'function'
        && simpleTypePrefix(decl.prefix) && simpleTypePrefix(witness.prefix)) {
        const candidateKey = bindingParameterKey(node), witnessKey = bindingParameterKey(other);
        if (candidateKey === null || witnessKey === null || candidateKey !== witnessKey) continue;
        const candidateLinkage = languageLinkage(node, decl, context), witnessLinkage = languageLinkage(other, witness, context);
        if (candidateLinkage !== null && witnessLinkage !== null && candidateLinkage !== witnessLinkage) return 'forbidden';
      }
    }
  }
  return visible;
}

/** Final-strategy guard: unknown evidence is not a veto. */
export function isCppBindingTargetAllowed(node: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  return targetEvidence(node, ref, context) !== 'forbidden';
}

/** Prefer a proven visible declaration and its proven external definitions.
 * An unsupported candidate stays eligible for the final guard; this preference
 * only applies when this lookup actually contains a positive visibility witness.
 */
export function filterCppBindingCandidates(nodes: Node[], ref: UnresolvedRef, context: ResolutionContext): Node[] {
  if (!cpp(ref) || (ref.referenceKind !== 'calls' && ref.referenceKind !== 'references')) return nodes;
  const evidence = new Map(nodes.map(node => [node, targetEvidence(node, ref, context)]));
  const eligible = nodes.filter(node => evidence.get(node) !== 'forbidden');
  const visible = eligible.filter(node => relevant(node) && evidence.get(node) === 'allowed'
    && declaration(node, ref.language as Dialect, context)?.scope.ordinary);
  if (!visible.length) return eligible;
  return eligible.filter(node => {
    if (!relevant(node) || evidence.get(node) === 'allowed') return true;
    const decl = declaration(node, ref.language as Dialect, context);
    if (!decl?.scope.ordinary) return true;
    if (reachable(ref, context).possible.has(fileKey(node.filePath))) return true;
    return visible.some(other => {
      const witness = declaration(other, ref.language as Dialect, context)!;
      return storageLinkage(other, witness, context) === 'external'
        && storageLinkage(node, decl, context) === 'external'
        && sameEntity(node, decl, other, witness, context);
    });
  });
}
