import type { LocateDocument, LocateSignal, SignalOrigin } from './types';

const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:(?:::|\.)[A-Za-z_$][\w$]*)*$/;
const PATH = /\.(?:cpp|cc|cxx|c|h|hpp|hxx|py|ts|tsx|js|jsx|rs|go|java|cs|lua)(?::\d+(?::\d+)?)?$/i;
const GENERIC = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'auto', 'void', 'int', 'const', 'std', 'machine', 'options', 'file', 'result']);
const MAX_SIGNALS = 64;
const EXCLUSION = /(?:本次|此次|这次).{0,15}(?:不改变|不修改|不涉及|不处理)|(?:不在|不属于).{0,8}范围|out.of.scope|do not (?:change|modify)/i;

export function isExcluded(signal: LocateSignal): boolean {
  return signal.mentions.every(m => m.excluded);
}

export function signalWeight(signal: LocateSignal): number {
  if (isExcluded(signal)) return 0;
  return Math.max(...signal.mentions.filter(m => !m.excluded).map(m =>
    m.origin === 'prose' ? 1 : m.origin === 'code' ? 0.85 : 0.25));
}

/** Extract code anchors, not arbitrary words from Chinese prose or local variables. */
export function extractLocateDocument(input: string): LocateDocument {
  const signals = new Map<string, LocateSignal>();
  const snippets: LocateDocument['snippets'] = [];
  const lines = input.split(/\r?\n/);
  let heading = '';
  let context = '';
  let truncated = false;
  const explicitNames = new Set([...input.matchAll(/`([A-Za-z_$][\w$]*(?:(?:::|\.)[A-Za-z_$][\w$]*)*)`/g)]
    .map(m => m[1]!.split(/::|\./).pop()!));
  const add = (raw: string, kind: LocateSignal['kind'], line: number, origin: SignalOrigin, excluded: boolean) => {
    const text = raw.trim().replace(/\(\)$/, '');
    if (!text || text.length > 240 || (kind === 'symbol' && (!IDENTIFIER.test(text) || GENERIC.has(text)))) return;
    const key = `${kind}:${text}`;
    let signal = signals.get(key);
    if (!signal) {
      if (signals.size >= MAX_SIGNALS) { truncated = true; return; }
      signal = { text, kind, mentions: [] };
      signals.set(key, signal);
    }
    if (signal.mentions.length < 12 && !signal.mentions.some(m => m.line === line && m.origin === origin)) {
      signal.mentions.push({ line, origin, excluded });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*#{1,6}\s/.test(line)) { heading = line; context = ''; }
    const fence = /^\s*(`{3,}|~{3,})(\S*)/.exec(line);
    if (fence) {
      const block: string[] = [];
      const start = i + 2;
      while (++i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) block.push(lines[i]!);
      const description = heading + '\n' + context;
      const origin: SignalOrigin = /伪代码|pseudocode/i.test(description) || /^(text|pseudo)$/i.test(fence[2] ?? '')
        ? 'pseudocode' : /草案|设想|尚未|draft|propos/i.test(description) ? 'draft' : 'code';
      const excluded = /范围外|明确排除|out.of.scope/i.test(heading);
      if (snippets.length < 12) snippets.push({ line: start, origin, lines: block.slice(0, 80) });
      else truncated = true;
      block.slice(0, 80).forEach((code, offset) => {
        const syntax = code.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*$/g, '');
        // Qualified calls are useful. Bare calls are kept, but object-local fields aren't.
        for (const match of syntax.matchAll(/\b([A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)*)\s*\(/g)) {
          const name = match[1]!;
          if (name.startsWith('std::')) continue;
          const prefix = syntax.slice(0, match.index).trimEnd();
          if ((prefix.endsWith('.') || prefix.endsWith('->')) && !explicitNames.has(name)) continue;
          add(name, 'symbol', start + offset, origin, excluded);
        }
        for (const match of syntax.matchAll(/\b[A-Z][A-Z0-9_]{4,}\b/g)) {
          add(match[0], 'symbol', start + offset, origin, excluded);
        }
        if (origin === 'code') for (const match of code.matchAll(/"([^"\r\n]{12,160})"/g)) {
          // Stable prefix before formatting/escape sequences is enough for a bounded literal search.
          const literal = match[1]!.split(/%|\\/)[0]!.trim();
          if (literal.length >= 12) add(literal, 'literal', start + offset, origin, excluded);
        }
      });
      context = '';
      continue;
    }
    if (line.trim()) context = (context + '\n' + line).slice(-1200);
    else context = '';
    // Explicit contrast starts a new scope: "不修改 A，但需要 B" must keep B.
    const split = line.split(/(?:[，,；;。]\s*)?(?:但是|但需要|但要|但本次|however|but\s)/i);
    const clauses = split.slice(1).some(part => /`[^`]+`/.test(part)) ? split : [line];
    for (const clause of clauses) {
      const excluded = /范围外|明确排除|out.of.scope/i.test(heading) || EXCLUSION.test(clause);
      for (const match of clause.matchAll(/`([^`\r\n]+)`/g)) {
        const value = match[1]!;
        add(value, PATH.test(value) ? 'path' : IDENTIFIER.test(value.replace(/\(\)$/, '')) ? 'symbol' : 'literal', i + 1, 'prose', excluded);
      }
      // Also accept strong unquoted identifiers; do not tokenize ordinary English prose.
      const prose = clause.replace(/`[^`]*`/g, '');
      for (const match of prose.matchAll(/\b[A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)+|\b[A-Za-z][\w]*_[\w]+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g)) {
        add(match[0], 'symbol', i + 1, 'prose', excluded);
      }
    }
  }
  // A bare occurrence in a snippet must not turn an explicitly excluded qualified symbol into a seed.
  for (const signal of signals.values()) {
    if (signal.text.includes('::') || signal.text.includes('.') || signal.kind !== 'symbol') continue;
    const qualified = [...signals.values()].filter(s => s.kind === 'symbol' && s.text !== signal.text &&
      s.text.split(/::|\./).pop() === signal.text);
    if (qualified.length && qualified.every(isExcluded) && signal.mentions.every(m => m.origin !== 'prose')) {
      signal.mentions.forEach(m => { m.excluded = true; });
    }
  }
  return { signals: [...signals.values()], snippets, truncated };
}
