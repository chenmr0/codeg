import type { Node } from '../types';
import { maskCStyleCommentsAndLiterals } from '../extraction/grammars';
import type { UnresolvedRef } from './types';

const MAX_LINES = 256;
const MAX_CODE_UNITS = 16 * 1024;
const MAX_SITES_PER_TEXT = 128;
// Only immutable source evidence is memoized, never graph lookup results.
// Weak keys do not retain files after the resolver's bounded line cache drops them.
const evidence = new WeakMap<readonly string[], Map<string, boolean>>();

/**
 * Narrow negative evidence, used ONLY after typed method lookup failed.
 * A simple explicit local in an active block cannot turn into another class
 * merely because its method is not indexed. Unknown/complex shapes return false
 * and retain the existing fallback. This is not a general C++ scope/type parser.
 */
export function hasSimpleCppLocalReceiver(
  receiver: string, inferredType: string, ref: UnresolvedRef,
  source: Node | undefined, lines: readonly string[],
): boolean {
  if (!source || source.language !== 'cpp' || (source.kind !== 'function' && source.kind !== 'method') ||
      source.filePath !== ref.filePath || ref.line < source.startLine || ref.line > source.endLine ||
      ref.line - source.startLine >= MAX_LINES || receiver.length > 256 || inferredType.length > 256 ||
      !/^\w+$/.test(receiver)) return false;
  const key = `${source.startLine}:${source.startColumn}:${ref.line}:${ref.column}:${receiver}:${inferredType}`;
  let memo = evidence.get(lines);
  const cached = memo?.get(key);
  if (cached !== undefined) return cached;
  const result = inspectLocal(receiver, inferredType, ref, source, lines);
  if (!memo) { memo = new Map(); evidence.set(lines, memo); }
  if (memo.size >= MAX_SITES_PER_TEXT) memo.delete(memo.keys().next().value!);
  memo.set(key, result);
  return result;
}

function inspectLocal(receiver: string, inferredType: string, ref: UnresolvedRef,
  source: Node, lines: readonly string[]): boolean {
  const callLine = lines[ref.line - 1];
  const access = callLine?.slice(ref.column).match(new RegExp(`^${receiver}\\s*(\\.|->)`));
  if (!access) return false; // includes calls whose stored location is not the receiver
  const chunks: string[] = [];
  let length = 0;
  for (let row = source.startLine - 1; row < ref.line; row++) {
    const line = lines[row];
    if (line === undefined) return false;
    const start = row === source.startLine - 1 ? source.startColumn : 0;
    const end = row === ref.line - 1 ? ref.column + access[0].length : line.length;
    if (end < start || (length += end - start + 1) > MAX_CODE_UNITS) return false;
    chunks.push(line.slice(start, end));
  }
  const masked = maskCStyleCommentsAndLiterals(chunks.join('\n'));
  const callOffset = masked.length - access[0].length;
  if (masked.slice(callOffset) !== access[0]) return false;
  const prefix = masked.slice(0, callOffset);
  // Macro splicing/conditionals, local type definitions/aliases and lambdas need
  // more context than this bounded check has. Do not tighten their old behavior.
  if (/[#\\\[\]]/.test(prefix) || /\b(?:using|typedef|template|class|struct|union|enum)\b/.test(prefix)) return false;
  const occurrences = [...prefix.matchAll(new RegExp(`\\b${receiver}\\b`, 'g'))];
  if (!occurrences.length) return false;
  const first = occurrences[0]!.index!;
  // Later ordinary member uses are harmless. Other uses can include a shadowing
  // binding or capture; decline rather than treating them as the first local.
  if (occurrences.slice(1).some(m => !/^\s*(?:\.|->)/.test(prefix.slice(m.index! + receiver.length)))) return false;
  const start = Math.max(prefix.lastIndexOf(';', first), prefix.lastIndexOf('{', first), prefix.lastIndexOf('}', first)) + 1;
  const declaration = prefix.slice(start).match(new RegExp(
    `^\\s*(?:(?:const|volatile|static|constexpr)\\s+)*([A-Za-z_]\\w*(?:::\\w+)*)` +
    `(?:\\s*([*&])\\s*(?:const\\s+)?|\\s+)${receiver}\\s*(?=[;=({])`,
  ));
  if (!declaration || declaration[1]!.split('::').pop() !== inferredType) return false;
  // A value/reference may implement operator->. Only an actual pointer or a
  // source-spelled dot access rules that proxy behavior out.
  if (access[1] === '->' && declaration[2] !== '*') return false;
  const stack: number[] = [];
  let parentheses = 0, declaringScope: number | undefined;
  for (let i = 0; i < prefix.length; i++) {
    if (i === first) {
      // for/if/catch bindings have lifetimes not described by braces alone.
      if (parentheses !== 0 || !stack.length) return false;
      declaringScope = stack[stack.length - 1];
    }
    if (prefix[i] === '(') parentheses++;
    else if (prefix[i] === ')') parentheses--;
    else if (prefix[i] === '{') stack.push(i);
    else if (prefix[i] === '}') {
      const closed = stack.pop();
      if (closed === undefined || closed === declaringScope) return false;
    }
    if (parentheses < 0) return false;
  }
  return declaringScope !== undefined && stack.includes(declaringScope);
}
