/** One lexical interpretation shared by Explore retrieval, named targets and Flow.
 * Captures query syntax without inferring whether a name is existing or planned.
 */
import { isQueryNameToken, splitAtCjkSwitches } from './query-utils';

export interface QueryMention {
  start: number;
  end: number;
  raw: string;
  normalized: string;
  kind: 'symbol' | 'path' | 'prose';
  quoted: boolean;
  selected: boolean;
}
export interface QueryOmission {
  normalized: string;
  reason: 'named-token-limit' | 'duplicate' | 'mention-limit' | 'path-consumed';
}
export interface ExploreQueryIntent {
  raw: string;
  /** Original query text remains available to lexical retrieval. */
  searchQuery: string;
  /** Quote/CJK punctuation aware path view; pathTokens also preserve quoted spaces. */
  pathQuery: string;
  pathTokens: string[];
  mentions: QueryMention[];
  symbolTokens: string[];
  namedTokenLimit: number;
  /** Up to 64 explicit or identifier-shaped names, not the 16 named-target budget. */
  searchSymbols: string[];
  omitted: QueryOmission[];
}

const SOURCE_EXTENSION = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte|astro|erl|hrl)$/i;
const FILE_TAIL = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte|astro|erl|hrl|md|txt|json|yaml|yml|sql|proto)(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)?$/i;
const QUOTES: Readonly<Record<string, string>> = { '\x60': '\x60', '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』' };
const BREAK = /[\s,;!?，。；：、！？（）【】《》]/u;
const MAX_MENTIONS = 512;
interface Lexeme { start: number; end: number; text: string; quoted: boolean; }

const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;
function quoteAt(query: string, index: number): string | undefined {
  const ch = query[index]!;
  // An apostrophe after a word belongs to a contraction/possessive, not a
  // wrapper whose next apostrophe could swallow unrelated names and paths.
  if (ch === "'" && index > 0 && WORD_CHARACTER.test(query[index - 1]!)) return undefined;
  return QUOTES[ch];
}

function lex(query: string): Lexeme[] {
  const result: Lexeme[] = [];
  let i = 0;
  while (i < query.length) {
    if (BREAK.test(query[i]!)) { i++; continue; }
    const start = i;
    const close = quoteAt(query, i);
    if (close) {
      let j = i + 1;
      while (j < query.length) {
        if (query[j] === close) {
          // A quoted phrase may itself contain a contraction: 'don't wait'.
          const internalApostrophe = close === "'" && WORD_CHARACTER.test(query[j - 1] ?? '')
            && WORD_CHARACTER.test(query[j + 1] ?? '');
          if (!internalApostrophe) break;
        }
        j++;
      }
      if (j < query.length) {
        result.push({ start, end: j + 1, text: query.slice(i + 1, j), quoted: true });
        i = j + 1; continue;
      }
      i++; // An unclosed wrapper is punctuation, not a claim of explicit intent.
      continue;
    }
    while (i < query.length && !BREAK.test(query[i]!) && !quoteAt(query, i)) i++;
    if (i > start) result.push({ start, end: i, text: query.slice(start, i), quoted: false });
  }
  return result;
}

