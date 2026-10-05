/**
 * Search Query Utilities
 *
 * Shared module for search term extraction and scoring.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Node } from '../types';

/** Path-comparison key ordered lexicographically from strongest to weakest. */
export interface PathSimilarityScore {
  /** One normalized path/directory is a complete suffix of the other. */
  completeSuffixMatch: number;
  /** Longest matching tail across file/file, directory/path, and sibling-file views. */
  commonSuffixSegments: number;
  /** Number of distinct candidate-directory segments also present in the hint. */
  sharedDirectorySegments: number;
}

/** Normalize user and indexed paths without requiring either one to exist. */
export function normalizePathForComparison(raw: string): string {
  const normalized = raw.trim().replace(/\\/g, '/').toLowerCase().replace(/^[a-z]:/, '');
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

/** Existing hard-substring semantics, with shared normalization. */
export function pathContainsHint(filePath: string, pathHint: string): boolean {
  const candidate = normalizePathForComparison(filePath);
  const hint = normalizePathForComparison(pathHint);
  return hint.length > 0 && candidate.includes(hint);
}

function commonSuffixLength(left: string[], right: string[]): number {
  let count = 0;
  while (
    count < left.length &&
    count < right.length &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count++;
  }
  return count;
}

function sharedDistinctSegments(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  return new Set(left.filter((segment) => rightSet.has(segment))).size;
}

/**
 * Compare two paths by structure rather than whole-string edit distance.
 *
 * Both full paths and their parent directories participate so a directory hint
 * (`module/rcm`) can rank a file below it, and sibling `.h` / `.cpp` files still
 * receive useful proximity. Absolute-vs-project-relative paths naturally align
 * on their common suffix after normalization.
 */
export function scorePathSimilarity(filePath: string, pathHint: string): PathSimilarityScore {
  const candidate = normalizePathForComparison(filePath).split('/').filter(Boolean);
  const hint = normalizePathForComparison(pathHint).split('/').filter(Boolean);
  if (candidate.length === 0 || hint.length === 0) {
    return { completeSuffixMatch: 0, commonSuffixSegments: 0, sharedDirectorySegments: 0 };
  }

  const candidateDirectory = candidate.slice(0, -1);
  const hintDirectory = hint.slice(0, -1);
  const pairs: Array<[string[], string[]]> = [
    [candidate, hint],
    [candidateDirectory, hint],
    [candidate, hintDirectory],
    [candidateDirectory, hintDirectory],
  ];
  const suffixLengths = pairs.map(([left, right]) => commonSuffixLength(left, right));
  const commonSuffixSegments = Math.max(...suffixLengths);
  const completeSuffixMatch = Number(pairs.some(([left, right], index) => {
    const smallerLength = Math.min(left.length, right.length);
    return smallerLength > 0 && suffixLengths[index] === smallerLength;
  }));
  const sharedDirectorySegments = Math.max(
    sharedDistinctSegments(candidateDirectory, hint),
    sharedDistinctSegments(candidateDirectory, hintDirectory),
  );
  return { completeSuffixMatch, commonSuffixSegments, sharedDirectorySegments };
}

/** Negative means `left` is more similar, matching Array.sort comparators. */
export function comparePathSimilarityScores(
  leftScore: PathSimilarityScore,
  rightScore: PathSimilarityScore,
): number {
  return rightScore.completeSuffixMatch - leftScore.completeSuffixMatch ||
    rightScore.commonSuffixSegments - leftScore.commonSuffixSegments ||
    rightScore.sharedDirectorySegments - leftScore.sharedDirectorySegments;
}

/** Negative means `left` is more similar, matching Array.sort comparators. */
export function comparePathSimilarity(left: string, right: string, pathHint: string): number {
  return comparePathSimilarityScores(
    scorePathSimilarity(left, pathHint),
    scorePathSimilarity(right, pathHint),
  );
}

/** Normalize a name to a comparable token: lowercase, alphanumerics only. */
export function normalizeNameToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Tokens that name the PROJECT as a whole — its `go.mod` module, `package.json`
 * name, or repo root directory — rather than any specific symbol. A user
 * naturally puts the project name in a query as context ("MyApp backend
 * routes"), but it carries no discriminative signal: when it's also a substring
 * of a symbol or path on one stack (a `MyAppFrontend/` dir, a `MyAppApp` class)
 * it lexically inflates that stack and buries the rest (#720).
 *
 * Returned normalized (lowercase, alphanumerics only) so a query word can be
 * compared by its normalized form. Only names ≥5 chars are kept — short ones
 * (`api`, `app`, `core`, `web`) collide with real query terms too often to
 * safely down-weight.
 */
export function deriveProjectNameTokens(projectRoot: string): Set<string> {
  const tokens = new Set<string>();
  const add = (raw: string | undefined | null): void => {
    if (!raw) return;
    const norm = normalizeNameToken(raw);
    if (norm.length >= 5) tokens.add(norm);
  };

  // go.mod module last segment (the most reliable signal for Go repos).
  try {
    const gomod = fs.readFileSync(path.join(projectRoot, 'go.mod'), 'utf-8');
    const m = gomod.match(/^\s*module\s+(\S+)/m);
    if (m && m[1]) add(m[1].split('/').pop());
  } catch { /* no go.mod */ }

  // package.json name (strip an `@scope/` prefix).
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    if (typeof pkg.name === 'string') add(pkg.name.replace(/^@[^/]+\//, ''));
  } catch { /* no / invalid package.json */ }

  // Repo root directory name — a fallback when neither manifest names the project.
  add(path.basename(path.resolve(projectRoot)));

  return tokens;
}

/**
 * Common stop words to filter from search queries.
 * Includes generic English + code-specific noise words.
 */
export const STOP_WORDS = new Set([
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'that', 'this', 'are', 'was',
  'be', 'has', 'had', 'have', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'not', 'no', 'all', 'each',
  'every', 'how', 'what', 'where', 'when', 'who', 'which', 'why',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
  'show', 'give', 'tell',
  'been', 'done', 'made', 'used', 'using', 'work', 'works', 'found',
  'also', 'into', 'then', 'than', 'just', 'more', 'some', 'such',
  'over', 'only', 'out', 'its', 'so', 'up', 'as', 'if',
  'look', 'need', 'needs', 'want', 'happen', 'happens',
  'affect', 'affected', 'break', 'breaks', 'failing',
  'implemented', 'implement',
  // Code-specific noise (avoid filtering common symbol names like get/set/add/build/find/list)
  'code', 'file', 'files', 'function', 'method', 'class', 'type',
  'fix', 'bug', 'called',
]);

/**
 * Generate stem variants of a search term by removing common English suffixes.
 * Used for FTS query expansion so "caching" also finds "cache", "eviction" finds "evict", etc.
 * Stems are used as PREFIX matches in FTS, so they don't need to be perfect English words.
 */
export function getStemVariants(term: string): string[] {
  const variants = new Set<string>();
  const t = term.toLowerCase();

  // -ing: caching→cach/cache, handling→handl/handle, running→run
  if (t.endsWith('ing') && t.length > 5) {
    const base = t.slice(0, -3);
    variants.add(base);
    variants.add(base + 'e');
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      variants.add(base.slice(0, -1));
    }
  }

  // -tion/-sion: eviction→evict, expression→express
  if ((t.endsWith('tion') || t.endsWith('sion')) && t.length > 5) {
    variants.add(t.slice(0, -3));
  }

  // -ment: management→manage
  if (t.endsWith('ment') && t.length > 6) {
    variants.add(t.slice(0, -4));
  }

  // -ies: entries→entry
  if (t.endsWith('ies') && t.length > 4) {
    variants.add(t.slice(0, -3) + 'y');
  }
  // -es: processes→process, classes→class
  else if (t.endsWith('es') && t.length > 4) {
    variants.add(t.slice(0, -2));
  }
  // -s: errors→error (skip -ss endings like "class")
  else if (t.endsWith('s') && !t.endsWith('ss') && t.length > 4) {
    variants.add(t.slice(0, -1));
  }

  // -ed: handled→handle, propagated→propagate, carried→carry
  if (t.endsWith('ed') && !t.endsWith('eed') && t.length > 4) {
    variants.add(t.slice(0, -1));
    variants.add(t.slice(0, -2));
    if (t.endsWith('ied') && t.length > 5) {
      variants.add(t.slice(0, -3) + 'y');
    }
  }

  // -er: builder→build/builde, handler→handl/handle, getter→get
  if (t.endsWith('er') && t.length > 4) {
    const base = t.slice(0, -2);
    variants.add(base);
    variants.add(base + 'e');
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      variants.add(base.slice(0, -1));
    }
  }

  return [...variants].filter(v => v.length >= 3 && v !== t);
}

/**
 * Extract meaningful search terms from a natural language query.
 * Splits camelCase, PascalCase, snake_case, SCREAMING_SNAKE, and dot.notation
 * into individual tokens before filtering.
 *
 * Preserves original compound identifiers (e.g., "scrapeLoop") alongside
 * their split parts so that FTS can match both the full symbol name and
 * individual words within it.
 *
 * Also generates stem variants (e.g., "caching"→"cache", "eviction"→"evict")
 * so FTS prefix matching can find related code symbols.
 */
export function extractSearchTerms(query: string, options?: { stems?: boolean }): string[] {
  const includeStems = options?.stems !== false;
  const tokens = new Set<string>();

  // First, extract and preserve compound identifiers before splitting
  // CamelCase: scrapeLoop, UserService, getCallGraph
  const compoundPattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]*)+)\b/g;
  let match;
  while ((match = compoundPattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) {
      tokens.add(match[1].toLowerCase()); // preserve full compound: "scrapeloop"
    }
  }

  // snake_case: scrape_loop, user_service
  const snakePattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)\b/g;
  while ((match = snakePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) {
      tokens.add(match[1].toLowerCase());
    }
  }

  // Split camelCase / PascalCase: "getUserName" → "get User Name"
  const camelSplit = query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  // Replace underscores and dots with spaces (snake_case, dot.notation)
  const normalised = camelSplit.replace(/[_.]+/g, ' ');

  // Split on any non-alphanumeric character
  const words = normalised.split(/[^a-zA-Z0-9]+/).filter(Boolean);

  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower.length < 3) continue;
    if (STOP_WORDS.has(lower)) continue;
    tokens.add(lower);
  }

  // Generate stem variants for broader FTS matching.
  // "caching" → "cache" finds CacheBuilder; "eviction" → "evict" finds evictEntries.
  // Also enables co-occurrence dampening by increasing term count above 1.
  // Stems are skipped when scoring path relevance (stems inflate path scores).
  if (includeStems) {
    const stems = new Set<string>();
    for (const token of tokens) {
      for (const variant of getStemVariants(token)) {
        if (!tokens.has(variant) && !STOP_WORDS.has(variant)) {
          stems.add(variant);
        }
      }
    }
    for (const stem of stems) {
      tokens.add(stem);
    }
  }

  return [...tokens];
}

