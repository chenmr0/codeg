import type { Node } from '../types';
import type { ResolutionContext, UnresolvedRef } from './types';
import { cppIdentityTokens as tokens, isCppIdentityIdentifier as identifier } from '../extraction/c-cpp-macro-types';
import { isCppBindingTargetAllowed } from './cpp-binding-evidence';

/** Arity is negative admission evidence, not an overload type evaluator. */
export type CppCallArityCompatibility = 'compatible' | 'incompatible' | 'unknown';
type Parameters = { min: number; max: number; key: string; spelling: string[] };
const MAX_TEXT = 16 * 1024;
const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const TYPE_WORDS = new Set(['void', 'bool', 'char', 'wchar_t', 'char8_t', 'char16_t', 'char32_t',
  'short', 'int', 'long', 'signed', 'unsigned', 'float', 'double', 'const', 'volatile', 'auto']);

function closeAt(ts: string[], start: number): number {
  const stack: string[] = [];
  for (let i = start; i < ts.length; i++) {
    const t = ts[i]!;
    if (PAIRS[t]) stack.push(PAIRS[t]!);
    else if (Object.values(PAIRS).includes(t)) {
      if (stack.pop() !== t) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

function split(ts: string[]): string[][] | null {
  if (!ts.length) return [];
  const parts: string[][] = [];
  let start = 0;
  for (let i = 0; i <= ts.length; i++) {
    if (PAIRS[ts[i]!]) { const end = closeAt(ts, i); if (end < 0) return null; i = end; }
    else if (i === ts.length || ts[i] === ',') {
      if (i === start) return null;
      parts.push(ts.slice(start, i)); start = i + 1;
    } else if ([')', ']', '}', '>'].includes(ts[i]!)) return null;
  }
  return parts;
}

function defaultAt(ts: string[]): number {
  for (let i = 0; i < ts.length; i++) {
    if (PAIRS[ts[i]!]) { const end = closeAt(ts, i); if (end < 0) return -1; i = end; }
    else if (ts[i] === '=') return i;
  }
  return -1;
}

function parameterKey(ts: string[]): string {
  const result = [...ts];
  const last = result.at(-1)!;
  // Remove a simple declarator name, preserving unnamed nominal types and ::.
  if (identifier(last) && !TYPE_WORDS.has(last) && result.at(-2) !== '::' &&
      result.slice(0, -1).some(t => !['const', 'volatile', 'typename', 'class', 'struct'].includes(t))) result.pop();
  // A callback's name is inside its pointer declarator, not at the end.
  for (let i = 1; i + 1 < result.length; i++) {
    if (identifier(result[i]!) && ['*', '&', '&&'].includes(result[i - 1]!) && result[i + 1] === ')') result.splice(i, 1);
  }
  return result.join(' ');
}

function signature(node: Node): Parameters | null {
  if (!node.signature || node.signature.length > MAX_TEXT) return null;
  const ts = tokens(node.signature);
  // Angle tokens can be operators in defaults/non-type arguments, rather than
  // template delimiters. This lexical guard does not have C++ lookup evidence
  // to disambiguate them; never swallow an outer comma and veto a valid call.
  if (ts.includes('<') || ts.includes('>')) return null;
  const at = ts.findIndex((t, i) => t === node.name && ts[i + 1] === '(');
  if (at < 0) return null;
  const close = closeAt(ts, at + 1);
  if (close < 0) return null;
  let params = split(ts.slice(at + 2, close));
  if (!params) return null;
  if (params.length === 1 && params[0]!.join(' ') === 'void') params = [];
  // Before C23, an empty C function parameter list supplies no arity
  // constraint. A method in a C-tagged shared header still has C++ semantics.
  if (node.language === 'c' && node.kind !== 'method' && !params.length && ts[at + 2] !== 'void') return null;
  let min = 0, max = params.length;
  const keys: string[] = [];
  for (const param of params) {
    const optional = defaultAt(param);
    const type = optional >= 0 ? param.slice(0, optional) : param;
    if (type.includes('...')) max = Infinity;
    else if (optional < 0) min++;
    keys.push(parameterKey(type));
  }
  const qualifiers = ts.slice(close + 1).filter(t => ![';', 'override', 'final'].includes(t));
  return { min, max, key: JSON.stringify([keys, qualifiers]), spelling: ts.slice(at + 2, close) };
}

/** Equal keys identify ordinary declaration/definition pairs, not conversions. */
export function cppCallableSignatureKey(node: Node): string | null {
  const parsed = signature(node);
  return parsed ? node.qualifiedName + ':' + parsed.key : null;
}

function possibleMacro(ts: string[], context: ResolutionContext): boolean {
  return ts.some((token, i) => token === '#' || token === '\\' || identifier(token) &&
    context.getNodesByName(token).some(node => {
      if (node.kind !== 'macro') return false;
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const functionLike = new RegExp('^\\s*#\\s*define\\s+' + escaped + '\\(').test(node.signature ?? '');
      return !functionLike || ts[i + 1] === '(';
    }));
}

function argumentsAt(ref: UnresolvedRef, context: ResolutionContext): string[][] | null {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/);
  if (!lines || ref.line < 1 || ref.column < 0 || ref.line > lines.length) return null;
  let text = lines[ref.line - 1]!.slice(ref.column);
  for (let row = ref.line; row < Math.min(lines.length, ref.line + 32) && text.length < MAX_TEXT; row++) text += '\n' + lines[row];
  text = text.slice(0, MAX_TEXT);
  // The extractor represents -> with a dot, and sometimes omits this entirely.
  const ts = tokens(text);
  for (let i = 0; i + 1 < ts.length; i++) if (ts[i] === '-' && ts[i + 1] === '>') ts.splice(i, 2, '.');
  const name = tokens(ref.referenceName);
  if (ts[0] === 'this' && ts[1] === '.' && name[0] !== 'this') ts.splice(0, 2);
  if (!name.every((t, i) => ts[i] === t) || ts[name.length] !== '(') return null;
  const end = closeAt(ts, name.length);
  if (end < 0) return null;
  const raw = ts.slice(name.length + 1, end);
  if (raw.includes('...') || raw.includes('<') || raw.includes('>') || possibleMacro(raw, context)) return null;
  return split(raw);
}

export function cppCallArityCompatibility(candidate: Node, ref: UnresolvedRef,
  context: ResolutionContext): CppCallArityCompatibility {
  if ((ref.language !== 'cpp' && ref.language !== 'c') || ref.referenceKind !== 'calls' ||
      !['function', 'method'].includes(candidate.kind)) return 'unknown';
  const params = signature(candidate), args = argumentsAt(ref, context);
  if (!params || !args || possibleMacro(params.spelling, context)) return 'unknown';
  if (args.length >= params.min && args.length <= params.max) return 'compatible';
  if (args.length < params.min) {
    // Defaults belong to the declaration visible to the caller, and are often
    // omitted on definitions. Never reject a definition using its text alone.
    for (const peer of context.getNodesByQualifiedName(candidate.qualifiedName)) {
      if (peer.id === candidate.id || peer.language !== candidate.language || !isCppBindingTargetAllowed(peer, ref, context)) continue;
      const other = signature(peer);
      if (other?.key === params.key && args.length >= other.min && args.length <= other.max) return 'compatible';
    }
  }
  return 'incompatible';
}

export function isCppCallArityAllowed(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  return cppCallArityCompatibility(candidate, ref, context) !== 'incompatible';
}

export function filterCppCallCandidates(candidates: Node[], ref: UnresolvedRef, context: ResolutionContext): Node[] {
  if ((ref.language !== 'cpp' && ref.language !== 'c') || ref.referenceKind !== 'calls') return candidates;
  return candidates.filter(candidate => isCppCallArityAllowed(candidate, ref, context));
}