/** Keep path syntax intact; resolution against indexed paths remains the detector. */
function pathLike(text: string): boolean {
  return /[/\\]/.test(text) || FILE_TAIL.test(text.replace(/[)'"`\].]+$/, ''));
}
function erlangName(text: string): string {
  // Query field prefixes are not module qualifiers. Match the qualified
  // spelling accepted by normalizeQuerySpelling even when no arity is given
  // (Erlang mod:fn and Lua table:method), without touching C++ or paths.
  if (/^(?:kind|lang|language|path|name):/.test(text)) return text;
  return text.replace(/^([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*)\/\d+$/, '$1.$2')
    .replace(/^([A-Za-z_$][\w$]*)\/\d+$/, '$1')
    .replace(/^([a-z_$][\w$]*):([A-Za-z_$][\w$]*)$/, '$1.$2');
}
function precise(text: string): boolean {
  return /[._$]|::/.test(text) || /[a-z][A-Z]/.test(text) || /^[A-Z]/.test(text);
}

function selectNames(mentions: QueryMention[], limit: number, excludedSpans: ReadonlySet<string> = new Set()): Pick<ExploreQueryIntent, 'symbolTokens' | 'searchSymbols' | 'omitted'> {
  const omitted: QueryOmission[] = [];
  const candidates = mentions.filter(m => m.kind === 'symbol' && !excludedSpans.has(`${m.start}:${m.end}`));
  // Deduplicate in first-appearance order. Wrapping, identifier shape, script
  // and surrounding prose never move a later name ahead of an earlier one.
  const unique = new Map<string, QueryMention>();
  for (const mention of candidates) {
    if (unique.has(mention.normalized)) omitted.push({ normalized: mention.normalized, reason: 'duplicate' });
    else unique.set(mention.normalized, mention);
  }
  const symbolTokens: string[] = [], selected = new Set<string>();
  for (const mention of unique.values()) {
    if (symbolTokens.length >= limit) {
      omitted.push({ normalized: mention.normalized, reason: 'named-token-limit' });
      continue;
    }
    selected.add(mention.normalized); symbolTokens.push(mention.normalized);
  }
  for (const mention of candidates) mention.selected = selected.has(mention.normalized);
  // Preserve the existing wider lexical candidate channel independently of
  // named-target capacity; no natural-language intent label filters names.
  const searchSymbols = [...new Set(candidates.filter(m => m.quoted || precise(m.normalized))
    .map(m => m.normalized))].slice(0, 64);
  return { symbolTokens, searchSymbols, omitted };
}

/** Consume resolved path spans while retaining original offsets and name order. */
export function consumeQueryPaths(intent: ExploreQueryIntent, consumedPathTokens: readonly string[]): ExploreQueryIntent {
  if (!consumedPathTokens.length) return intent;
  const consumed = new Set([...intent.omitted.filter(o => o.reason === 'path-consumed').map(o => o.normalized), ...consumedPathTokens]);
  const spans = new Set(intent.mentions.filter(m => consumed.has(m.normalized) || consumed.has(m.raw))
    .map(m => `${m.start}:${m.end}`));
  if (!spans.size) return intent;
  const mentions = intent.mentions.map(m => ({ ...m, selected: false }));
  const selection = selectNames(mentions, intent.namedTokenLimit, spans);
  const chars = intent.searchQuery.split('');
  for (const m of mentions) if (spans.has(`${m.start}:${m.end}`)) {
    for (let i = m.start; i < m.end; i++) chars[i] = ' ';
  }
  const pathTokens = intent.pathTokens.filter(t => !consumed.has(t));
  return { ...intent, searchQuery: chars.join(''), pathQuery: pathTokens.join(' '), pathTokens, mentions, ...selection,
    omitted: [...intent.omitted.filter(o => o.reason === 'mention-limit'), ...selection.omitted,
      ...[...consumed].map(normalized => ({ normalized, reason: 'path-consumed' as const }))] };
}

export function parseExploreQuery(raw: string, options: { maxNamedTokens?: number } = {}): ExploreQueryIntent {
  const limit = options.maxNamedTokens ?? 16;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new RangeError('Named query token limit must be between 1 and 64');
  const tokens = lex(raw);
  const mentions: QueryMention[] = [];
  const omitted: QueryOmission[] = [];
  for (const token of tokens) {
    if (mentions.length >= MAX_MENTIONS) { omitted.push({ normalized: token.text.slice(0, 120), reason: 'mention-limit' }); break; }
    const text = erlangName(token.text);
    const isPath = text === token.text && pathLike(text);
    if (isPath) mentions.push({ start: token.start, end: token.end, raw: raw.slice(token.start, token.end), normalized: text,
      kind: 'path', quoted: token.quoted, selected: false });
    // A bare source basename historically names its stem too (auth.ts -> auth).
    // Slashed paths do not mint names from their bracketed/directory fragments.
    if (isPath && /[/\\]/.test(text)) continue;
    const base = text.replace(SOURCE_EXTENSION, '');
    const pieces = base.split(/[\s,;!?，。；：、！？()[\]{}]+/).flatMap(splitAtCjkSwitches);
    for (const piece of pieces) {
      if (mentions.length >= MAX_MENTIONS) break;
      const normalized = piece.replace(/^[<]+/, '').replace(/[>.,:]+$/, '');
      if (!normalized) continue;
      const named = isQueryNameToken(normalized);
      const wholeQuotedName = token.quoted && named && pieces.length === 1;
      const m: QueryMention = { start: token.start, end: token.end, raw: raw.slice(token.start, token.end), normalized,
        kind: named ? 'symbol' : 'prose', quoted: wholeQuotedName, selected: false };
      mentions.push(m);
      if (mentions.length >= MAX_MENTIONS) break;
    }
  }
  const selection = selectNames(mentions, limit);
  const pathTokens = tokens.flatMap(t => t.quoted && !pathLike(t.text) ? t.text.split(/\s+/).filter(Boolean) : [t.text]);
  return { raw, searchQuery: raw, pathQuery: pathTokens.join(' '), pathTokens, mentions, namedTokenLimit: limit, ...selection, omitted: [...omitted, ...selection.omitted] };
}