/**
 * Score path relevance to a query
 * Higher score = more relevant path
 */
export function scorePathRelevance(
  filePath: string,
  query: string,
  projectNameTokens?: Set<string>,
): number {
  const pathLower = filePath.toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();
  const dirName = path.dirname(filePath).toLowerCase();
  let score = 0;

  // Score per original query WORD, not per sub-token. A single PascalCase word
  // splits into many sub-tokens (a project name "SuperBizAgent" →
  // superbizagent / super / biz / agent) that all match the SAME path segment,
  // so summing per sub-token boosted that path 4× for one concept — enough to
  // bury the rest of the query's stack (#720). A word matches a path level if
  // ANY of its sub-tokens do, and counts ONCE; distinct words still each add.
  // Split the ORIGINAL-case query into words; extractSearchTerms does the
  // camelCase/snake split per word (so `getUserName` still matches a
  // `get_user_name` path) — we just attribute each word's matches once.
  const allWords = query.split(/\s+/).filter((w) => w.length > 0);
  if (allWords.length === 0) return 0;

  // A query word that just names the PROJECT (its go.mod / package.json / repo
  // name) carries no discriminative path signal — drop it so the rest of the
  // query decides the ranking, instead of every file under a `<ProjectName>…/`
  // tree winning on the project name alone (#720). Only when OTHER words remain,
  // so a bare project-name query still scores on its path.
  const words =
    projectNameTokens && projectNameTokens.size > 0
      ? allWords.filter((w) => !projectNameTokens.has(normalizeNameToken(w)))
      : allWords;
  const scored = words.length > 0 ? words : allWords;

  for (const word of scored) {
    // Use base terms only — stem variants inflate path scores by generating
    // many near-duplicate terms that all match the same path segments.
    const subtokens = extractSearchTerms(word, { stems: false });
    if (subtokens.length === 0) continue;
    // Exact filename match (strongest)
    if (subtokens.some((t) => fileName.includes(t))) score += 10;
    // Directory match
    if (subtokens.some((t) => dirName.includes(t))) score += 5;
    // General path match
    else if (subtokens.some((t) => pathLower.includes(t))) score += 3;
  }

  // Deprioritize test files unless the query is explicitly about tests
  const queryLower = query.toLowerCase();
  const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');
  if (!isTestQuery && isTestFile(filePath)) {
    score -= 15;
  }

  return score;
}

/**
 * Check if a file path looks like a test file
 */
export function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const fileName = path.basename(filePath);   // original case — needed for camelCase boundaries
  const lowerName = fileName.toLowerCase();

  // --- Filename patterns ---
  if (
    lowerName.startsWith('test_') ||                              // python: test_foo.py
    lowerName.startsWith('test.') ||
    // separator-delimited: foo_test.go, foo.test.ts, foo-spec.rb, bar_spec.py
    /[._-](test|tests|spec|specs)\.[a-z0-9]+$/.test(lowerName) ||
    // CamelCase suffix (Java/Kotlin/Swift/C#/Scala): FooTest.kt, BarTests.swift,
    // BazSpec.scala, QuxTestCase.java. Capital-led so "latest.kt"/"manifest.kt"
    // (lowercase "test") are NOT matched.
    /(?:Test|Tests|TestCase|Tester|Spec|Specs)\.[A-Za-z0-9]+$/.test(fileName)
  ) {
    return true;
  }

  // --- Directory patterns ---
  if (
    lower.includes('/tests/') || lower.includes('/test/') ||
    lower.includes('/__tests__/') || lower.includes('/spec/') ||
    lower.includes('/specs/') || lower.includes('/testlib/') ||
    lower.includes('/testing/') ||
    lower.startsWith('test/') || lower.startsWith('tests/') ||
    lower.startsWith('spec/') || lower.startsWith('specs/') ||
    // CamelCase test source-set dirs (Kotlin Multiplatform / Gradle / Xcode):
    // jvmTest/, commonTest/, androidTest/, iosTest/, integrationTest/. Capital-led
    // so "latest/" / "manifest/" are not matched.
    /(?:^|\/)[A-Za-z0-9]*(?:Test|Tests|Spec)\//.test(filePath)
  ) {
    return true;
  }

  // Non-production directories: examples, samples, benchmarks, fixtures, demos.
  // Check both mid-path (/integration/) and start-of-path (integration/) since
  // file paths may be stored as relative paths without a leading slash.
  return matchesNonProductionDir(lower);
}

/**
 * Check if a path is in a non-production directory (integration, sample, example, etc.)
 * Handles both absolute paths (/foo/integration/bar) and relative paths (integration/bar).
 */
function matchesNonProductionDir(lowerPath: string): boolean {
  const dirs = [
    'integration', 'sample', 'samples', 'example', 'examples',
    'fixture', 'fixtures', 'benchmark', 'benchmarks', 'demo', 'demos',
  ];
  for (const dir of dirs) {
    if (lowerPath.includes('/' + dir + '/') || lowerPath.startsWith(dir + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * Bonus when a node's name matches the search query.
 * Exact matches get the largest boost; prefix matches get smaller boosts.
 * Multi-word queries also check individual term matches against the name.
 */
export function nameMatchBonus(nodeName: string, query: string): number {
  const nameLower = nodeName.toLowerCase();

  // Split query into word-level terms (handles "CacheBuilder build" → ["cache","builder","build"])
  const rawTerms = query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_.\-]+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 2);

  // Also keep original space-separated tokens for exact-term matching
  const queryTokens = query.split(/\s+/).map(t => t.toLowerCase()).filter(t => t.length >= 2);

  // Full query as a single token (for compound identifiers like "CacheBuilder")
  const queryLower = query.replace(/[\s]+/g, '').toLowerCase();

  // Exact match: query exactly equals the node name
  if (nameLower === queryLower) return 80;

  // Exact match on a query token: "CacheBuilder build" and node name is "build"
  if (queryTokens.length > 1 && queryTokens.includes(nameLower)) return 60;

  // Name starts with query — scale by length ratio so "Pod"→"Pod" (exact, handled above)
  // scores much higher than "Pod"→"PodGCControllerOptions" (ratio 0.125).
  if (nameLower.startsWith(queryLower)) {
    const ratio = queryLower.length / nameLower.length;
    return Math.round(10 + 30 * ratio);
  }

  // All camelCase-split terms appear in the name
  if (rawTerms.length > 1) {
    const allMatch = rawTerms.every(t => nameLower.includes(t));
    if (allMatch) return 15;
  }

  // Name contains the full query as substring
  if (nameLower.includes(queryLower)) return 10;

  return 0;
}

/**
 * Kind-based bonus for search ranking
 * Functions and classes are typically more relevant than variables/imports
 */
export function kindBonus(kind: Node['kind']): number {
  const bonuses: Record<string, number> = {
    function: 10,
    method: 10,
    class: 8,
    interface: 9,
    type_alias: 6,
    struct: 6,
    trait: 9,
    enum: 5,
    component: 8,
    route: 9,
    module: 4,
    property: 3,
    field: 3,
    variable: 2,
    constant: 3,
    import: 1,
    export: 1,
    parameter: 0,
    namespace: 4,
    file: 0,
    protocol: 9,
    enum_member: 3,
    macro: 5,
  };
  return bonuses[kind] ?? 0;
}

/**
 * Whether a query token looks like a code identifier the user deliberately typed
 * (camelCase / PascalCase-with-internal-caps / snake_case / has a digit) rather
 * than a plain dictionary word ("flat", "object", "screen").
 *
 * Used to decide whether an EXACT name match earns the "the user named this
 * symbol" exemption from single-term dampening. A common English word that
 * happens to exact-match an unrelated symbol — the query "flat object" matching
 * a constant named `FLAT` — must NOT get that exemption, or the +exact-name
 * bonus floats it to the top of a prose query on its own.
 *
 * Classifies the token AS THE USER TYPED IT, not the matched symbol's name:
 * "flat" (lowercase, descriptive) is non-distinctive even though it matches
 * `FLAT`. A leading-capital-only word ("Screen", "Zustand") is also treated as
 * a plain word — sentence-start capitalization and proper nouns aren't reliable
 * identifier signals.
 */
export function isDistinctiveIdentifier(token: string): boolean {
  if (!token) return false;
  // snake_case / SCREAMING_SNAKE, or an embedded digit → a deliberate identifier.
  if (/[_0-9]/.test(token)) return true;
  // An uppercase letter anywhere AFTER the first char → a camelCase/PascalCase
  // boundary (setLastEmail, OrgUserStore) or an acronym (REST, HTTP).
  if (/[A-Z]/.test(token.slice(1))) return true;
  return false;
}

/**
 * Detect whether a query is natural language / non-symbol content rather
 * than a single symbol name.
 *
 * Fast-fail checks (before the FTS→LIKE→fuzzy chain):
 *   - Chinese characters (NEVER in code identifiers)
 *   - Hex values (0xABCD) — addresses, error codes, magic numbers
 *   - Pure numeric strings
 *   - Question marks (English or Chinese)
 *   - Whitespace — symbol names never contain spaces
 *
 * Fast-failing lets the agent correct course before wasting time on
 * a query that will produce zero or irrelevant results.
 */
export function isNaturalLanguageQuery(query: string): { isNatural: boolean; reason?: string } {
  const trimmed = query.trim();

  // Chinese characters — never in code identifiers
  if (/[\u4e00-\u9fff]/.test(trimmed)) {
    return { isNatural: true, reason: '查询中包含中文字符' };
  }

  // Hex values like 0x4237F001 — addresses, error codes, magic numbers.
  // No codebase uses a bare hex literal as a symbol name.
  if (/^0x[0-9A-Fa-f]+$/.test(trimmed)) {
    return {
      isNatural: true,
      reason: '查询是十六进制数值（如 0x4237F001），不是符号名。请搜索该值的常量/宏定义名',
    };
  }

  // Pure numeric — error codes, line numbers, etc. Not a symbol name.
  if (/^\d+$/.test(trimmed)) {
    return { isNatural: true, reason: '查询是纯数字，不是符号名' };
  }

  // Question marks — clearly a natural-language question
  if (/[?？]/.test(trimmed)) {
    return { isNatural: true, reason: '查询包含问号，疑似自然语言问题。请提取关键符号名搜索' };
  }

  // Whitespace — symbol names never contain spaces. "ADD TRMDBG" and
  // "how does auth work" are rejected. Qualified symbols such as
  // `RepAlloc.Rsp` contain no whitespace and are accepted.
  if (/\s/.test(trimmed)) {
    return {
      isNatural: true,
      reason: '查询包含空格，不是单个符号名。请提取关键符号名搜索（如 "TRMDBG"、"RepAlloc"）',
    };
  }

  return { isNatural: false };
}
