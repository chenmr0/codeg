/**
 * MCP Tool Definitions
 *
 * Defines the tools exposed by the CodeGraph MCP server.
 */

import type CodeGraph from '../index';
import { AsyncLocalStorage } from 'async_hooks';
import { findNearestCodeGraphRoot } from '../directory';
// Lazy-load the heavy CodeGraph chain off the MCP startup path — see the same
// helper in engine.ts. ToolHandler must load to answer tools/list (static
// schemas), but it must NOT drag in sqlite/query layers before the daemon binds;
// CodeGraph is pulled in only when a tool actually opens a project. require() is
// sync + cached (CommonJS build).
const loadCodeGraph = (): typeof import('../index').default =>
  (require('../index') as typeof import('../index')).default;
import {
  detectWorktreeIndexMismatch,
  worktreeMismatchWarning,
  worktreeMismatchNotice,
  type WorktreeIndexMismatch,
} from '../sync/worktree';
import type { PendingFile } from '../sync';
import type { Node, Edge, SearchResult, Subgraph, NodeKind } from '../types';
import { NODE_KINDS } from '../types';
import {
  comparePathSimilarity,
  comparePathSimilarityScores,
  isDistinctiveIdentifier,
  isNaturalLanguageQuery,
  isTestFile,
  normalizeNameToken,
  normalizePathForComparison,
  pathContainsHint,
  scorePathSimilarity,
} from '../search/query-utils';
import {
  existsSync,
  readFileSync,
} from 'fs';
import { clamp, validatePathWithinRoot, validateProjectPath, isConfigLeafNode, CONFIG_LEAF_LANGUAGES, canonicalFilePath } from '../utils';
import { isGeneratedFile } from '../extraction/generated-detection';
import {
  cppCallableOwnersMatch,
  cppParameterKey,
  cppParameterKeysMatch,
} from '../resolution/cpp-signature';
import { resolve as resolvePath } from 'path';
import {
  boundNumberedSource,
  CONTAINER_NODE_KINDS,
  displaySymbol,
  numberSourceLines,
  SYMBOL_SOURCE_MAX_CHARS,
  synthEdgeNote,
} from './node-helpers';
import {
  formatRawSourceEvidence,
  scanRawSourceEvidence,
  type RawEvidenceSpec,
} from './raw-source-evidence';
import {
  formatDefinitionLocation,
  formatRelationshipSites,
  mergeDirectRelationshipGroups,
  sortRelatedSymbolRelationships,
  type RelatedSymbolRelationships,
} from '../relationship-output';
import { formatSourceRange } from '../source-location';

/** Maximum output length to prevent context bloat (characters) */
const MAX_OUTPUT_LENGTH = 15000;

/**
 * Startup catch-up runs in the background by default. Queries use the current
 * index with a freshness warning; callers can explicitly opt into a bounded
 * wait through CODEGRAPH_MCP_CATCHUP_BUDGET_MS.
 */
export const MCP_CATCH_UP_DEFAULT_BUDGET_MS = 0;
const MCP_CATCH_UP_MAX_BUDGET_MS = 60_000;

/** Resolve the optional startup wait; invalid input retains the nonblocking default. */
export function resolveMcpCatchUpBudgetMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return MCP_CATCH_UP_DEFAULT_BUDGET_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return MCP_CATCH_UP_DEFAULT_BUDGET_MS;
  }
  if (parsed < 0 || parsed > MCP_CATCH_UP_MAX_BUDGET_MS) {
    return MCP_CATCH_UP_DEFAULT_BUDGET_MS;
  }
  return parsed;
}

/** Maximum source lines returned by one MCP codegraph_node file window. */
const MCP_NODE_MAX_FILE_WINDOW_LINES = 500;

/** Default/maximum number of entries in a file structural outline. */
const MCP_NODE_DEFAULT_OUTLINE_SYMBOLS = 60;
const MCP_NODE_MAX_OUTLINE_SYMBOLS = 80;

/** A non-selective outline filter should not dump most of a large file. */
const MCP_NODE_BROAD_OUTLINE_MIN_MATCHES = 20;
const MCP_NODE_BROAD_OUTLINE_MATCH_RATIO = 0.5;
const MCP_NODE_BROAD_OUTLINE_RESULT_LIMIT = 12;

/** A named container should stay materially smaller than a file outline. */
const MCP_NODE_CONTAINER_OUTLINE_SYMBOLS = 40;

/** Narrow multi-symbol context budgets; kept below common inline-result caps. */
const MCP_CONTEXT_MAX_TARGETS = 8;
const MCP_CONTEXT_MAX_OUTPUT_CHARS = 20_000;
const MCP_CONTEXT_MAX_CHARS_PER_TARGET = 8_000;
const MCP_CONTEXT_MAX_MEMBERS = 32;
const MCP_CONTEXT_MAX_OUTLINE_SYMBOLS_PER_FILE = 24;
const MCP_CONTEXT_MAX_OUTLINE_SYMBOLS_TOTAL = 80;
const MCP_CONTEXT_MAX_FILE_WINDOW_LINES = 500;
const MCP_CONTEXT_MAX_TEXT_CONTEXT_LINES = 60;
const MCP_CONTEXT_MAX_TEXT_MATCHES = 3;
const MCP_CONTEXT_BROAD_FILE_TARGETS = 3;
const MCP_CONTEXT_BROAD_FILE_LINES = 360;
const MCP_CONTEXT_MAX_FILE_SYMBOLS = 32;
const MCP_CONTEXT_MAX_FILE_TEXTS = 8;
const MCP_CONTEXT_MAX_EXPECTED_MISSING = 8;
const MCP_CONTEXT_MEMBER_NEIGHBOR_LINES = 2;

/** Symbol search can resolve several exact lookups and one raw fallback scan. */
const MCP_SEARCH_MAX_QUERIES = 8;

/** Keep synchronous overload grouping bounded for ubiquitous names such as process. */
const MCP_RELATIONSHIP_MAX_GROUPING_CANDIDATES = 64;
const MCP_RELATIONSHIP_MAX_FALLBACK_COMPARISONS = 50_000;
const MCP_RELATIONSHIP_SITE_LIMIT_PER_NODE = 5;

/** Literal text search is intentionally narrow and source-only. */
const MCP_TEXT_SEARCH_MAX_QUERIES = 8;
const MCP_TEXT_SEARCH_MAX_MATCHES_PER_QUERY = 20;
const MCP_TEXT_SEARCH_MAX_CONTEXT_LINES = 2;
const MCP_TEXT_SEARCH_MAX_SCANNED_BYTES = 64 * 1024 * 1024;
const MCP_TEXT_SEARCH_MAX_SYMBOL_RECOVERIES = 2;
const MCP_TEXT_SEARCH_MAX_SYMBOL_RECOVERY_CHARS = 4_000;

/**
 * Maximum length for free-form string inputs (query, task, symbol).
 * Bounds memory and CPU when a buggy or hostile MCP client sends a
 * huge payload — without this an attacker could ship a 100MB string
 * and force a full FTS5 scan / OOM the server. 10 000 characters is
 * far beyond any realistic legitimate query.
 */
const MAX_INPUT_LENGTH = 10_000;

/**
 * Maximum length for path-like string inputs (projectPath, path
 * filter, glob pattern). Paths beyond a few thousand chars are
 * never legitimate and signal abuse or a bug upstream.
 */
const MAX_PATH_LENGTH = 4_096;

/**
 * Calculate the recommended number of codegraph_explore calls based on project size.
 * Larger codebases need more exploration calls to cover their surface area,
 * but smaller ones should use fewer to avoid unnecessary overhead.
 */
export function getExploreBudget(fileCount: number): number {
  if (fileCount < 500) return 1;
  if (fileCount < 5000) return 2;
  if (fileCount < 15000) return 3;
  if (fileCount < 25000) return 4;
  return 5;
}

/**
 * Adaptive output budget for `codegraph_explore`, scaled to project size.
 *
 * Smaller codebases get a tighter total cap, fewer default files, smaller
 * per-file cap, and tighter clustering — so a focused query on a 100-file
 * project doesn't dump a whole file's worth of source into the agent's
 * context. Larger codebases keep the generous defaults because the
 * agent's native discovery cost (grep + find + many Reads) genuinely
 * dwarfs a fat explore call at that scale.
 *
 * Meta-text (relationships map, "additional relevant files" list,
 * completeness signal, budget note) is gated off for tiny projects
 * where one rich call is the whole story and the extra prose is just
 * overhead.
 *
 * Tier breakpoints mirror `getExploreBudget` so a project sits in the
 * same tier across both knobs.
 */
export interface ExploreOutputBudget {
  /** Hard cap on total output characters. */
  maxOutputChars: number;
  /** Default `maxFiles` when the caller didn't specify one. */
  defaultMaxFiles: number;
  /** Cap on contiguous source returned per file (across all its clusters). */
  maxCharsPerFile: number;
  /** Cluster gap threshold in lines — tighter clustering on small projects. */
  gapThreshold: number;
  /** Max symbols listed in the per-file header (`#### path — sym(kind), ...`). */
  maxSymbolsInFileHeader: number;
  /** Max edges shown per relationship kind in the Relationships section. */
  maxEdgesPerRelationshipKind: number;
  /** Include the "Relationships" section. */
  includeRelationships: boolean;
  /** Include the "Additional relevant files (not shown)" trailing list. */
  includeAdditionalFiles: boolean;
  /** Include the "Complete source code is included above…" reminder. */
  includeCompletenessSignal: boolean;
  /** Include the explore-budget reminder at the end. */
  includeBudgetNote: boolean;
  /**
   * Hard-drop test/spec/icon/i18n files from the relevant-file set unless
   * the query itself mentions tests. Today they're only deprioritized in
   * the sort, which on tiny repos still lets one slip into the top N (e.g.
   * cobra's `command_test.go` displaced `args.go` and contributed ~10KB of
   * pure noise to "How does cobra parse commands?"). Off by default; on
   * for the very-tiny tier where one slip dominates the budget.
   */
  excludeLowValueFiles: boolean;
}

export function getExploreOutputBudget(fileCount: number): ExploreOutputBudget {
  // Tiered budget, scaled to project size. The budget is a CEILING (relevance
  // still gates WHAT is included), and it MUST stay under the agent's INLINE
  // tool-result cap (~25K chars). Above that, the host externalizes the result
  // to a file the agent then Reads back — re-introducing a read AND the
  // cache-write cost — which is exactly what a 35K vscode explore did in the
  // n=4 README A/B. So even large repos cap at ~24K: the answer is the handful
  // of ~100-line flow windows the agent would have grep-located and read (it
  // natively reads ~6–9 files, median 100-line ranges), NOT a sprawl of 12
  // files. Concentration onto the flow emerges from this cap + the named-file-
  // first sort dropping peripheral files. Invariant: a larger tier must never
  // get a smaller `maxCharsPerFile` than a smaller tier.
  if (fileCount < 150) {
    return {
      // ITER3: revert iter2's aggressive body shrink (forced Read fallback —
      // the per-file 2.5K cap pushed the agent to Read instead of node).
      // Back to the iter1 shape (13K/4/3.8K) but keep the test-file
      // hard-exclude. The cost lever for this tier lives in steering the
      // agent to stop after 1-2 calls, not in this budget.
      maxOutputChars: 13000,
      defaultMaxFiles: 4,
      maxCharsPerFile: 3800,
      gapThreshold: 7,
      maxSymbolsInFileHeader: 5,
      maxEdgesPerRelationshipKind: 4,
      includeRelationships: false,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
      excludeLowValueFiles: true,
    };
  }
  if (fileCount < 500) {
    return {
      // ITER3: same revert/keep-filter pattern as <150.
      maxOutputChars: 18000,
      defaultMaxFiles: 5,
      maxCharsPerFile: 3800,
      gapThreshold: 8,
      maxSymbolsInFileHeader: 6,
      maxEdgesPerRelationshipKind: 6,
      includeRelationships: false,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
      excludeLowValueFiles: true,
    };
  }
  if (fileCount < 5000) {
    return {
      // ~150-line per-file window (the native read unit) × ~6 files, capped at
      // the ~24K inline ceiling so the response is never externalized. Per-file
      // stays ≥ the <500 tier (3800) — monotonic.
      maxOutputChars: 24000,
      defaultMaxFiles: 8,
      maxCharsPerFile: 6500,
      gapThreshold: 12,
      maxSymbolsInFileHeader: 10,
      maxEdgesPerRelationshipKind: 10,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
      excludeLowValueFiles: false,
    };
  }
  // Large + very-large repos: SAME ~24K inline ceiling (a bigger response just
  // externalizes — see vscode). More files indexed → more CALLS via
  // getExploreBudget, not a bigger single response. Per-file 7000 (≥ smaller
  // tiers) gives the central file a ~180-line orientation window.
  if (fileCount < 15000) {
    return {
      maxOutputChars: 24000,
      defaultMaxFiles: 8,
      maxCharsPerFile: 7000,
      gapThreshold: 15,
      maxSymbolsInFileHeader: 15,
      maxEdgesPerRelationshipKind: 15,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
      excludeLowValueFiles: false,
    };
  }
  return {
    maxOutputChars: 24000,
    defaultMaxFiles: 8,
    maxCharsPerFile: 7000,
    gapThreshold: 15,
    maxSymbolsInFileHeader: 15,
    maxEdgesPerRelationshipKind: 15,
    includeRelationships: true,
    includeAdditionalFiles: true,
    includeCompletenessSignal: true,
    includeBudgetNote: true,
    excludeLowValueFiles: false,
  };
}

/**
 * Whether `codegraph_explore` should prefix source lines with their line
 * numbers (cat -n style: `<num>\t<code>`).
 *
 * Line numbers let the agent cite `file:line` straight from the explore
 * payload instead of re-Reading the file just to find a line number — the
 * dominant residual cost on precise-tracing questions (#185 follow-up).
 *
 * Defaults ON. Set `CODEGRAPH_EXPLORE_LINENUMS=0` to disable (used by the
 * A/B harness to measure the payload-cost vs. read-savings tradeoff).
 */
function exploreLineNumbersEnabled(): boolean {
  return process.env.CODEGRAPH_EXPLORE_LINENUMS !== '0';
}

/**
 * Adaptive explore sizing (default ON). `codegraph_explore` skeletonizes OFF-SPINE
 * polymorphic-sibling files — a file whose class is one of ≥3 interchangeable
 * implementations of a shared interface (e.g. OkHttp's `: Interceptor` classes) —
 * to class + member signatures (bodies elided), keeping the on-spine exemplar full.
 * This sizes the response to the answer instead of the budget cap on sibling-heavy
 * flows (OkHttp interceptor-chain explore 28.5k→16.6k, ~28% cheaper than native
 * search, reads flat). It is PROVABLY INERT elsewhere: distinct pipeline steps (no
 * ≥3-implementer supertype, e.g. Excalidraw's `renderStaticScene`) and on-spine
 * files keep full source — output is byte-identical to shipped on excalidraw /
 * tokio / django / vscode / gin. Set `CODEGRAPH_ADAPTIVE_EXPLORE=0` to disable.
 */
function adaptiveExploreEnabled(): boolean {
  return process.env.CODEGRAPH_ADAPTIVE_EXPLORE !== '0' && process.env.CODEGRAPH_ADAPTIVE_EXPLORE !== 'false';
}

/**
 * Whether `codegraph_explore` is enabled. Default OFF.
 * Set `CODEGRAPH_ENABLE_EXPLORE=1` (or `true`) to re-enable the explore tool.
 */
function isExploreEnabled(): boolean {
  const v = process.env.CODEGRAPH_ENABLE_EXPLORE;
  return v === '1' || v === 'true';
}

/**
 * Split a copied callable signature into the symbol lookup key and the full
 * signature assertion. Handles return types and common trailing C++ qualifiers
 * while leaving natural-language questions untouched for the normal guard.
 */
function parseCallableLookup(value: string): { symbol: string; signature?: string } {
  const open = value.indexOf('(');
  const close = value.lastIndexOf(')');
  if (open <= 0 || close < open) return { symbol: value };

  const suffix = value.slice(close + 1).trim();
  const callableSuffix = /^(?:(?:const|volatile|override|final|noexcept(?:\s*\([^)]*\))?|=\s*(?:0|default|delete))\s*)*;?$/;
  if (!callableSuffix.test(suffix)) return { symbol: value };

  const prefix = value.slice(0, open).trim();
  const match = prefix.match(/([~A-Za-z_$][\w$~]*(?:(?:::|\.)[~A-Za-z_$][\w$~]*)*)$/);
  if (!match) return { symbol: value };
  const leading = prefix.slice(0, match.index).trim();
  if (/\b(?:how|what|why|where|when|does|do|did|works?|explain|find|show|tell|please|who|calls?)\b/i.test(leading)) {
    return { symbol: value };
  }
  return { symbol: match[1]!, signature: value };
}

/** High-confidence symbol-shaped literal accidentally sent to text_search. */
function isIdentifierLikeTextQuery(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\\/]/.test(trimmed) || /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ts|tsx|js|jsx|py|go|rs|java|cs)$/i.test(trimmed)) {
    return false;
  }
  const parsed = parseCallableLookup(trimmed);
  const symbol = parsed.symbol;
  if (!/^[~A-Za-z_$][\w$~]*(?:(?:::|\.)[~A-Za-z_$][\w$~]*)*$/.test(symbol)) return false;
  const leaf = symbol.replace(/[.]/g, '::').split('::').filter(Boolean).at(-1) ?? symbol;
  return Boolean(parsed.signature) || /::|\./.test(symbol) || isDistinctiveIdentifier(leaf);
}

/** Exact symbol/signature grammar without the distinctiveness gate used by recovery scans. */
function isExactSymbolLookup(value: string): boolean {
  const parsed = parseCallableLookup(value.trim());
  return /^[~A-Za-z_$][\w$~]*(?:(?:::|\.)[~A-Za-z_$][\w$~]*)*$/.test(parsed.symbol);
}

/**
 * Per-file staleness banner emitted at the top of a tool response when the
 * file watcher has pending events for files referenced by the response.
 * The agent uses this to fall back to Read for those specific files
 * without waiting for the debounced sync (issue #403).
 */
export function formatStaleBanner(
  stale: PendingFile[],
  startupCatchUpPending = false,
): string {
  const now = Date.now();
  const lines = stale.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    const label = p.indexing ? 'indexing in progress' : 'pending sync';
    return `  - ${p.path} (edited ${ageMs}ms ago, ${label})`;
  });
  const scope = startupCatchUpPending
    ? 'These are watcher-confirmed stale files. Startup index refresh is also unfinished, so additional recently changed files may be stale. '
    : 'Scope: ONLY the files listed above are stale; do not treat any other indexed file as stale. ' +
      'Every unlisted file in this response is fresh. ';
  return (
    '⚠️ Some files referenced below were edited since the last index sync — ' +
    'their codegraph entries may be stale:\n' +
    lines.join('\n') +
    `\n${scope}` +
    'For accurate content of a listed file, read only the required range directly.'
  );
}

type CatchUpStatus = 'running' | 'complete' | 'failed';

interface CatchUpState {
  status: CatchUpStatus;
  startedAt: number;
  budgetMs: number;
  release: Promise<void>;
  releaseNow: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  error?: string;
}

interface CatchUpAdmission {
  status: 'running' | 'failed';
  startedAt: number;
  budgetMs: number;
  error?: string;
}

/** Low-distraction freshness warning used after the bounded startup gate releases. */
function formatCatchUpNotice(
  admission: CatchUpAdmission,
  includeFailureDetail = false,
): string {
  if (admission.status === 'failed') {
    const notice =
      '⚠️ Startup index refresh was incomplete; results for recently changed files may be stale.';
    if (!includeFailureDetail) return notice;
    const safeError = admission.error?.replace(/\s+/g, ' ').trim().slice(0, 300);
    return safeError ? `${notice} Details: ${safeError}` : notice;
  }
  return '⚠️ Index refresh is still running; results for recently changed files may be stale.';
}

/**
 * MCP Tool definition
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
}

interface PropertySchema {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: PropertySchema;
  properties?: Record<string, PropertySchema>;
  required?: string[];
}

/**
 * Tool execution result
 */
export interface ToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

export interface ToolExecutionOptions {
  signal?: AbortSignal;
}

interface ResolvedRelationshipTarget {
  symbol: string;
  signature?: string;
  nodes: Node[];
  primary: Node;
  lookupNote: string;
}

/** Per-grouping memoization; never survives a request or graph mutation. */
interface RelationshipOverloadCache {
  parameterKeys: Map<string, string | null>;
  definitionsByDeclaration: Map<string, Node | null>;
  candidatesByName: Map<string, Node[]>;
  definitionEdgeSources: Map<string, Set<string>>;
}

interface ContextSymbolTarget {
  mode: 'symbol';
  symbol: string;
  file?: string;
  line?: number;
  signature?: string;
  members?: string[];
}

interface ContextFileTarget {
  mode: 'file';
  file: string;
  outline: boolean;
  outlineLimit?: number;
  outlineQueries?: string[];
  symbols?: Array<{ symbol: string; signature?: string }>;
  texts?: string[];
  offset?: number;
  limit?: number;
  text?: string;
  /** A singular text supplied with offset+limit validates that exact window. */
  textAsWindowAssertion?: boolean;
  contextLines: number;
  maxMatches: number;
}

type ContextTarget = ContextSymbolTarget | ContextFileTarget;

interface ResolvedIndexedFile {
  path: string;
  language: string;
}

interface ContextFileRange {
  start: number;
  end: number;
  labels: string[];
}

interface ContextSectionCandidate {
  label: string;
  section: string;
  estimatedChars: number;
  targetIndexes: Set<number>;
  file?: ResolvedIndexedFile;
  ranges?: ContextFileRange[];
}

type RenderedContentMode = 'metadata' | 'source' | 'source_truncated' | 'outline' | 'mixed';

interface RenderedNodeSection {
  text: string;
  contentMode: Exclude<RenderedContentMode, 'mixed'>;
}

interface RenderedImplementationGroup {
  text: string;
  contentMode: RenderedContentMode;
}

interface FormattedNodeDetails {
  text: string;
  sourceTruncated: boolean;
}

type RelationshipTargetResolution =
  | { target: ResolvedRelationshipTarget }
  | { result: ToolResult };

/**
 * Common projectPath property for cross-project queries
 */
const projectPathProperty: PropertySchema = {
  type: 'string',
  description: 'Path to a different project with .codegraph/ initialized. If omitted, uses current project. Use this to query other codebases.',
};

/**
 * NodeKinds exposed as the `kind` filter enum in codegraph_search.
 * Derived from NODE_KINDS so new kinds appear automatically — a hardcoded
 * list is exactly how macro/enum/enum_member were silently omitted before.
 * Excluded: file/parameter/import/export (no user-facing search value).
 */
const SEARCHABLE_KINDS = NODE_KINDS.filter(
  k => k !== 'file' && k !== 'parameter' && k !== 'import' && k !== 'export'
);

/**
 * All CodeGraph MCP tools
 *
 * Designed for minimal context usage - use codegraph_explore as the primary tool
 * (one call usually answers the whole question), and only use other tools for
 * targeted follow-up queries.
 *
 * All tools support cross-project queries via the optional `projectPath` parameter.
 */
export const tools: ToolDefinition[] = [
  {
    name: 'search',
    description:
      'Search 1–8 symbol names, qualified names, or callable signatures. Defaults to strict case-sensitive lookup; case correction, fuzzy suggestions, and owner recovery require server environment CODEGRAPH_SEARCH_FUZZY=1. Batch with `queries`; true misses share one exact raw-source scan. `path` is a soft disambiguation hint: matching candidates are narrowed and ranked, while a miss keeps all exact candidates with a warning. Use line/signature for stronger assertions. `includeCode="if_unique"` returns one implementation body plus compact declaration pointers; oversized source is safely truncated. Natural-language questions and literal values are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            '符号名或限定名（例如 "signIn"、"rtl::OString"、"Session.request"）。' +
            '禁止传入：十六进制值(0x...)、自然语言问题、空格分隔的命令/描述',
        },
        queries: {
          type: 'array',
          description: '原生批量模式：1–8 个查询对象。每项必须有 query，并可单独覆盖 kind/limit/path/line/signature/includeCode。不要循环调用 search。运行时也兼容字符串项。',
          minItems: 1,
          maxItems: MCP_SEARCH_MAX_QUERIES,
          items: {
            type: 'object',
            description: '一个精确符号查询。',
            properties: {
              query: { type: 'string', description: '符号名、限定名或可调用签名。' },
              kind: { type: 'string', description: '可选节点类型过滤。', enum: SEARCHABLE_KINDS },
              limit: { type: 'number', description: '该查询最大结果数。', minimum: 1, maximum: 100 },
              path: { type: 'string', description: '可选软路径提示：命中时收窄并排序；未命中时保留全部精确候选并提示。' },
              line: { type: 'number', description: '可选 1-based 行号。', minimum: 1 },
              signature: { type: 'string', description: '可选精确/显著签名。' },
              includeCode: { type: 'string', description: '唯一逻辑重载时内联实现源码并紧凑引用声明；超预算源码会安全截断。', enum: ['never', 'if_unique'] },
            },
            required: ['query'],
          },
        },
        kind: {
          type: 'string',
          description: 'Filter by node kind',
          enum: SEARCHABLE_KINDS,
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10)',
          default: 10,
        },
        path: {
          type: 'string',
          description: 'Optional soft file-path hint. Matching exact candidates are narrowed and ranked by path similarity; if none match, all exact candidates remain visible with a warning.',
        },
        line: {
          type: 'number',
          description: 'Optional 1-based source line used with path to disambiguate repeated qualified names or overloads',
        },
        signature: {
          type: 'string',
          description: 'Optional exact/distinctive callable signature. A signature passed directly as query is recognized automatically.',
        },
        includeCode: {
          type: 'string',
          description: 'For one logical overload, return implementation source plus compact declaration pointers. Oversized source is safely truncated, never silently replaced by an outline.',
          enum: ['never', 'if_unique'],
          default: 'never',
        },
        projectPath: projectPathProperty,
      },
      required: [],
    },
  },
  {
    name: 'context',
    description: 'Bounded 1–8 target manifest. Supports container members, exact offset/limit windows, text assertions, and grouped `{file, symbols, texts}` anchors. Decl/def partners and ranges are deduplicated; `expectedMissing` verifies new names. A bare file returns a compact symbol outline with name-only filters. A JSON-stringified targets array is parsed automatically. Preflight stops over-budget plain windows before partial source.',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          description: 'One to eight explicit manifest groups. Prefer one `{file, symbols:[...]}` per implementation file or `{symbol:<container>, members:[...]}` per class. A bare `{file}` becomes an outline. Runtime also accepts a JSON-stringified array. Adjacent/overlapping current-source ranges are merged.',
          minItems: 1,
          maxItems: MCP_CONTEXT_MAX_TARGETS,
          items: {
            type: 'object',
            description: 'Choose symbol mode (`symbol`, optional hints/members) OR file mode (`file` alone for an outline, or with offset+limit/text for source).',
            properties: {
              symbol: {
                type: 'string',
                description: 'Exact symbol name; qualified when available.',
              },
              file: {
                type: 'string',
                description: 'Path/basename. With `symbol` it disambiguates. With `symbols`/`texts` it defines one manifest group. By itself it returns a compact outline.',
              },
              symbols: {
                type: 'array',
                description: 'File-manifest mode: 1–32 exact symbol names or callable signatures expected in this file. Matching declarations/definitions in other files are included when expand=`declaration_definition`. Do not put natural-language phrases here.',
                minItems: 1,
                maxItems: MCP_CONTEXT_MAX_FILE_SYMBOLS,
                items: { type: 'string', description: 'Exact symbol name, qualified name, or callable signature.' },
              },
              texts: {
                type: 'array',
                description: 'File-manifest mode: 1–8 literal edit anchors searched together in this exact file. Useful for macros/schema markers/non-symbol boundaries.',
                minItems: 1,
                maxItems: MCP_CONTEXT_MAX_FILE_TEXTS,
                items: { type: 'string', description: 'Exact literal text anchor.' },
              },
              line: {
                type: 'number',
                description: 'Optional 1-based line that must fall inside the intended symbol. A miss returns exact candidates instead of choosing the nearest overload.',
                minimum: 1,
              },
              signature: {
                type: 'string',
                description: 'Optional exact or distinctive signature text used to narrow same-file overloads, e.g. `push_back_send_list(ObDtlLinkedBuffer *buffer)`.',
              },
              members: {
                type: 'array',
                description: 'Symbol mode: 1–32 exact member names inside the named container. Returns declarations and matching out-of-line definitions together, bounded by the existing context output budget.',
                minItems: 1,
                maxItems: MCP_CONTEXT_MAX_MEMBERS,
                items: { type: 'string', description: 'Exact member name inside the container.' },
              },
              offset: {
                type: 'number',
                description: 'File mode: 1-based exact source-window start; requires limit. When limit is supplied alone, offset safely defaults to 1.',
                minimum: 1,
              },
              limit: {
                type: 'number',
                description: 'File mode: source-window length (maximum 500; larger runtime values are safely clamped; output character budgets still apply).',
                minimum: 1,
              },
              text: {
                type: 'string',
                description: 'File mode: literal anchor to locate in this exact indexed file. When combined with offset+limit, the explicit window is returned and text is treated as an assertion instead of causing a parameter error.',
              },
              contextLines: {
                type: 'number',
                description: 'Text-anchor mode: lines before/after each match (default 20, maximum 60).',
                minimum: 0,
                maximum: MCP_CONTEXT_MAX_TEXT_CONTEXT_LINES,
                default: 20,
              },
              maxMatches: {
                type: 'number',
                description: 'Text-anchor mode: maximum matching windows (default 1, maximum 3).',
                minimum: 1,
                maximum: MCP_CONTEXT_MAX_TEXT_MATCHES,
                default: 1,
              },
              symbolsOnly: {
                type: 'boolean',
                description: 'File outline mode. In batch mode this is accepted for parity with node(file=..., symbolsOnly=true).',
              },
              outlineQuery: {
                type: 'string',
                description: 'File outline mode: one leaf-name substring or `a|b|c` OR expression. Parameter/signature text is not matched.',
              },
              outlineQueries: {
                type: 'array',
                description: 'File outline mode: 1–8 case-insensitive OR filters.',
                minItems: 1,
                maxItems: 8,
                items: { type: 'string', description: 'Partial symbol/member token.' },
              },
              outlineLimit: {
                type: 'number',
                description: 'File outline mode: maximum entries for this file (maximum 80).',
                minimum: 1,
                maximum: MCP_NODE_MAX_OUTLINE_SYMBOLS,
              },
            },
          },
        },
        includeRelations: {
          type: 'boolean',
          description: 'Include caller/callee trails for every target (default: false). Leave false for edit context; use relationship tools for graph questions.',
          default: false,
        },
        expand: {
          type: 'string',
          description: 'Deterministic expansion for file-scoped `symbols`: include matching declaration/definition partners, or only nodes in the named file. No natural-language or semantic inference is performed.',
          enum: ['declaration_definition', 'none'],
          default: 'declaration_definition',
        },
        expectedMissing: {
          type: 'array',
          description: 'Explicit identifiers expected to be new/absent before the edit. They are verified with current-source evidence but never used to discover implementation targets.',
          minItems: 1,
          maxItems: MCP_CONTEXT_MAX_EXPECTED_MISSING,
          items: { type: 'string', description: 'Exact identifier expected not to exist yet.' },
        },
        projectPath: projectPathProperty,
      },
      required: ['targets'],
    },
  },
  {
    name: 'text_search',
    description: 'Batch literal-text search over indexed source files for strings the AST graph does not model (macros, registration strings, table names, generated-code markers). Requires a narrow directory/file `path`; searches 1–8 literals in one call and returns small line snippets. Zero-match identifier-like queries automatically include exact global symbol results, avoiding a correction call. Generated files are skipped by default, except when `path` resolves to one exact generated file and includeGenerated was not explicitly disabled.',
    inputSchema: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          description: 'One to eight literal strings to find. These are plain strings, not regular expressions.',
          minItems: 1,
          maxItems: MCP_TEXT_SEARCH_MAX_QUERIES,
          items: {
            type: 'string',
            description: 'Non-empty literal text.',
          },
        },
        path: {
          type: 'string',
          description: 'Required indexed directory or file-path substring that bounds the scan, e.g. `src/share/inner_table`.',
        },
        maxMatchesPerQuery: {
          type: 'number',
          description: 'Maximum matches returned per literal (default: 5, maximum: 20).',
          default: 5,
          minimum: 1,
          maximum: MCP_TEXT_SEARCH_MAX_MATCHES_PER_QUERY,
        },
        contextLines: {
          type: 'number',
          description: 'Surrounding lines per match (default: 1, maximum: 2).',
          default: 1,
          minimum: 0,
          maximum: MCP_TEXT_SEARCH_MAX_CONTEXT_LINES,
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Use case-sensitive literal matching (default: true).',
          default: true,
        },
        includeGenerated: {
          type: 'boolean',
          description: 'Also search generated source files. Directory searches default to false; one exact generated-file path is auto-included unless this is explicitly false.',
          default: false,
        },
        projectPath: projectPathProperty,
      },
      required: ['queries', 'path'],
    },
  },
  {
    name: 'callers',
    description: 'List functions that call one exact symbol/overload. Optional `file`, `line`, and `signature` hints disambiguate overloaded or same-named symbols. If more than one logical overload remains, no graph traversal is run; exact candidates are returned instead of aggregating unrelated callers. For one exact C++/interface override, callers attached to its base virtual declaration are aggregated across the explicit dispatch family.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Exact symbol name, optionally including a callable signature such as `push(Buffer *buffer)`.',
        },
        file: {
          type: 'string',
          description: 'Optional path/basename that must contain the intended symbol.',
        },
        line: {
          type: 'number',
          description: 'Optional 1-based line that must fall inside the intended symbol. Never selects the nearest overload.',
          minimum: 1,
        },
        signature: {
          type: 'string',
          description: 'Optional exact or distinctive callable signature, e.g. `push(Buffer *buffer)`.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callers to return (default: 20)',
          default: 20,
          minimum: 1,
          maximum: 100,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'callees',
    description: 'List functions called by one exact symbol/overload. Optional `file`, `line`, and `signature` hints disambiguate overloaded or same-named symbols. If more than one logical overload remains, no graph traversal is run; exact candidates are returned instead of aggregating unrelated callees.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Exact symbol name, optionally including a callable signature such as `push(Buffer *buffer)`.',
        },
        file: {
          type: 'string',
          description: 'Optional path/basename that must contain the intended symbol.',
        },
        line: {
          type: 'number',
          description: 'Optional 1-based line that must fall inside the intended symbol. Never selects the nearest overload.',
          minimum: 1,
        },
        signature: {
          type: 'string',
          description: 'Optional exact or distinctive callable signature, e.g. `push(Buffer *buffer)`.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callees to return (default: 20)',
          default: 20,
          minimum: 1,
          maximum: 100,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'impact',
    description: 'List symbols affected by changing one exact symbol/overload. Optional `file`, `line`, and `signature` hints disambiguate overloaded or same-named symbols. If more than one logical overload remains, no impact traversal is run; exact candidates are returned instead of merging unrelated impact graphs.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Exact symbol name, optionally including a callable signature such as `push(Buffer *buffer)`.',
        },
        file: {
          type: 'string',
          description: 'Optional path/basename that must contain the intended symbol.',
        },
        line: {
          type: 'number',
          description: 'Optional 1-based line that must fall inside the intended symbol. Never selects the nearest overload.',
          minimum: 1,
        },
        signature: {
          type: 'string',
          description: 'Optional exact or distinctive callable signature, e.g. `push(Buffer *buffer)`.',
        },
        depth: {
          type: 'number',
          description: 'How many levels of dependencies to traverse (default: 2)',
          default: 2,
          minimum: 1,
          maximum: 10,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'node',
    description: 'Read minimal indexed context. Prefer SYMBOL MODE for one named implementation; source is safely truncated and relations are omitted by default. Native BATCH MODE accepts 1–8 symbol/member/text/file-region targets and deduplicates ranges and decl/def partners. FILE MODE supports a name-filtered outline or exact offset+limit boundary. Bare-file/full-file reads are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          description: 'Native batch mode: 1–8 precise targets. Supports `{symbol, file?, line?, signature?, members?}`, grouped `{file, symbols:[...], texts:[...]}`, `{file}` for an outline, `{file, text, contextLines?, maxMatches?}`, and `{file, offset, limit}`. Source ranges are merged and declaration/definition partners are expanded exactly like codegraph_context.',
          minItems: 1,
          maxItems: MCP_CONTEXT_MAX_TARGETS,
          items: {
            type: 'object',
            description: 'One precise symbol/member/text/file-region target.',
            properties: {
              symbol: { type: 'string', description: 'Exact symbol or qualified name.' },
              file: { type: 'string', description: 'Optional symbol disambiguator, or exact file for outline/text/region mode.' },
              symbols: {
                type: 'array',
                description: 'File-manifest mode: 1–32 exact symbol names or callable signatures in this file.',
                minItems: 1,
                maxItems: MCP_CONTEXT_MAX_FILE_SYMBOLS,
                items: { type: 'string', description: 'Exact symbol name, qualified name, or callable signature.' },
              },
              texts: {
                type: 'array',
                description: 'File-manifest mode: 1–8 literal edit anchors searched together in this file.',
                minItems: 1,
                maxItems: MCP_CONTEXT_MAX_FILE_TEXTS,
                items: { type: 'string', description: 'Exact literal text anchor.' },
              },
              line: { type: 'number', description: 'Optional 1-based source line for symbol disambiguation.', minimum: 1 },
              signature: { type: 'string', description: 'Optional exact/distinctive callable signature.' },
              members: {
                type: 'array',
                description: 'Container-member focus; up to 32 exact member names.',
                minItems: 1,
                maxItems: MCP_CONTEXT_MAX_MEMBERS,
                items: { type: 'string', description: 'Exact member name.' },
              },
              offset: { type: 'number', description: 'Exact file-region start.', minimum: 1 },
              limit: { type: 'number', description: 'Exact file-region line count; safely clamped to 500, with output character budgets still enforced.', minimum: 1 },
              text: { type: 'string', description: 'Literal anchor in the exact file. With offset+limit it becomes a window assertion and does not conflict.' },
              contextLines: {
                type: 'number',
                description: 'Lines before/after a text anchor.',
                minimum: 0,
                maximum: MCP_CONTEXT_MAX_TEXT_CONTEXT_LINES,
              },
              maxMatches: {
                type: 'number',
                description: 'Maximum text-anchor matches.',
                minimum: 1,
                maximum: MCP_CONTEXT_MAX_TEXT_MATCHES,
              },
              symbolsOnly: {
                type: 'boolean',
                description: 'Return a compact outline for this batch file target.',
              },
              outlineQuery: {
                type: 'string',
                description: 'Outline filter; supports `a|b|c` as OR.',
              },
              outlineQueries: {
                type: 'array',
                description: 'One to eight outline filters combined with OR.',
                minItems: 1,
                maxItems: 8,
                items: { type: 'string', description: 'Partial symbol/member token.' },
              },
              outlineLimit: {
                type: 'number',
                description: 'Maximum outline entries for this file.',
                minimum: 1,
                maximum: MCP_NODE_MAX_OUTLINE_SYMBOLS,
              },
            },
          },
        },
        symbol: {
          type: 'string',
          description: 'Symbol mode: exact symbol name to inspect. Prefer this whenever the target can be named.',
        },
        includeCode: {
          type: 'boolean',
          description: 'Symbol mode only: include source (default: false). Oversized source is safely truncated. Rejected in file mode.',
          default: false,
        },
        includeRelations: {
          type: 'boolean',
          description: 'Symbol mode only: include the caller/callee trail (default: false). Prefer callers/callees tools when only one relationship direction is needed.',
          default: false,
        },
        expand: {
          type: 'string',
          description: 'Batch mode only: expand file-scoped symbols to declaration/definition partners, or keep only nodes in the named file.',
          enum: ['declaration_definition', 'none'],
          default: 'declaration_definition',
        },
        expectedMissing: {
          type: 'array',
          description: 'Batch mode only: explicitly named new identifiers to verify as absent with current-source evidence; never used for retrieval.',
          minItems: 1,
          maxItems: MCP_CONTEXT_MAX_EXPECTED_MISSING,
          items: { type: 'string', description: 'Exact identifier expected not to exist yet.' },
        },
        file: {
          type: 'string',
          description: 'Path/basename. With `symbol`, disambiguates that definition. Without `symbol`, requires either `symbolsOnly=true` or both `offset` and `limit<=500`.',
        },
        offset: {
          type: 'number',
          description: 'Guarded file-window mode only: required 1-based start line. Cannot be combined with `symbol` or `symbolsOnly`.',
          minimum: 1,
        },
        limit: {
          type: 'number',
          description: 'Guarded file-window mode only: requested line count. Values above 500 are accepted and safely clamped to 500 (the output character budget still applies), avoiding a failed correction call. Cannot be combined with `symbol` or `symbolsOnly`.',
          minimum: 1,
        },
        symbolsOnly: {
          type: 'boolean',
          description: 'File mode: return a compact symbol map + dependents. This is the default entry when a file is known but its target symbol is not. If offset/limit were also copied into the call, they are ignored and the outline still succeeds.',
          default: false,
        },
        outlineQuery: {
          type: 'string',
          description: 'symbolsOnly mode: optional case-insensitive leaf-name substring. Parameter/signature text is not matched.',
        },
        outlineQueries: {
          type: 'array',
          description: 'symbolsOnly mode: 1–8 case-insensitive OR filters. `outlineQuery="a|b"` is normalized to the same form.',
          minItems: 1,
          maxItems: 8,
          items: { type: 'string', description: 'Partial symbol/member token.' },
        },
        outlineLimit: {
          type: 'number',
          description: 'symbolsOnly mode: maximum entries (default: 60, maximum: 80).',
          default: MCP_NODE_DEFAULT_OUTLINE_SYMBOLS,
          minimum: 1,
          maximum: MCP_NODE_MAX_OUTLINE_SYMBOLS,
        },
        line: {
          type: 'number',
          description: 'Symbol mode only: disambiguate to a symbol containing this line. A miss is reported with exact candidates; the nearest overload is never selected silently.',
        },
        projectPath: projectPathProperty,
      },
      required: [],
    },
  },
  {
    name: 'explore',
    description: 'PRIMARY TOOL — call FIRST for almost any question OR before an edit: how does X work, architecture, a bug, where/what is X, surveying an area, or the symbols you are about to change. Returns the verbatim source of the relevant symbols grouped by file in ONE capped call (Read-equivalent — treat the shown source as already Read; do NOT re-open those files), plus the call path among them. 传入一组符号名/文件名（例如 "AuthService"、"GraphTraverser BFS impact traversal.ts"）。为获得最佳结果请使用符号名，不要传自然语言问题。Usually the ONLY call you need — more accurate context, in far fewer tokens and round-trips than a search/Read/Grep loop.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '符号名、文件名或简短代码术语（例如 "AuthService"、"GraphTraverser BFS traversal.ts"）。不要传自然语言问题——先提取关键符号名再传入。',
        },
        maxFiles: {
          type: 'number',
          description: 'Maximum number of files to include source code from (default: 12)',
          default: 12,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
  },
  {
    name: 'status',
    description: 'Index health check (files / nodes / edges). Skip unless debugging.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'files',
    description: 'Indexed file tree with language + symbol counts. Faster than Glob for project layout.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Filter to files under this directory path (e.g., "src/components"). Returns all files if not specified.',
        },
        pattern: {
          type: 'string',
          description: 'Filter files matching this glob pattern (e.g., "*.tsx", "**/*.test.ts")',
        },
        format: {
          type: 'string',
          description: 'Output format: "tree" (hierarchical, default), "flat" (simple list), "grouped" (by language)',
          enum: ['tree', 'flat', 'grouped'],
          default: 'tree',
        },
        includeMetadata: {
          type: 'boolean',
          description: 'Include file metadata like language and symbol count (default: true)',
          default: true,
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum directory depth to show (default: unlimited)',
        },
        projectPath: projectPathProperty,
      },
    },
  },
];

/**
 * Allowlist-filtered tool definitions WITHOUT an engine — the static surface the
 * proxy answers `tools/list` with before any project is open. Mirrors
 * `ToolHandler.getTools()` in the no-CodeGraph case (the dynamic per-repo budget
 * note in a description only adds once `cg` is loaded; the schemas are static).
 */
export function getStaticTools(): ToolDefinition[] {
  const raw = process.env.CODEGRAPH_MCP_TOOLS;
  let filtered: ToolDefinition[];
  if (!raw || !raw.trim()) {
    filtered = tools;
  } else {
    const allow = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
    filtered = allow.size ? tools.filter(t => allow.has(t.name)) : tools;
  }
  if (!isExploreEnabled()) {
    filtered = filtered.filter(t => t.name !== 'explore');
  }
  return filtered;
}

/**
 * Tool handler that executes tools against a CodeGraph instance
 *
 * Supports cross-project queries via the projectPath parameter.
 * Other projects are opened on-demand and cached for performance.
 */
export class ToolHandler {
  // Cache of opened CodeGraph instances for cross-project queries
  private projectCache: Map<string, CodeGraph> = new Map();
  // The directory the server last searched for a default project. Surfaced in
  // the "not initialized" error so users can see why detection missed.
  private defaultProjectHint: string | null = null;
  // Per-start-path cache of the git worktree/index mismatch (issue #155). The
  // mismatch is a fixed property of (where the request came from → which
  // .codegraph/ it resolves to), so the up-to-two `git rev-parse` spawns run
  // once and every later tool call reuses the result — never shelling out to
  // git on the hot path. `undefined` = not computed yet; `null` = no mismatch.
  private worktreeMismatchCache: Map<string, WorktreeIndexMismatch | null> = new Map();
  // Shared startup-reconcile state. Queries proceed immediately by default;
  // an explicit positive budget makes requests share one wait deadline.
  // Background sync keeps a project-wide stale notice visible until completion,
  // including failures instead of blessing the previous index as fresh.
  private catchUpState: CatchUpState | null = null;
  // Daemon sessions may execute concurrently. AsyncLocalStorage keeps one
  // request's cancellation signal attached to its raw-evidence subprocess
  // without leaking it into another client's tool call.
  private executionSignal = new AsyncLocalStorage<AbortSignal | undefined>();

  constructor(private cg: CodeGraph | null) {}

  /**
   * Update the default CodeGraph instance (e.g. after lazy initialization)
   */
  setDefaultCodeGraph(cg: CodeGraph): void {
    this.cg = cg;
  }

  /**
   * Engine-only: register background catch-up and track its freshness warning.
   * Queries proceed immediately unless a positive wait budget is configured.
   * Rejections never become tool errors, but remain visible as a warning.
   */
  setCatchUpGate(p: Promise<void> | null, budgetMs?: number): void {
    const previous = this.catchUpState;
    if (previous?.timer) clearTimeout(previous.timer);
    // Wake requests captured on the old generation so they can observe the
    // replacement (or shutdown) instead of waiting forever on an abandoned gate.
    previous?.releaseNow();
    this.catchUpState = null;
    if (!p) return;

    let releaseNow!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseNow = resolve;
    });
    const state: CatchUpState = {
      status: 'running',
      startedAt: Date.now(),
      budgetMs: budgetMs === undefined
        ? resolveMcpCatchUpBudgetMs(process.env.CODEGRAPH_MCP_CATCHUP_BUDGET_MS)
        : resolveMcpCatchUpBudgetMs(String(budgetMs)),
      release,
      releaseNow,
      timer: null,
    };
    this.catchUpState = state;

    if (state.budgetMs === 0) {
      // No timer/event-loop turn is needed for the default nonblocking path.
      state.releaseNow();
    } else {
      state.timer = setTimeout(() => {
        state.timer = null;
        state.releaseNow();
      }, state.budgetMs);
      state.timer.unref?.();
    }

    // Attach both handlers immediately so even an already-rejected promise is
    // observed. The completion branch only clears this exact generation; a
    // later catch-up registered through retry initialization wins.
    void p.then(
      () => {
        state.status = 'complete';
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        state.releaseNow();
        if (this.catchUpState === state) this.catchUpState = null;
      },
      (error: unknown) => {
        state.status = 'failed';
        state.error = error instanceof Error ? error.message : String(error);
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        state.releaseNow();
      },
    );
  }

  /**
   * Record the directory the server tried to resolve the default project from.
   * Used only to make the "no default project" error actionable.
   */
  setDefaultProjectHint(searchedPath: string): void {
    this.defaultProjectHint = searchedPath;
  }

  /**
   * Whether a default CodeGraph instance is available
   */
  hasDefaultCodeGraph(): boolean {
    return this.cg !== null;
  }

  /**
   * Optional allowlist of exposed tools, parsed from the CODEGRAPH_MCP_TOOLS
   * env var (comma-separated short names, e.g. "trace,search,node,context").
   * Unset/empty → every tool is exposed. Lets an operator (or an A/B harness)
   * trim the tool surface without rebuilding the client config; the ablated
   * tool is then truly absent from ListTools rather than merely denied on call.
   * Values are short MCP names such as "node", "context", and "search".
   */
  private toolAllowlist(): Set<string> | null {
    const raw = process.env.CODEGRAPH_MCP_TOOLS;
    if (!raw || !raw.trim()) return null;
    const set = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
    return set.size ? set : null;
  }

  /** Whether a tool name passes the CODEGRAPH_MCP_TOOLS allowlist (if any) and is not disabled. */
  private isToolAllowed(name: string): boolean {
    if (name === 'explore' && !isExploreEnabled()) return false;
    const allow = this.toolAllowlist();
    return !allow || allow.has(name);
  }

  /**
   * Get tool definitions with dynamic descriptions based on project size.
   * The codegraph_explore tool description includes a budget recommendation
   * scaled to the number of indexed files. Honors the CODEGRAPH_MCP_TOOLS
   * allowlist so a trimmed surface is reflected in ListTools.
   */
  getTools(): ToolDefinition[] {
    const allow = this.toolAllowlist();
    let visible = allow
      ? tools.filter(t => allow.has(t.name))
      : tools;
    if (!isExploreEnabled()) {
      visible = visible.filter(t => t.name !== 'explore');
    }
    if (!this.cg) return visible;

    try {
      const stats = this.cg.getStats();
      const budget = getExploreBudget(stats.fileCount);

      // Tiny-repo tool gating: on projects under TINY_REPO_FILE_THRESHOLD
      // files, only expose the 5 core tools (search, context, node,
      // explore, trace). The 5 omitted tools (callers, callees, impact,
      // status, files) reduce to one grep at this scale.
      //
      // n=2 audits ruled out cutting below 5 tools:
      // - 3-tool gate (search + context + trace): cost regressed on
      //   cobra/ky/sinatra. The agent fell back to raw Reads to cover
      //   what codegraph_node + codegraph_explore would have answered.
      // - 1-tool gate (search only): catastrophic regression — express
      //   went from -43% WIN to +107% LOSS. With only search, the agent
      //   can't navigate the call graph structurally and reads everything.
      //
      // 5 is the empirical lower bound. Tools beyond search/context/
      // node/explore/trace pay overhead that the agent doesn't recoup
      // on tiny-repo flow questions.
      // ITER4: raise threshold 150 → 500 so single-file frameworks
      // (sinatra at 159, slim_framework around 200) also get the
      // 5-tool surface. The empirical 5-tool floor was set on <150
      // probes; iter3 measurement showed sinatra is structurally the
      // SAME problem as cobra (single-file WITHOUT-arm Read wins),
      // so it deserves the same gating.
      const TINY_REPO_FILE_THRESHOLD = 500;
      const TINY_REPO_CORE_TOOLS = new Set([
        'explore',
        'search',
        'context',
        'node',
      ]);
      if (stats.fileCount < TINY_REPO_FILE_THRESHOLD) {
        visible = visible.filter(t => TINY_REPO_CORE_TOOLS.has(t.name));
      }

      return visible.map(tool => {
        if (tool.name === 'explore') {
          return {
            ...tool,
            description: `${tool.description} Budget: make at most ${budget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).`,
          };
        }
        return tool;
      });
    } catch {
      return visible;
    }
  }

  /**
   * Get CodeGraph instance for a project
   *
   * If projectPath is provided, opens that project's CodeGraph (cached).
   * Otherwise returns the default CodeGraph instance.
   *
   * Walks up parent directories to find the nearest .codegraph/ folder,
   * similar to how git finds .git/ directories.
   */
  private getCodeGraph(projectPath?: string): CodeGraph {
    if (!projectPath) {
      if (!this.cg) {
        const searched = this.defaultProjectHint ?? process.cwd();
        throw new Error(
          'No CodeGraph project is loaded for this session.\n' +
          `Searched for a .codegraph/ directory starting from: ${searched}\n` +
          'The index is likely fine — this is a working-directory detection issue: ' +
          "the MCP client launched the server outside your project and didn't report the " +
          'workspace root. Fix it either way:\n' +
          '  • Pass projectPath to the tool call, e.g. projectPath: "/absolute/path/to/your/project"\n' +
          '  • Or add --path to the server\'s MCP config args: ["serve", "--mcp", "--path", "/absolute/path/to/your/project"]'
        );
      }
      return this.cg;
    }

    // Check cache first (using original path as key)
    if (this.projectCache.has(projectPath)) {
      return this.projectCache.get(projectPath)!;
    }

    // Reject sensitive system directories before opening. Only validate a
    // path that actually exists — a nested or not-yet-created sub-path of a
    // real project must still be allowed to resolve UP to its .codegraph/
    // root below (issue #238), so we don't run the existence-checking
    // validator on paths that are meant to walk up.
    if (existsSync(projectPath)) {
      const pathError = validateProjectPath(projectPath);
      if (pathError) {
        throw new Error(pathError);
      }
    }

    // Walk up parent directories to find nearest .codegraph/
    const resolvedRoot = findNearestCodeGraphRoot(projectPath);

    if (!resolvedRoot) {
      throw new Error(`CodeGraph not initialized in ${projectPath}. Run 'codegraph init' in that project first.`);
    }

    // If the path resolves to the default project, reuse the already-open
    // default instance rather than opening a SECOND connection to the same DB.
    // A duplicate connection serializes reads against the watcher's auto-sync
    // writes; on the wasm backend (no WAL) that surfaces as intermittent
    // "database is locked" on concurrent tool calls. See issue #238. Deliberately
    // not cached under projectPath — the server owns and closes the default
    // instance, so routing it through projectCache.closeAll() would double-close it.
    if (this.cg && this.cg.getProjectRoot() === resolvedRoot) {
      return this.cg;
    }

    // Check if we already have this resolved root cached (different path, same project)
    if (this.projectCache.has(resolvedRoot)) {
      const cg = this.projectCache.get(resolvedRoot)!;
      // Cache under original path too for faster future lookups
      this.projectCache.set(projectPath, cg);
      return cg;
    }

    // Open and cache under both paths
    const cg = loadCodeGraph().openSync(resolvedRoot);
    this.projectCache.set(resolvedRoot, cg);
    if (projectPath !== resolvedRoot) {
      this.projectCache.set(projectPath, cg);
    }
    return cg;
  }

  /**
   * Close all cached project connections
   */
  closeAll(): void {
    this.setCatchUpGate(null);
    for (const cg of this.projectCache.values()) {
      cg.close();
    }
    this.projectCache.clear();
    this.worktreeMismatchCache.clear();
  }

  /**
   * Validate that a value is a non-empty string within length bounds.
   *
   * The `maxLength` cap protects against MCP clients that ship huge
   * payloads (10MB+ query strings either by accident or maliciously).
   * Without this, a single oversized input can pin the FTS5 index or
   * exhaust memory before any real work runs.
   */
  private validateString(
    value: unknown,
    name: string,
    maxLength: number = MAX_INPUT_LENGTH
  ): string | ToolResult {
    if (typeof value !== 'string' || value.length === 0) {
      return this.errorResult(`${name} must be a non-empty string`);
    }
    if (value.length > maxLength) {
      return this.errorResult(
        `${name} exceeds maximum length of ${maxLength} characters (got ${value.length})`
      );
    }
    return value;
  }

  /**
   * Validate an optional path-like string input. Returns the value if
   * valid (or undefined), or a ToolResult with the error.
   */
  private validateOptionalPath(
    value: unknown,
    name: string
  ): string | undefined | ToolResult {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      return this.errorResult(`${name} must be a string`);
    }
    if (value.length > MAX_PATH_LENGTH) {
      return this.errorResult(
        `${name} exceeds maximum length of ${MAX_PATH_LENGTH} characters (got ${value.length})`
      );
    }
    return value;
  }

  /**
   * Cached git worktree/index mismatch for a tool call's effective project.
   *
   * The "effective project" is what the request targets: an explicit
   * `projectPath` arg, else the directory the server resolved its default
   * project from (`defaultProjectHint`), else cwd. Memoized per start path —
   * see `worktreeMismatchCache`. Best-effort: if the project can't be resolved
   * (e.g. nothing initialized yet), it reports "no mismatch" so a tool is never
   * broken by this check.
   */
  private worktreeMismatchFor(projectPath?: string): WorktreeIndexMismatch | null {
    const startPath = projectPath ?? this.defaultProjectHint ?? process.cwd();
    const cached = this.worktreeMismatchCache.get(startPath);
    if (cached !== undefined) return cached;

    let mismatch: WorktreeIndexMismatch | null = null;
    try {
      mismatch = detectWorktreeIndexMismatch(startPath, this.getCodeGraph(projectPath).getProjectRoot());
    } catch {
      // No resolvable project (or any other resolution error) → nothing to warn.
      mismatch = null;
    }
    this.worktreeMismatchCache.set(startPath, mismatch);
    return mismatch;
  }

  /**
   * Prefix a successful read-tool result with a compact worktree-mismatch
   * notice when the resolved index belongs to a different git working tree than
   * the caller's (issue #155). Without this, an agent in a nested worktree
   * silently trusts main-branch results. No-op on error results and when there
   * is no mismatch. `codegraph_status` is excluded — it embeds its own verbose
   * warning — so it stays out of this path.
   */
  private withWorktreeNotice(result: ToolResult, projectPath?: string): ToolResult {
    if (result.isError) return result;
    const mismatch = this.worktreeMismatchFor(projectPath);
    if (!mismatch) return result;

    const notice = worktreeMismatchNotice(mismatch);
    const [first, ...rest] = result.content;
    if (first && first.type === 'text') {
      return { ...result, content: [{ type: 'text', text: `${notice}\n\n${first.text}` }, ...rest] };
    }
    return result;
  }

  /**
   * Annotate a successful read-tool result with per-file staleness — the
   * non-blocking answer to issue #403. The file watcher tracks every event
   * it sees per path; here we intersect "files referenced in this response"
   * against that pending set and prepend a compact banner so the agent can
   * fall back to Read for those *specific* files without waiting for the
   * debounced sync to fire. Pending files not referenced by the current
   * answer are deliberately silent: they do not affect this result and a
   * project-wide list on every call is pure context noise. codegraph_status
   * remains the explicit place to inspect every pending file.
   *
   * Cost when nothing is pending — the common case — is one boolean check.
   * No I/O, no parsing of markdown beyond a per-pending-file substring scan.
   */
  private withStalenessNotice(
    result: ToolResult,
    projectPath?: string,
    startupCatchUpPending = false,
  ): ToolResult {
    if (result.isError) return result;

    let cg: CodeGraph;
    try {
      cg = this.getCodeGraph(projectPath);
    } catch {
      return result; // no default project — leave as is
    }

    // Cross-project `projectPath` calls open a cached CodeGraph WITHOUT a
    // watcher (watchers are only attached to the default session project).
    // When the cross-project path happens to be the same project as the
    // default cg, the cached instance is the wrong one — its pendingFiles is
    // permanently empty. Detect the equal-path case and prefer the default
    // cg so the staleness signal still fires when an agent passes the
    // explicit projectPath form of its own project.
    if (this.cg && cg !== this.cg) {
      try {
        const sameProject =
          resolvePath(this.cg.getProjectRoot()) === resolvePath(cg.getProjectRoot());
        if (sameProject) cg = this.cg;
      } catch {
        /* getProjectRoot may throw on a closed instance — leave cg as is */
      }
    }

    // Defensive: some test fakes inject a partial CodeGraph stub without the
    // newer pending-files API. Treat missing/throwing as "no pending files."
    let pending: PendingFile[] = [];
    try {
      pending = cg.getPendingFiles?.() ?? [];
    } catch {
      return result;
    }
    if (pending.length === 0) return result;

    const [first, ...rest] = result.content;
    if (!first || first.type !== 'text') return result;

    const text = first.text;
    const inResponse: PendingFile[] = [];
    for (const p of pending) {
      // Substring match against the project-relative POSIX path — that's
      // exactly the format both the watcher and every codegraph response
      // emit, so a plain includes() is sufficient and avoids regex pitfalls.
      if (text.includes(p.path)) inResponse.push(p);
    }

    if (inResponse.length === 0) return result;

    const composed = [
      formatStaleBanner(inResponse, startupCatchUpPending),
      text,
    ].join('\n\n');
    return { ...result, content: [{ type: 'text', text: composed }, ...rest] };
  }

  /** Wait for the shared catch-up deadline and return the warning snapshot, if any. */
  private async awaitCatchUpBudget(): Promise<CatchUpAdmission | null> {
    // A retry initialization can replace the gate while a request is waiting.
    // Loop so that request also observes the newer generation.
    while (this.catchUpState) {
      const state = this.catchUpState;
      await state.release;
      if (this.catchUpState !== state) continue;
      if (state.status === 'complete') {
        this.catchUpState = null;
        return null;
      }
      return {
        status: state.status,
        startedAt: state.startedAt,
        budgetMs: state.budgetMs,
        error: state.error,
      };
    }
    return null;
  }

  /** Prefix a successful result whose request was released before catch-up completed. */
  private withCatchUpNotice(
    result: ToolResult,
    admission: CatchUpAdmission | null,
  ): ToolResult {
    if (!admission || result.isError) return result;
    const [first, ...rest] = result.content;
    if (!first || first.type !== 'text') return result;
    return {
      ...result,
      content: [{
        type: 'text',
        text: `${formatCatchUpNotice(admission)}\n\n${first.text}`,
      }, ...rest],
    };
  }

  /**
   * Execute a tool by name
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    options: ToolExecutionOptions = {},
  ): Promise<ToolResult> {
    return await this.executionSignal.run(
      options.signal,
      () => this.executeWithSignal(toolName, args),
    );
  }

  private async executeWithSignal(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      // Capture startup freshness immediately by default (or after an explicit
      // shared wait budget). This does not cancel sync; admission is attached
      // to this response even if catch-up finishes while the query is running,
      // because the query may already have observed the previous index state.
      const catchUpAdmission = await this.awaitCatchUpBudget();
      // Honor the optional tool allowlist (CODEGRAPH_MCP_TOOLS): a trimmed
      // surface rejects ablated tools defensively even if a client cached them.
      if (!this.isToolAllowed(toolName)) {
        return this.errorResult(`Tool ${toolName} is disabled via CODEGRAPH_MCP_TOOLS`);
      }
      // Cross-cutting input validation. All tools accept an optional
      // `projectPath` and most accept either `query`, `task`, or
      // `symbol` — bound their lengths centrally so individual handlers
      // can stay focused on tool-specific logic.
      const pathCheck = this.validateOptionalPath(args.projectPath, 'projectPath');
      if (typeof pathCheck === 'object' && pathCheck !== undefined) {
        return pathCheck;
      }
      // The `path` and `pattern` properties used by codegraph_files are
      // also path-shaped — apply the same cap.
      if (args.path !== undefined) {
        const check = this.validateOptionalPath(args.path, 'path');
        if (typeof check === 'object' && check !== undefined) return check;
      }
      if (args.pattern !== undefined) {
        const check = this.validateOptionalPath(args.pattern, 'pattern');
        if (typeof check === 'object' && check !== undefined) return check;
      }
      if (args.outlineQuery !== undefined) {
        const check = this.validateString(args.outlineQuery, 'outlineQuery', 256);
        if (typeof check !== 'string') return check;
      }

      // Read tools resolve through a single result variable so cross-cutting
      // notices — worktree-index mismatch (issue #155) and per-file
      // staleness (issue #403) — can be applied in one place. status embeds
      // its own verbose worktree warning but still flows through the
      // staleness wrapper so its pending-files section stays consistent
      // with what the read tools surface.
      let result: ToolResult;
      switch (toolName) {
        case 'search':
          result = await this.handleSearch(args); break;
        case 'context':
          result = await this.handleContext(args); break;
        case 'text_search':
          result = await this.handleTextSearch(args); break;
        case 'callers':
          result = await this.handleCallers(args); break;
        case 'callees':
          result = await this.handleCallees(args); break;
        case 'impact':
          result = await this.handleImpact(args); break;
        case 'explore':
          result = await this.handleExplore(args); break;
        case 'node':
          result = await this.handleNode(args); break;
        case 'status':
          // status embeds the pending-files list as a first-class section
          // (see handleStatus), so we skip the auto-banner wrapper here to
          // avoid duplicating the same info at the top of the response.
          return await this.handleStatus(args, catchUpAdmission);
        case 'files':
          result = await this.handleFiles(args); break;
        default:
          return this.errorResult(`Unknown tool: ${toolName}`);
      }
      const withWorktree = this.withWorktreeNotice(result, args.projectPath as string | undefined);
      const withFileStaleness = this.withStalenessNotice(
        withWorktree,
        args.projectPath as string | undefined,
        catchUpAdmission !== null,
      );
      return this.withCatchUpNotice(withFileStaleness, catchUpAdmission);
    } catch (err) {
      return this.errorResult(`Tool execution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Handle codegraph_search
   */
  private async handleSearch(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.queries === undefined) {
      if (args.query === undefined) return this.errorResult('Provide query for one symbol or queries for a batch of 1 to 8 symbols');
      return this.handleSearchSingle(args);
    }
    if (args.query !== undefined) return this.errorResult('codegraph_search cannot combine query with queries; choose single or batch mode');
    if (!Array.isArray(args.queries) || args.queries.length < 1 || args.queries.length > MCP_SEARCH_MAX_QUERIES) {
      return this.errorResult(`queries must contain 1 to ${MCP_SEARCH_MAX_QUERIES} symbol queries`);
    }

    const deferredRawEvidence: RawEvidenceSpec[] = [];
    const sections: Array<{ label: string; text: string }> = [];
    const defaults = { ...args };
    delete defaults.queries;
    for (let i = 0; i < args.queries.length; i++) {
      const raw = args.queries[i];
      const item = typeof raw === 'string'
        ? { query: raw }
        : raw && typeof raw === 'object' && !Array.isArray(raw)
          ? raw as Record<string, unknown>
          : null;
      if (!item) return this.errorResult(`queries[${i}] must be a string or query object`);
      const result = await this.handleSearchSingle({ ...defaults, ...item }, deferredRawEvidence);
      if (result.isError) return result;
      const queryLabel = typeof item.query === 'string' ? item.query : `queries[${i}]`;
      sections.push({
        label: queryLabel,
        text: `## ${queryLabel}\n\n${result.content.map((entry) => entry.text).join('\n')}`,
      });
    }

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const evidence = await this.renderRawEvidence(cg, deferredRawEvidence);
    const deduplicatedSections = this.dedupeBatchSourceBlocks(sections);
    const out = [
      `# Batch symbol search (${args.queries.length} queries)`,
      '',
      '> Exact resolution completed for all queries; true graph misses share one raw-source fallback scan below.',
      '',
      deduplicatedSections.join('\n\n---\n\n'),
      evidence,
    ].filter(Boolean).join('\n\n');
    return this.textResult(this.truncateOutput(out));
  }

  /** Remove repeated fenced source bodies across independent batch queries. */
  private dedupeBatchSourceBlocks(sections: Array<{ label: string; text: string }>): string[] {
    const seen = new Map<string, string>();
    return sections.map(({ label, text }) => text.replace(
      /```([^\r\n]*)\r?\n([\s\S]*?)\r?\n```/g,
      (block, language: string, body: string) => {
        const key = `${language.trim().toLowerCase()}\n${body.replace(/\r\n/g, '\n').trimEnd()}`;
        const firstLabel = seen.get(key);
        if (firstLabel !== undefined) {
          return `> Identical source already included for \`${firstLabel}\`; duplicate block omitted.`;
        }
        seen.set(key, label);
        return block;
      },
    ));
  }

  private async handleSearchSingle(
    args: Record<string, unknown>,
    deferredRawEvidence?: RawEvidenceSpec[],
  ): Promise<ToolResult> {
    const queryValue = this.validateString(args.query, 'query');
    if (typeof queryValue !== 'string') return queryValue;
    const queryText = queryValue.trim();
    const fuzzyEnabled = process.env.CODEGRAPH_SEARCH_FUZZY?.trim() === '1';
    const parsedQuery = parseCallableLookup(queryText);
    const implicitSignature = parsedQuery.signature;
    const query = parsedQuery.symbol;
    const signatureValue = args.signature === undefined
      ? implicitSignature
      : this.validateString(args.signature, 'signature', 1024);
    if (signatureValue !== undefined && typeof signatureValue !== 'string') return signatureValue;
    const signature = signatureValue?.trim() || undefined;
    if (args.signature !== undefined && !signature) return this.errorResult('signature must not be blank');
    let includeCode = args.includeCode === undefined ? 'never' : args.includeCode;
    let includeCodeCorrection = '';
    if (typeof includeCode === 'string') {
      const stripped = includeCode.trim().replace(/^["']+|["']+$/g, '');
      if ((stripped === 'never' || stripped === 'if_unique') && stripped !== includeCode) {
        includeCodeCorrection = `> Automatically corrected includeCode=${JSON.stringify(includeCode)} to ${JSON.stringify(stripped)}.`;
        includeCode = stripped;
      }
    }
    if (includeCode !== 'never' && includeCode !== 'if_unique') {
      return this.errorResult('includeCode must be "never" or "if_unique"');
    }

    // Fast-fail: reject natural-language queries so the agent corrects
    // course before the FTS→LIKE→fuzzy chain wastes time on bad input.
    const nlCheck = isNaturalLanguageQuery(query);
    if (nlCheck.isNatural) {
      return this.textResult([
        includeCodeCorrection,
        `codegraph_search 需要传入符号名，不支持自然语言描述或非符号内容。\n\n` +
        `收到的查询: "${query}"\n` +
        `检测到: ${nlCheck.reason}\n\n` +
        `→ 请从你的问题中提取关键符号名，直接搜索符号名。\n`,
      ].filter(Boolean).join('\n\n'));
    }

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const validatedPath = this.validateOptionalPath(args.path, 'path');
    if (validatedPath !== undefined && typeof validatedPath !== 'string') return validatedPath;
    const pathHint = validatedPath
      ? normalizePathForComparison(validatedPath) || undefined
      : undefined;
    const lineHint = typeof args.line === 'number' && Number.isInteger(args.line) && args.line > 0
      ? args.line
      : undefined;
    const kind = args.kind as string | undefined;
    const rawLimit = Number(args.limit) || 10;
    const limit = clamp(rawLimit, 1, 100);
    const kinds = kind ? [kind as NodeKind] : undefined;

    // Exact-first, fuzzy-fallback — mirrors findSymbolMatches / findAllSymbols
    // so the agent tool surface is internally consistent. A bare name is
    // resolved through the direct exact-name index (idx_nodes_name), NOT FTS:
    // FTS caps + BM25-ranks, so a heavily-overloaded name (tokio's `poll`,
    // 50+ defs) buries the wanted def below the fetch limit and the agent
    // Reads to find it. The direct index returns EVERY exact-name definition,
    // ranked (generated files down, definitions before declarations). Only
    // when fuzzy mode is enabled and no exact match exists do we try the
    // FTS→LIKE→edit-distance chain, flagged so the agent knows the candidates are
    // closest matches, not the queried name (no silent wrong-symbol surfacing).
    const isQualified = /[.\/]|::/.test(query);
    // Backward-compatible with small embedders/test doubles that implement
    // the pre-qualified-lookup CodeGraph surface only.
    let exactAll = typeof cg.getNodesBySymbolExact === 'function'
      ? cg.getNodesBySymbolExact(query)
      : isQualified
        ? []
        : cg.getNodesByName(query);
    let caseCorrected = false;
    if (exactAll.length === 0 && fuzzyEnabled) {
      exactAll = this.findCaseInsensitiveSymbolMatches(cg, query);
      caseCorrected = exactAll.length > 0;
    }
    const kindExact = exactAll.filter((node) => !kinds || kinds.includes(node.kind));
    const pathMatches = pathHint
      ? kindExact.filter((node) => pathContainsHint(node.filePath, pathHint))
      : kindExact;
    const pathMatched = !pathHint || pathMatches.length > 0;
    const pathFallback = Boolean(pathHint && kindExact.length > 0 && !pathMatched);
    let exact = pathHint && pathMatches.length > 0 ? pathMatches : kindExact;
    const lineSkippedForPathFallback = pathFallback && lineHint !== undefined;
    if (lineHint !== undefined && !lineSkippedForPathFallback) {
      exact = exact.filter((node) =>
        node.startLine <= lineHint && (node.endLine ?? node.startLine) >= lineHint
      );
    }
    const pathStatusNotice = pathHint && kindExact.length > 0
      ? pathMatched
        ? `> Path hint ${JSON.stringify(validatedPath)} matched ${pathMatches.length} of ${kindExact.length} exact candidate(s); that subset was ranked by path similarity.`
        : `> Path hint ${JSON.stringify(validatedPath)} matched no exact candidate; showing all ${kindExact.length} exact candidate(s) ranked by path similarity.`
      : '';
    const lineStatusNotice = lineSkippedForPathFallback
      ? `> Line hint ${lineHint} was not applied because the path hint matched no exact candidate.`
      : '';
    if (signature && exact.length > 0) {
      const signatureMatches = this.matchingNodesBySignature(exact, signature);
      if (signatureMatches.length === 0) {
        const candidates = this.rankSearchCandidatesByPath(exact, pathHint).slice(0, limit);
        const formatted = this.formatSearchResults(cg, candidates.map((node) => ({ node, score: 1.0 })));
        return this.textResult(this.truncateOutput([
          includeCodeCorrection,
          pathStatusNotice,
          lineStatusNotice,
          `> Signature hint did not match \`${signature}\`. No source was inlined and no overload was guessed.`,
          '',
          formatted,
          '',
          '> Raw-source fallback was skipped: exact structured symbol candidates already exist, so this is a signature assertion mismatch rather than a graph miss.',
          '',
          '> Copy one returned signature exactly, or use its path plus line.',
        ].join('\n')));
      }
      exact = signatureMatches;
    }
    if (exact.length > 0) {
      const ranked = this.rankSearchCandidatesByPath(
        this.preferContainerMatches(exact, lineHint, signature),
        pathHint,
      );
      const groups = this.relationshipOverloadGroups(cg, ranked, exactAll);
      const declarationOnly = ranked.some((node) =>
        node.isDeclaration === true && cppParameterKey(node) !== null &&
        this.indexedDefinitionForDeclaration(cg, node) === null
      );
      const declarationEvidenceNeedle = declarationOnly ? this.rawEvidenceNeedle(query) : undefined;
      const declarationEvidence = declarationEvidenceNeedle
        ? await this.renderSearchRawEvidence(cg, [{
          label: signature ?? queryText,
          needle: declarationEvidenceNeedle,
          purpose: 'declaration_only',
        }], deferredRawEvidence)
        : '';
      if (includeCode === 'if_unique' && groups.length === 1) {
        const primary = this.rankExactSymbolNodes(groups[0]!)[0]!;
        const section = await this.renderImplementationGroup(cg, groups[0]!, false);
        const correctionNotice = caseCorrected
          ? `> Case-insensitive unique correction: \`${queryText}\` → \`${primary.signature ?? displaySymbol(primary)}\`.`
          : '';
        const deliveryNotice = section.contentMode === 'source'
          ? '> Unique exact result; source included in this response.'
          : section.contentMode === 'source_truncated'
            ? '> Unique exact result; source included and safely truncated to the response budget.'
          : section.contentMode === 'outline'
            ? '> Unique exact result; a structural outline was explicitly requested.'
            : section.contentMode === 'mixed'
              ? '> Unique exact result; a mixed source/outline/metadata result was included.'
              : '> Unique exact result, but indexed source was unavailable; structural metadata is included.';
        return this.textResult(this.truncateOutput([
          includeCodeCorrection,
          correctionNotice,
          pathStatusNotice,
          lineStatusNotice,
          deliveryNotice,
          '',
          section.text,
          this.formatOtherOverloadSummary(cg, query, primary),
          declarationEvidence,
        ].filter(Boolean).join('\n')));
      }
      const total = ranked.length;
      const capped = ranked.slice(0, limit);
      const qualifier = isQualified ? 'qualified ' : '';
      const lineNote = lineHint !== undefined && !lineSkippedForPathFallback ? ` at line ${lineHint}` : '';
      const caseNote = caseCorrected
        ? `\n\n> Case-insensitive exact-name correction applied for "${queryText}".`
        : '';
      const sourceNote = includeCode === 'if_unique' && groups.length > 1
        ? `\n\n> Source was not inlined because ${groups.length} distinct logical symbols/overloads remain; use a matching path hint, line, or signature to make the target unique. A path miss keeps all exact candidates visible.`
        : '';
      const note = total > limit
        ? `\n\n> Showing ${capped.length} of ${total} exact ${qualifier}matches${lineNote}. Raise \`limit\`, provide a closer path hint, or use line/signature to see the intended symbol.`
        : '';
      const formatted = this.formatSearchResults(cg, capped.map((node) => ({ node, score: 1.0 })));
      return this.textResult(this.truncateOutput([
        includeCodeCorrection,
        pathStatusNotice,
        lineStatusNotice,
        formatted + caseNote + sourceNote + note,
        declarationEvidence,
      ].filter(Boolean).join('\n\n')));
    }

    if (!fuzzyEnabled) {
      // A kind/line constraint can exclude an indexed exact symbol. That is
      // not a graph miss and must not trigger an absence scan or suggestions.
      if (exactAll.length > 0) {
        return this.textResult([
          includeCodeCorrection,
          pathStatusNotice,
          lineStatusNotice,
          `No exact matches for "${query}" satisfy the requested kind/line constraints.`,
        ].filter(Boolean).join('\n\n'));
      }
      const needle = this.rawEvidenceNeedle(query);
      const evidence = needle
        ? await this.renderSearchRawEvidence(cg, [{ label: queryText, needle }], deferredRawEvidence)
        : '';
      return this.textResult([
        includeCodeCorrection,
        `No exact, case-sensitive match found in the indexed graph for "${query}".`,
        evidence,
      ].filter(Boolean).join('\n\n'));
    }

    // A qualified query is already an explicit disambiguation request. Never
    // silently degrade it to an unrelated fuzzy symbol.
    if (isQualified) {
      const ownerRecovery = await this.renderQualifiedOwnerRecovery(
        cg,
        queryText,
        query,
        kinds,
        pathHint,
        validatedPath,
        lineHint,
        signature,
        limit,
        includeCode === 'if_unique',
      );
      if (ownerRecovery) {
        return this.textResult(this.truncateOutput([includeCodeCorrection, ownerRecovery].filter(Boolean).join('\n\n')));
      }
      const needle = this.rawEvidenceNeedle(query);
      const evidence = needle
        ? await this.renderSearchRawEvidence(cg, [{ label: queryText, needle }], deferredRawEvidence)
        : '';
      return this.textResult([includeCodeCorrection, `No results found in the indexed graph for "${query}"`, evidence].filter(Boolean).join('\n\n'));
    }

    // No exact bare-name match — fuzzy fallback, visibly labelled.
    const fuzzy = cg.searchNodes(query, {
      limit,
      kinds,
      line: pathHint ? undefined : lineHint,
      pathHint,
    });
    if (fuzzy.length === 0) {
      const needle = this.rawEvidenceNeedle(query);
      const evidence = needle
        ? await this.renderSearchRawEvidence(cg, [{ label: queryText, needle }], deferredRawEvidence)
        : '';
      return this.textResult([includeCodeCorrection, `No results found in the indexed graph for "${query}"`, evidence].filter(Boolean).join('\n\n'));
    }
    const pathRankingNote = pathHint
      ? `\n> Path hint ${JSON.stringify(validatedPath)} was used as a secondary ranking signal; it did not filter fuzzy candidates.`
      : '';
    const note = `\n\n> ⚠️ No exact match for "${query}". Showing closest matches:${pathRankingNote}`;
    const formatted = this.formatSearchResults(cg, this.rankSearchResults(fuzzy, pathHint));
    const needle = exactAll.length === 0 ? this.rawEvidenceNeedle(query) : undefined;
    const evidence = needle
      ? await this.renderSearchRawEvidence(cg, [{ label: `exact identifier behind fuzzy results: ${queryText}`, needle }], deferredRawEvidence)
      : '';
    return this.textResult(this.truncateOutput([
      includeCodeCorrection,
      note + '\n' + formatted,
      evidence,
    ].filter(Boolean).join('\n\n')));
  }

  /**
   * Exact, bounded multi-symbol context for implementation tasks whose target
   * symbols are already named. This avoids N separate codegraph_node calls and
   * deliberately omits repetitive relation trails unless explicitly requested.
   */
  private async handleContext(args: Record<string, unknown>): Promise<ToolResult> {
    const corrections: string[] = [];
    const expand = args.expand === undefined ? 'declaration_definition' : args.expand;
    if (expand !== 'declaration_definition' && expand !== 'none') {
      return this.errorResult('expand must be "declaration_definition" or "none"');
    }
    const expectedMissing: string[] = [];
    if (args.expectedMissing !== undefined) {
      if (!Array.isArray(args.expectedMissing) || args.expectedMissing.length < 1 ||
          args.expectedMissing.length > MCP_CONTEXT_MAX_EXPECTED_MISSING) {
        return this.errorResult(`expectedMissing must contain 1 to ${MCP_CONTEXT_MAX_EXPECTED_MISSING} exact identifiers`);
      }
      for (let i = 0; i < args.expectedMissing.length; i++) {
        const value = this.validateString(args.expectedMissing[i], `expectedMissing[${i}]`, 256);
        if (typeof value !== 'string') return value;
        const identifier = value.trim();
        if (!identifier) return this.errorResult(`expectedMissing[${i}] must not be blank`);
        if (!isExactSymbolLookup(identifier)) {
          return this.errorResult(`expectedMissing[${i}] must be an exact identifier, qualified name, or callable signature`);
        }
        expectedMissing.push(identifier);
      }
    }
    let rawTargetsValue = args.targets;
    if (typeof rawTargetsValue === 'string') {
      if (rawTargetsValue.length > 32_000) {
        return this.errorResult('targets JSON string is too long');
      }
      const source = rawTargetsValue.trim();
      let parsed: unknown;
      let repaired = false;
      try {
        parsed = JSON.parse(source);
      } catch {
        // Common tool-serialization typo observed in OpenCode/GLM output:
        // `[{"file":"x", offset":1}]`. Repair only an unquoted identifier
        // key that still has its closing quote, then require valid JSON.
        const repairedSource = source.replace(
          /([,{]\s*)([A-Za-z_$][\w$]*)"\s*:/g,
          '$1"$2":',
        );
        if (repairedSource !== source) {
          try {
            parsed = JSON.parse(repairedSource);
            repaired = true;
          } catch { /* handled below */ }
        }
      }
      if (!Array.isArray(parsed)) {
        return this.errorResult('targets must be an array of 1 to 8 precise symbol or file objects; a JSON string is accepted only when it decodes to that array');
      }
      rawTargetsValue = parsed;
      corrections.push(repaired
        ? 'parsed JSON-stringified targets and repaired a missing opening quote on an object key'
        : 'parsed JSON-stringified targets');
    }
    if (!Array.isArray(rawTargetsValue)) {
      return this.errorResult('targets must be an array of 1 to 8 precise symbol or file objects');
    }
    const rawTargets = rawTargetsValue;
    if (rawTargets.length < 1 || rawTargets.length > MCP_CONTEXT_MAX_TARGETS) {
      return this.errorResult(`targets must contain 1 to ${MCP_CONTEXT_MAX_TARGETS} precise requests`);
    }

    const targets: ContextTarget[] = [];
    for (let i = 0; i < rawTargets.length; i++) {
      const raw = rawTargets[i];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return this.errorResult(`targets[${i}] must be an object`);
      }
      const target = raw as Record<string, unknown>;
      const file = this.validateOptionalPath(target.file, `targets[${i}].file`);
      if (file !== undefined && typeof file !== 'string') return file;
      if (typeof file === 'string' && file.trim().length === 0) {
        return this.errorResult(`targets[${i}].file must not be blank`);
      }
      const symbolValue = target.symbol === undefined
        ? undefined
        : this.validateString(target.symbol, `targets[${i}].symbol`, 512);
      if (symbolValue !== undefined && typeof symbolValue !== 'string') return symbolValue;
      const symbolText = symbolValue?.trim() || '';

      if (symbolText) {
        if (target.offset !== undefined || target.limit !== undefined || target.text !== undefined ||
            target.texts !== undefined || target.symbols !== undefined ||
            target.contextLines !== undefined || target.maxMatches !== undefined ||
            target.symbolsOnly !== undefined || target.outlineQuery !== undefined ||
            target.outlineQueries !== undefined || target.outlineLimit !== undefined) {
          return this.errorResult(`targets[${i}] mixes symbol mode with file-window/text mode`);
        }
        if (target.line !== undefined &&
            (typeof target.line !== 'number' || !Number.isInteger(target.line) || target.line < 1)) {
          return this.errorResult(`targets[${i}].line must be a positive integer`);
        }
        const parsedSymbol = parseCallableLookup(symbolText);
        const implicitSignature = parsedSymbol.signature;
        const symbol = parsedSymbol.symbol;
        const signature = target.signature === undefined
          ? implicitSignature
          : this.validateString(target.signature, `targets[${i}].signature`, 1024);
        if (signature !== undefined && typeof signature !== 'string') return signature;
        if (typeof signature === 'string' && signature.trim().length === 0) {
          return this.errorResult(`targets[${i}].signature must not be blank`);
        }
        let members: string[] | undefined;
        if (target.members !== undefined) {
          if (!Array.isArray(target.members) || target.members.length < 1 || target.members.length > MCP_CONTEXT_MAX_MEMBERS) {
            return this.errorResult(`targets[${i}].members must contain 1 to ${MCP_CONTEXT_MAX_MEMBERS} names`);
          }
          members = [];
          for (let j = 0; j < target.members.length; j++) {
            const member = this.validateString(target.members[j], `targets[${i}].members[${j}]`, 256);
            if (typeof member !== 'string') return member;
            if (!member.trim()) return this.errorResult(`targets[${i}].members[${j}] must not be blank`);
            members.push(member.trim());
          }
        }
        targets.push({
          mode: 'symbol',
          symbol,
          file: file?.trim() || undefined,
          line: target.line as number | undefined,
          signature: signature?.trim() || undefined,
          members,
        });
        continue;
      }

      const fileText = file?.trim();
      if (!fileText) return this.errorResult(`targets[${i}] requires either symbol or file`);
      if (target.signature !== undefined || target.line !== undefined || target.members !== undefined) {
        return this.errorResult(`targets[${i}] uses symbol-only hints without a symbol`);
      }
      if (target.symbolsOnly !== undefined && typeof target.symbolsOnly !== 'boolean') {
        return this.errorResult(`targets[${i}].symbolsOnly must be a boolean`);
      }
      const outlineQueries: string[] = [];
      if (target.outlineQuery !== undefined) {
        const value = this.validateString(target.outlineQuery, `targets[${i}].outlineQuery`, 256);
        if (typeof value !== 'string') return value;
        for (const token of value.split('|').map((part) => part.trim()).filter(Boolean)) {
          if (!outlineQueries.includes(token)) outlineQueries.push(token);
        }
      }
      if (target.outlineQueries !== undefined) {
        if (!Array.isArray(target.outlineQueries) || target.outlineQueries.length < 1 || target.outlineQueries.length > 8) {
          return this.errorResult(`targets[${i}].outlineQueries must contain 1 to 8 filters`);
        }
        for (let j = 0; j < target.outlineQueries.length; j++) {
          const value = this.validateString(target.outlineQueries[j], `targets[${i}].outlineQueries[${j}]`, 256);
          if (typeof value !== 'string') return value;
          const token = value.trim();
          if (!token) return this.errorResult(`targets[${i}].outlineQueries[${j}] must not be blank`);
          if (!outlineQueries.includes(token)) outlineQueries.push(token);
        }
      }
      if (outlineQueries.length > 8) return this.errorResult(`targets[${i}] has more than 8 outline filters after expanding outlineQuery OR terms`);
      if (target.outlineLimit !== undefined &&
          (typeof target.outlineLimit !== 'number' || !Number.isInteger(target.outlineLimit) || target.outlineLimit < 1)) {
        return this.errorResult(`targets[${i}].outlineLimit must be a positive integer`);
      }
      let symbols: Array<{ symbol: string; signature?: string }> | undefined;
      if (target.symbols !== undefined) {
        if (!Array.isArray(target.symbols) || target.symbols.length < 1 || target.symbols.length > MCP_CONTEXT_MAX_FILE_SYMBOLS) {
          return this.errorResult(`targets[${i}].symbols must contain 1 to ${MCP_CONTEXT_MAX_FILE_SYMBOLS} exact names or signatures`);
        }
        symbols = [];
        for (let j = 0; j < target.symbols.length; j++) {
          const value = this.validateString(target.symbols[j], `targets[${i}].symbols[${j}]`, 1024);
          if (typeof value !== 'string') return value;
          const text = value.trim();
          if (!text) return this.errorResult(`targets[${i}].symbols[${j}] must not be blank`);
          const parsed = parseCallableLookup(text);
          if (!isExactSymbolLookup(text)) {
            return this.errorResult(`targets[${i}].symbols[${j}] must be an exact symbol name or callable signature, not natural language`);
          }
          symbols.push({ symbol: parsed.symbol, signature: parsed.signature });
        }
      }
      const textValue = target.text === undefined
        ? undefined
        : this.validateString(target.text, `targets[${i}].text`, 1024);
      if (textValue !== undefined && typeof textValue !== 'string') return textValue;
      const text = textValue?.trim() || undefined;
      let texts: string[] | undefined;
      if (target.texts !== undefined) {
        if (!Array.isArray(target.texts) || target.texts.length < 1 || target.texts.length > MCP_CONTEXT_MAX_FILE_TEXTS) {
          return this.errorResult(`targets[${i}].texts must contain 1 to ${MCP_CONTEXT_MAX_FILE_TEXTS} literals`);
        }
        if (text) return this.errorResult(`targets[${i}] cannot combine text with texts`);
        texts = [];
        for (let j = 0; j < target.texts.length; j++) {
          const value = this.validateString(target.texts[j], `targets[${i}].texts[${j}]`, 1024);
          if (typeof value !== 'string') return value;
          const literal = value.trim();
          if (!literal) return this.errorResult(`targets[${i}].texts[${j}] must not be blank`);
          texts.push(literal);
        }
      }
      let effectiveOffset = target.offset;
      const effectiveLimit = target.limit;
      const hasManifest = Boolean(symbols?.length || texts?.length);
      if (!text && !hasManifest && effectiveOffset === undefined && effectiveLimit !== undefined) {
        effectiveOffset = 1;
        corrections.push(`targets[${i}]: defaulted missing file-window offset to 1`);
      }
      const hasWindow = effectiveOffset !== undefined || effectiveLimit !== undefined;
      // Models commonly add a literal anchor to an already precise region.
      // That is redundant, not ambiguous: preserve the explicit edit window
      // and use the singular text as an assertion about its contents. Grouped
      // manifests remain incompatible with a raw range because their items
      // independently determine the returned ranges.
      const textAsWindowAssertion = Boolean(text && hasWindow && !hasManifest);
      if (hasManifest && hasWindow) return this.errorResult(`targets[${i}] cannot combine symbols/texts with offset/limit`);
      const requestedOutline = target.symbolsOnly === true || outlineQueries.length > 0 || target.outlineLimit !== undefined;
      if (requestedOutline && (text || hasManifest || hasWindow)) {
        return this.errorResult(`targets[${i}] cannot combine outline controls with symbols/text/window mode`);
      }
      const outline = requestedOutline || (!text && !hasManifest && !hasWindow);
      if (outline && !requestedOutline) corrections.push(`targets[${i}]: treated bare file as a compact symbol outline`);
      if (outline && requestedOutline && target.symbolsOnly !== true) corrections.push(`targets[${i}]: inferred symbolsOnly=true from outline filters/limit`);
      if (hasWindow &&
          (typeof effectiveOffset !== 'number' || !Number.isInteger(effectiveOffset) || effectiveOffset < 1 ||
           typeof effectiveLimit !== 'number' || !Number.isInteger(effectiveLimit) || effectiveLimit < 1)) {
        return this.errorResult(`targets[${i}] requires positive integer offset and limit`);
      }
      if (target.contextLines !== undefined &&
          (typeof target.contextLines !== 'number' || !Number.isInteger(target.contextLines) || target.contextLines < 0)) {
        return this.errorResult(`targets[${i}].contextLines must be a non-negative integer`);
      }
      if (target.maxMatches !== undefined &&
          (typeof target.maxMatches !== 'number' || !Number.isInteger(target.maxMatches) || target.maxMatches < 1)) {
        return this.errorResult(`targets[${i}].maxMatches must be a positive integer`);
      }
      if (textAsWindowAssertion) {
        corrections.push(`targets[${i}]: kept the explicit file window and treated text as a window assertion`);
      }
      targets.push({
        mode: 'file',
        file: fileText,
        outline,
        outlineQueries: outlineQueries.length > 0 ? outlineQueries : undefined,
        outlineLimit: target.outlineLimit === undefined
          ? undefined
          : clamp(target.outlineLimit as number, 1, MCP_NODE_MAX_OUTLINE_SYMBOLS),
        symbols,
        texts,
        offset: effectiveOffset as number | undefined,
        limit: effectiveLimit === undefined
          ? undefined
          : Math.min(effectiveLimit as number, MCP_CONTEXT_MAX_FILE_WINDOW_LINES),
        text,
        textAsWindowAssertion,
        contextLines: clamp((target.contextLines as number | undefined) ?? 20, 0, MCP_CONTEXT_MAX_TEXT_CONTEXT_LINES),
        maxMatches: clamp((target.maxMatches as number | undefined) ?? 1, 1, MCP_CONTEXT_MAX_TEXT_MATCHES),
      });
    }

    const outlineTargets = targets.filter((target): target is ContextFileTarget =>
      target.mode === 'file' && target.outline
    );
    if (outlineTargets.length > 0) {
      const perFileLimit = clamp(
        Math.floor(MCP_CONTEXT_MAX_OUTLINE_SYMBOLS_TOTAL / outlineTargets.length),
        8,
        MCP_CONTEXT_MAX_OUTLINE_SYMBOLS_PER_FILE,
      );
      for (const target of outlineTargets) {
        target.outlineLimit = Math.min(target.outlineLimit ?? perFileLimit, perFileLimit);
      }
    }

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const includeRelations = args.includeRelations === true;
    const sectionCandidates: ContextSectionCandidate[] = [];
    const misses: string[] = [];
    const rawEvidenceSpecs: RawEvidenceSpec[] = [];
    const fileRanges = new Map<string, { file: ResolvedIndexedFile; ranges: ContextFileRange[]; targetIndexes: Set<number> }>();
    const resolvedTargets = new Set<number>();
    const addNodeRange = (node: Node, label: string, targetIndex: number) => {
      if (CONFIG_LEAF_LANGUAGES.has(node.language)) return;
      const file: ResolvedIndexedFile = { path: node.filePath, language: node.language };
      const entry = fileRanges.get(file.path) ?? { file, ranges: [], targetIndexes: new Set<number>() };
      entry.ranges.push({ start: node.startLine, end: node.endLine, labels: [label] });
      entry.targetIndexes.add(targetIndex);
      fileRanges.set(file.path, entry);
    };
    for (const expected of expectedMissing) {
      const parsed = parseCallableLookup(expected);
      const exact = typeof cg.getNodesBySymbolExact === 'function'
        ? cg.getNodesBySymbolExact(parsed.symbol)
        : cg.getNodesByName(parsed.symbol);
      if (exact.length > 0) {
        misses.push(`- expected-new \`${expected}\`: already exists as ${exact.length} indexed symbol node(s)`);
      }
      const needle = this.rawEvidenceNeedle(parsed.symbol);
      if (needle) rawEvidenceSpecs.push({ label: `expected-new: ${expected}`, needle });
    }

    for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
      const target = targets[targetIndex]!;
      if (target.mode === 'file') {
        const resolved = this.resolveIndexedFile(cg, target.file);
        if ('result' in resolved) {
          misses.push(`- file \`${target.file}\`: ${resolved.result}`);
          continue;
        }
        if (target.outline) {
          const outlineResult = await this.handleFileView(cg, resolved.file.path, {
            symbolsOnly: true,
            outlineLimit: target.outlineLimit,
            outlineQueries: target.outlineQueries,
            notice: '> Automatically converted bare context file target to a compact symbol outline; no source was dumped.',
          });
          const section = outlineResult.content.map((item) => item.text).join('\n');
          sectionCandidates.push({
            label: `outline \`${resolved.file.path}\``,
            section,
            estimatedChars: section.length,
            targetIndexes: new Set([targetIndex]),
            file: resolved.file,
          });
          resolvedTargets.add(targetIndex);
          continue;
        }
        let resolvedAnyManifestItem = false;
        if (target.symbols?.length) {
          for (const wanted of target.symbols) {
            let allMatches = typeof cg.getNodesBySymbolExact === 'function'
              ? cg.getNodesBySymbolExact(wanted.symbol)
              : cg.getNodesByName(wanted.symbol);
            if (allMatches.length === 0) allMatches = this.findCaseInsensitiveSymbolMatches(cg, wanted.symbol);
            if (allMatches.length === 0) {
              const label = wanted.signature ?? wanted.symbol;
              misses.push(`- symbol \`${label}\` expected in ${resolved.file.path}: not found in the graph`);
              const needle = this.rawEvidenceNeedle(wanted.symbol);
              if (needle) rawEvidenceSpecs.push({ label, needle, path: resolved.file.path });
              continue;
            }
            const narrowed = this.narrowSymbolMatches(allMatches, resolved.file.path, undefined);
            if (!narrowed.fileMatched) {
              const label = wanted.signature ?? wanted.symbol;
              misses.push(`- symbol \`${label}\`: exact candidates exist, but none in ${resolved.file.path}`);
              const needle = this.rawEvidenceNeedle(wanted.symbol);
              if (needle) rawEvidenceSpecs.push({ label, needle, path: resolved.file.path });
              continue;
            }
            let selected = this.preferContainerMatches(narrowed.matches, undefined, wanted.signature);
            selected = this.narrowMatchesBySignature(selected, wanted.signature);
            if (selected.length === 0) {
              const label = wanted.signature ?? wanted.symbol;
              misses.push(`- symbol \`${label}\` in ${resolved.file.path}: signature did not match any exact candidate`);
              const needle = this.rawEvidenceNeedle(wanted.symbol);
              if (needle) rawEvidenceSpecs.push({ label, needle, path: resolved.file.path });
              continue;
            }
            const expanded = expand === 'declaration_definition'
              ? this.relationshipOverloadGroups(cg, selected, allMatches).flat()
              : selected;
            if (expanded.some((node) =>
              node.isDeclaration === true && cppParameterKey(node) !== null &&
              this.indexedDefinitionForDeclaration(cg, node) === null
            )) {
              const needle = this.rawEvidenceNeedle(wanted.symbol);
              if (needle) rawEvidenceSpecs.push({
                label: `declaration-only: ${wanted.signature ?? wanted.symbol}`,
                needle,
                purpose: 'declaration_only',
              });
            }
            const seen = new Set<string>();
            for (const node of expanded) {
              if (seen.has(node.id)) continue;
              seen.add(node.id);
              addNodeRange(node, `manifest symbol: ${wanted.signature ?? wanted.symbol}`, targetIndex);
            }
            resolvedAnyManifestItem = true;
          }
        }
        const requestedTexts = target.texts ?? (target.text ? [target.text] : []);
        const needsCurrentFile = requestedTexts.length > 0 ||
          (target.offset !== undefined && target.limit !== undefined);
        if (!needsCurrentFile) {
          if (resolvedAnyManifestItem) resolvedTargets.add(targetIndex);
          continue;
        }
        if (CONFIG_LEAF_LANGUAGES.has(resolved.file.language)) {
          misses.push(`- file \`${resolved.file.path}\`: configuration/data values are withheld; read it directly only if a value is required`);
          if (resolvedAnyManifestItem) resolvedTargets.add(targetIndex);
          continue;
        }
        const abs = validatePathWithinRoot(cg.getProjectRoot(), resolved.file.path);
        let content: string | null = null;
        if (abs) {
          try { content = readFileSync(abs, 'utf-8'); } catch { content = null; }
        }
        if (content === null) {
          misses.push(`- file \`${resolved.file.path}\`: current source could not be read`);
          if (resolvedAnyManifestItem) resolvedTargets.add(targetIndex);
          continue;
        }
        const lines = content.split('\n');
        const ranges: ContextFileRange[] = [];
        if (target.textAsWindowAssertion) {
          const start = target.offset!;
          const rawTarget = rawTargets[targetIndex] as Record<string, unknown>;
          const requestedLimit = rawTarget.limit as number;
          if (start > lines.length) {
            misses.push(`- window ${resolved.file.path}:${start}: offset is past EOF (${lines.length})`);
            continue;
          }
          const end = Math.min(lines.length, start + target.limit! - 1);
          const asserted = requestedTexts[0]!;
          const matched = lines.slice(start - 1, end).some((line) => line.includes(asserted));
          ranges.push({
            start,
            end,
            labels: [
              `requested window${requestedLimit > MCP_CONTEXT_MAX_FILE_WINDOW_LINES ? `; safely clamped to ${MCP_CONTEXT_MAX_FILE_WINDOW_LINES} lines` : ''}`,
              matched ? `text assertion matched: ${asserted}` : `text assertion NOT present in this window: ${asserted}`,
            ],
          });
          if (!matched) {
            misses.push(`- text assertion \`${asserted}\` is not present in requested window ${resolved.file.path}:${start}-${end}; the explicit window was returned unchanged`);
          }
        } else if (requestedTexts.length > 0) {
          for (const wanted of requestedTexts) {
            const matched: number[] = [];
            for (let line = 0; line < lines.length && matched.length < target.maxMatches; line++) {
              if (lines[line]!.includes(wanted)) matched.push(line + 1);
            }
            if (matched.length === 0) {
              misses.push(`- text \`${wanted}\` in ${resolved.file.path}: CONFIRMED_ABSENT in the complete current file`);
              continue;
            }
            for (const line of matched) {
              ranges.push({
                start: Math.max(1, line - target.contextLines),
                end: Math.min(lines.length, line + target.contextLines),
                labels: [`text: ${wanted}`],
              });
            }
          }
        } else {
          const start = target.offset!;
          const rawTarget = rawTargets[targetIndex] as Record<string, unknown>;
          const requestedLimit = rawTarget.limit as number;
          if (start > lines.length) {
            misses.push(`- window ${resolved.file.path}:${start}: offset is past EOF (${lines.length})`);
            continue;
          }
          ranges.push({
            start,
            end: Math.min(lines.length, start + target.limit! - 1),
            labels: [`requested window${requestedLimit > MCP_CONTEXT_MAX_FILE_WINDOW_LINES ? `; safely clamped to ${MCP_CONTEXT_MAX_FILE_WINDOW_LINES} lines` : ''}`],
          });
        }
        if (ranges.length > 0) {
          const entry = fileRanges.get(resolved.file.path) ?? { file: resolved.file, ranges: [], targetIndexes: new Set<number>() };
          entry.ranges.push(...ranges);
          entry.targetIndexes.add(targetIndex);
          fileRanges.set(resolved.file.path, entry);
          resolvedAnyManifestItem = true;
        }
        if (resolvedAnyManifestItem) resolvedTargets.add(targetIndex);
        continue;
      }

      const allMatches = this.findSymbolMatches(cg, target.symbol);
      let matches = allMatches;
      const narrowed = this.narrowSymbolMatches(matches, target.file, target.line);
      matches = narrowed.matches;
      matches = this.preferContainerMatches(matches, target.line, target.signature);
      matches = this.narrowMatchesBySignature(matches, target.signature);
      if (matches.length === 0) {
        misses.push(`- \`${target.symbol}\`${target.file ? ` in ${target.file}` : ''}: not found`);
        const needle = this.rawEvidenceNeedle(target.symbol);
        if (needle) rawEvidenceSpecs.push({ label: target.signature ?? target.symbol, needle, path: target.file });
        continue;
      }

      if (target.members?.length) {
        // A full C/C++ class definition and its forward declarations share the
        // same exact symbol/qualified name. Member focus needs the definition's
        // containment range, so select it automatically when it is the only
        // concrete container. Keep true multiple definitions ambiguous.
        if (narrowed.fileMatched && narrowed.lineMatched && matches.length > 1) {
          const concreteContainers = matches.filter((node) =>
            CONTAINER_NODE_KINDS.has(node.kind) && node.isDeclaration !== true
          );
          if (concreteContainers.length === 1) matches = concreteContainers;
        }
        if (matches.length !== 1 || !CONTAINER_NODE_KINDS.has(matches[0]!.kind)) {
          misses.push(`- \`${target.symbol}\` members: container target is not unique`);
          continue;
        }
        const container = matches[0]!;
        const fileNodes = cg.getNodesInFile(container.filePath).filter((node) =>
          node.id !== container.id &&
          node.startLine >= container.startLine && node.endLine <= container.endLine
        );
        const missingMembers: string[] = [];
        let foundAnyMember = false;
        for (const wanted of target.members) {
          let localMatches = fileNodes.filter((node) => node.name === wanted);
          let corrected = false;
          if (localMatches.length === 0) {
            const insensitive = fileNodes.filter((node) => node.name.toLowerCase() === wanted.toLowerCase());
            if (insensitive.length > 0) {
              localMatches = insensitive;
              corrected = true;
            }
          }
          if (localMatches.length === 0) {
            missingMembers.push(wanted);
            const needle = this.rawEvidenceNeedle(wanted);
            if (needle) rawEvidenceSpecs.push({
              label: `${displaySymbol(container)}::${wanted}`,
              needle,
              path: target.file,
            });
            continue;
          }

          // Include out-of-line definitions that belong to the declarations in
          // this container. This is the key C++ call-saving path: one member
          // target returns the header declaration and .cpp implementation.
          const actualNames = [...new Set(localMatches.map((node) => node.name))];
          const memberMatches = [...localMatches];
          const selectedIds = new Set(memberMatches.map((node) => node.id));
          for (const actualName of actualNames) {
            for (const candidate of this.findSymbolMatches(cg, actualName)) {
              const sameQualifiedMember = localMatches.some((local) =>
                (candidate.language === 'cpp' && local.language === 'cpp'
                  ? cppCallableOwnersMatch(candidate, local)
                  : candidate.filePath === local.filePath && candidate.qualifiedName === local.qualifiedName)
              );
              if (sameQualifiedMember && !selectedIds.has(candidate.id)) {
                selectedIds.add(candidate.id);
                memberMatches.push(candidate);
              }
            }
          }

          if (memberMatches.some((node) =>
            node.isDeclaration === true && cppParameterKey(node) !== null &&
            this.indexedDefinitionForDeclaration(cg, node) === null
          )) {
            const needle = this.rawEvidenceNeedle(wanted);
            if (needle) rawEvidenceSpecs.push({
              label: `declaration-only: ${displaySymbol(container)}::${wanted}`,
              needle,
              purpose: 'declaration_only',
            });
          }

          for (const member of memberMatches) {
            if (CONFIG_LEAF_LANGUAGES.has(member.language)) continue;
            const file: ResolvedIndexedFile = { path: member.filePath, language: member.language };
            const entry = fileRanges.get(file.path) ?? { file, ranges: [], targetIndexes: new Set<number>() };
            if (member.filePath === container.filePath) {
              const accessLine = this.findCppAccessBoundaryLine(cg, container, member.startLine);
              if (accessLine !== undefined) {
                entry.ranges.push({
                  start: accessLine,
                  end: accessLine,
                  labels: [`access boundary for member: ${wanted}`],
                });
              }
            }
            entry.ranges.push({
              start: Math.max(1, member.startLine - MCP_CONTEXT_MEMBER_NEIGHBOR_LINES),
              end: member.endLine + MCP_CONTEXT_MEMBER_NEIGHBOR_LINES,
              labels: [`member: ${wanted}${corrected ? ` → ${member.name}` : ''}; includes edit-ready comments/neighbors`],
            });
            entry.targetIndexes.add(targetIndex);
            fileRanges.set(file.path, entry);
            foundAnyMember = true;
          }
        }
        if (!foundAnyMember) {
          misses.push(`- \`${target.symbol}\` members: none found (${missingMembers.join(', ')})`);
          continue;
        }
        if (missingMembers.length > 0) misses.push(`- \`${target.symbol}\` members not found: ${missingMembers.join(', ')}`);
        resolvedTargets.add(targetIndex);
        continue;
      }

      let section: string;
      if (matches.some((node) =>
        node.isDeclaration === true && cppParameterKey(node) !== null &&
        this.indexedDefinitionForDeclaration(cg, node) === null
      )) {
        const needle = this.rawEvidenceNeedle(target.symbol);
        if (needle) rawEvidenceSpecs.push({
          label: `declaration-only: ${target.signature ?? target.symbol}`,
          needle,
          purpose: 'declaration_only',
        });
      }
      const overloadGroups = this.relationshipOverloadGroups(cg, matches, allMatches);
      if (overloadGroups.length === 1) {
        const selected = this.rankExactSymbolNodes(overloadGroups[0]!)[0]!;
        const implementation = await this.renderImplementationGroup(cg, overloadGroups[0]!, includeRelations);
        section = [
          implementation.text,
          this.formatOtherOverloadSummary(cg, target.symbol, selected),
        ].filter(Boolean).join('\n\n');
      } else {
        section = await this.renderContextOverloads(cg, target.symbol, matches, includeRelations);
      }
      const hintWarning = this.formatSymbolHintWarning(target.symbol, narrowed);
      if (hintWarning) section = `${hintWarning}\n\n${section}`;
      const estimatedChars = section.length;
      if (section.length > MCP_CONTEXT_MAX_CHARS_PER_TARGET) {
        section = this.truncateAtLine(section, MCP_CONTEXT_MAX_CHARS_PER_TARGET) +
          '\n\n... (target truncated; omitted overload locations are listed above when space permits; use `signature` or `file`/`line` only if the missing body is required)';
      }
      sectionCandidates.push({
        label: `symbol \`${target.symbol}\``,
        section,
        estimatedChars,
        targetIndexes: new Set([targetIndex]),
      });
      resolvedTargets.add(targetIndex);
    }

    for (const entry of fileRanges.values()) {
      let section = this.renderContextFileRanges(cg, entry.file, entry.ranges);
      const estimatedChars = section.length;
      const explicitWindowOnly = [...entry.targetIndexes].every((targetIndex) => {
        const target = targets[targetIndex];
        return target?.mode === 'file' && target.offset !== undefined && target.limit !== undefined;
      });
      if (!explicitWindowOnly && section.length > MCP_CONTEXT_MAX_CHARS_PER_TARGET * 1.5) {
        section = this.truncateAtLine(section, Math.floor(MCP_CONTEXT_MAX_CHARS_PER_TARGET * 1.5)) +
          '\n\n... (precise file batch truncated by the per-file budget; narrow only the missing range)';
      }
      sectionCandidates.push({
        label: `file \`${entry.file.path}\``,
        section,
        estimatedChars,
        targetIndexes: new Set(entry.targetIndexes),
        file: entry.file,
        ranges: entry.ranges,
      });
    }

    const estimatedOutputChars = sectionCandidates.reduce((total, candidate) => total + candidate.estimatedChars, 0) +
      Math.max(0, sectionCandidates.length - 1) * 7;
    const fileWindowTargets = targets.filter((target): target is ContextFileTarget =>
      target.mode === 'file' && target.offset !== undefined && target.limit !== undefined
    );
    const requestedWindowLines = fileWindowTargets.reduce((total, target) => total + target.limit!, 0);
    const broadFileWindowBatch = fileWindowTargets.length >= MCP_CONTEXT_BROAD_FILE_TARGETS &&
      requestedWindowLines >= MCP_CONTEXT_BROAD_FILE_LINES;
    const evidenceText = await this.renderRawEvidence(cg, rawEvidenceSpecs);
    const manifestDriven = expectedMissing.length > 0 || targets.some((target) =>
      (target.mode === 'file' && Boolean(target.symbols?.length || target.texts?.length)) ||
      (target.mode === 'symbol' && Boolean(target.members?.length))
    );
    let renderedCandidates = sectionCandidates;
    let omittedCandidates: ContextSectionCandidate[] = [];
    if (sectionCandidates.length > 0 &&
        estimatedOutputChars + evidenceText.length > MCP_CONTEXT_MAX_OUTPUT_CHARS) {
      if (!manifestDriven) {
        const preflight = this.renderContextPreflight(
          cg,
          sectionCandidates,
          estimatedOutputChars + evidenceText.length,
          broadFileWindowBatch,
          fileWindowTargets.length,
          requestedWindowLines,
          corrections,
          misses,
        );
        return this.textResult([preflight, evidenceText].filter(Boolean).join('\n\n'));
      }
      const sourceBudget = Math.max(8_000, MCP_CONTEXT_MAX_OUTPUT_CHARS - evidenceText.length - 2_000);
      const kept: ContextSectionCandidate[] = [];
      const omitted: ContextSectionCandidate[] = [];
      let used = 0;
      for (const candidate of sectionCandidates) {
        const cost = candidate.section.length + (kept.length > 0 ? 7 : 0);
        if (kept.length === 0 || used + cost <= sourceBudget) {
          kept.push(candidate);
          used += cost;
        } else {
          omitted.push(candidate);
        }
      }
      renderedCandidates = kept;
      omittedCandidates = omitted;
    }
    const sections = renderedCandidates.map((candidate) => candidate.section);

    const out: string[] = [
      ...(targets.length === 1
        ? ['> One precise context target was supplied; the same bounded renderer was used.', '']
        : []),
      `${manifestDriven ? '# Manifest-driven implementation context' : '# Precise implementation context'} (${resolvedTargets.size}/${targets.length} targets resolved)`,
      '',
      sections.join('\n\n---\n\n'),
    ];
    if (omittedCandidates.length > 0) {
      out.push('', '## Complete sections omitted by output budget');
      for (const candidate of omittedCandidates) {
        out.push(`- ${candidate.label}: about ${candidate.section.length} rendered characters`);
      }
      out.push('', '> The sections above are complete. Request the omitted labels together in the next `codegraph_context` call.');
    }
    if (misses.length > 0) out.push('', '## Unresolved / omitted targets', ...misses);
    if (corrections.length > 0) {
      out.push('', `> Automatically corrected: ${corrections.join('; ')}.`);
    }
    if (evidenceText) out.push('', evidenceText);
    out.push(
      '',
      includeRelations
        ? '> Source and requested relation trails are included above. Merged file ranges are current on-disk source.'
        : '> Exact symbols and merged file ranges are included above without repetitive dependency metadata.',
    );
    return this.textResult(out.join('\n'));
  }

  /**
   * Bounded batch literal search over the set of indexed source files. This is
   * intentionally not regex search: literal matching is predictable, cheap,
   * and covers the macros/strings/registrations that AST symbol search cannot.
   */
  private async handleTextSearch(args: Record<string, unknown>): Promise<ToolResult> {
    if (!Array.isArray(args.queries)) {
      return this.errorResult('queries must be an array of 1 to 8 literal strings');
    }
    if (args.queries.length < 1 || args.queries.length > MCP_TEXT_SEARCH_MAX_QUERIES) {
      return this.errorResult(`queries must contain 1 to ${MCP_TEXT_SEARCH_MAX_QUERIES} literals`);
    }
    const queries: string[] = [];
    for (let i = 0; i < args.queries.length; i++) {
      const query = this.validateString(args.queries[i], `queries[${i}]`, 512);
      if (typeof query !== 'string') return query;
      if (query.trim().length === 0) {
        return this.errorResult(`queries[${i}] must not be blank`);
      }
      queries.push(query);
    }
    const pathValue = this.validateString(args.path, 'path', MAX_PATH_LENGTH);
    if (typeof pathValue !== 'string') return pathValue;
    const pathHint = pathValue.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
    if (pathHint.length === 0 || pathHint === '.') {
      return this.errorResult('path must be a narrow indexed directory or file, not the project root');
    }
    if (args.maxMatchesPerQuery !== undefined &&
        (typeof args.maxMatchesPerQuery !== 'number' || !Number.isFinite(args.maxMatchesPerQuery))) {
      return this.errorResult('maxMatchesPerQuery must be a finite number');
    }
    if (args.contextLines !== undefined &&
        (typeof args.contextLines !== 'number' || !Number.isFinite(args.contextLines))) {
      return this.errorResult('contextLines must be a finite number');
    }
    const maxMatches = clamp(
      typeof args.maxMatchesPerQuery === 'number' ? Math.floor(args.maxMatchesPerQuery) : 5,
      1,
      MCP_TEXT_SEARCH_MAX_MATCHES_PER_QUERY,
    );
    const contextLines = clamp(
      typeof args.contextLines === 'number' ? Math.floor(args.contextLines) : 1,
      0,
      MCP_TEXT_SEARCH_MAX_CONTEXT_LINES,
    );
    const caseSensitive = args.caseSensitive !== false;
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const allPathCandidates = cg.getFiles().filter((file) => {
      const normalized = file.path.replace(/\\/g, '/').toLowerCase();
      return normalized.includes(pathHint) &&
        !CONFIG_LEAF_LANGUAGES.has(file.language);
    });
    const exactPathCandidates = allPathCandidates.filter((file) => {
      const normalized = file.path.replace(/\\/g, '/').toLowerCase();
      return normalized === pathHint || normalized.endsWith('/' + pathHint);
    });
    const pathCandidates = exactPathCandidates.length === 1 ? exactPathCandidates : allPathCandidates;
    const autoIncludedExactGenerated = args.includeGenerated === undefined &&
      exactPathCandidates.length === 1 && isGeneratedFile(exactPathCandidates[0]!.path);
    const includeGenerated = args.includeGenerated === true || autoIncludedExactGenerated;
    const candidates = includeGenerated
      ? pathCandidates
      : pathCandidates.filter((file) => !isGeneratedFile(file.path));
    if (candidates.length === 0) {
      return this.textResult(`No indexed source files match path "${pathValue}"${includeGenerated ? '' : ' after generated files were excluded'}.`);
    }

    type TextHit = { file: string; line: number; start: number; end: number };
    const hits = new Map<string, TextHit[]>();
    for (const query of queries) hits.set(query, []);
    const generatedSkipped = pathCandidates.length - candidates.length;
    let scannedBytes = 0;
    let scannedFiles = 0;
    let unreadableFiles = 0;
    let budgetReached = false;

    for (const file of candidates) {
      if ([...hits.values()].every((found) => found.length >= maxMatches)) break;
      if (scannedBytes + file.size > MCP_TEXT_SEARCH_MAX_SCANNED_BYTES) {
        budgetReached = true;
        break;
      }
      const abs = validatePathWithinRoot(cg.getProjectRoot(), file.path);
      if (!abs) { unreadableFiles++; continue; }
      let content: string;
      try { content = readFileSync(abs, 'utf-8'); } catch { unreadableFiles++; continue; }
      scannedBytes += Buffer.byteLength(content, 'utf-8');
      scannedFiles++;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const haystack = caseSensitive ? lines[i]! : lines[i]!.toLowerCase();
        for (const query of queries) {
          const found = hits.get(query)!;
          if (found.length >= maxMatches) continue;
          const needle = caseSensitive ? query : query.toLowerCase();
          if (!haystack.includes(needle)) continue;
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length - 1, i + contextLines);
          found.push({ file: file.path, line: i + 1, start, end });
        }
      }
    }

    const out: string[] = [
      `# Literal text search — ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}, ${scannedFiles}/${candidates.length} matching files scanned`,
      `Path: \`${pathValue}\`${autoIncludedExactGenerated
        ? ' · exact generated file auto-included'
        : includeGenerated
          ? ''
          : ` · ${generatedSkipped} generated file(s) skipped`}`,
    ];
    const queryCounts = queries.map((query) => ({ query, count: hits.get(query)!.length }));
    out.push('', '## Query summary');
    for (const { query, count } of queryCounts) {
      out.push(`- \`${query}\`: ${count} match${count === 1 ? '' : 'es'}${count === maxMatches ? ` (cap ${maxMatches} reached)` : ''}`);
    }

    type TextWindow = { file: string; start: number; end: number; queries: Set<string>; matchLines: Set<number> };
    const windowsByFile = new Map<string, TextWindow[]>();
    for (const query of queries) {
      const found = hits.get(query)!;
      for (const hit of found) {
        const fileWindows = windowsByFile.get(hit.file) ?? [];
        fileWindows.push({
          file: hit.file,
          start: hit.start,
          end: hit.end,
          queries: new Set([query]),
          matchLines: new Set([hit.line]),
        });
        windowsByFile.set(hit.file, fileWindows);
      }
    }

    const mergedWindows: TextWindow[] = [];
    for (const [file, rawWindows] of windowsByFile) {
      rawWindows.sort((a, b) => a.start - b.start || a.end - b.end);
      for (const window of rawWindows) {
        const previous = mergedWindows.at(-1);
        if (previous?.file === file && window.start <= previous.end + 1) {
          previous.end = Math.max(previous.end, window.end);
          for (const query of window.queries) previous.queries.add(query);
          for (const line of window.matchLines) previous.matchLines.add(line);
        } else {
          mergedWindows.push(window);
        }
      }
    }

    if (mergedWindows.length === 0) {
      out.push('', '_No literal matches in the scanned indexed source files._');
    } else {
      out.push('', `## Source snippets — ${mergedWindows.length} unique window${mergedWindows.length === 1 ? '' : 's'}`);
      const fileLineCache = new Map<string, string[]>();
      for (const window of mergedWindows) {
        let lines = fileLineCache.get(window.file);
        if (!lines) {
          const abs = validatePathWithinRoot(cg.getProjectRoot(), window.file);
          if (!abs) continue;
          try { lines = readFileSync(abs, 'utf-8').split('\n'); } catch { continue; }
          fileLineCache.set(window.file, lines);
        }
        const shownStart = window.start + 1;
        const shownEnd = window.end + 1;
        const location = shownStart === shownEnd ? `${window.file}:${shownStart}` : `${window.file}:${shownStart}-${shownEnd}`;
        const matched = [...window.queries].map((query) => `\`${query}\``).join(', ');
        const snippet = lines.slice(window.start, window.end + 1)
          .map((line, index) => `${window.start + index + 1}\t${line}`)
          .join('\n');
        out.push('', `**${location}** · matched ${matched}`, '```text', snippet, '```');
      }
    }

    const symbolRecoveryQueries = queryCounts
      .filter(({ query, count }) => count === 0 && isIdentifierLikeTextQuery(query))
      .filter(({ query }) => {
        const symbol = parseCallableLookup(query).symbol;
        return cg.getNodesBySymbolExact(symbol).length > 0 ||
          this.findCaseInsensitiveSymbolMatches(cg, symbol).length > 0;
      });
    const recoveries: Array<{ query: string; text: string }> = [];
    for (const { query } of symbolRecoveryQueries.slice(0, MCP_TEXT_SEARCH_MAX_SYMBOL_RECOVERIES)) {
      const result = await this.handleSearch({
        query,
        includeCode: 'if_unique',
        limit: 8,
        projectPath: args.projectPath,
      });
      const text = result.content.map((block) => block.text).join('\n').trim();
      if (text) {
        recoveries.push({
          query,
          text: this.truncateAtLine(text, MCP_TEXT_SEARCH_MAX_SYMBOL_RECOVERY_CHARS),
        });
      }
    }
    if (recoveries.length > 0) {
      out.push(
        '',
        '## Exact symbol recovery for zero-match identifiers',
        '',
        '> These identifiers were absent from the requested literal-search path but exist as indexed symbols elsewhere. The exact search result is included now; do not call `codegraph_search` or Grep for them again.',
      );
      for (const recovery of recoveries) {
        out.push('', `### ${recovery.query}`, '', recovery.text);
      }
      if (symbolRecoveryQueries.length > recoveries.length) {
        out.push('', `> ${symbolRecoveryQueries.length - recoveries.length} additional identifier-like zero-match quer${symbolRecoveryQueries.length - recoveries.length === 1 ? 'y was' : 'ies were'} not expanded to preserve the output budget.`);
      }
    }
    if (budgetReached) {
      out.push('', `> Scan stopped at the ${Math.floor(MCP_TEXT_SEARCH_MAX_SCANNED_BYTES / 1024 / 1024)} MiB safety budget; narrow path before retrying.`);
    }
    if (unreadableFiles > 0) out.push('', `> ${unreadableFiles} matched file(s) could not be read safely.`);
    out.push('', '> Treat these literal matches as authoritative for the scanned path; do not repeat them with Grep. Read a returned symbol or one small edit boundary only when necessary.');
    return this.textResult(this.truncateOutput(out.join('\n')));
  }

  /**
   * Handle codegraph_callers
   */
  private async handleCallers(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const limit = clamp((args.limit as number) || 20, 1, 100);
    const resolved = await this.resolveRelationshipTarget(cg, args, 'callers');
    if ('result' in resolved) return resolved.result;
    const { target } = resolved;

    // A declaration and its matching definition represent one logical
    // overload. Virtual/override dispatch can attach real call sites to the
    // base endpoint while the user asks for the derived implementation, so
    // walk only explicit synthesized-dispatch links for the same overload.
    const dispatchNodes = this.relationshipDispatchFamily(cg, target.nodes);
    const dispatchIds = new Set(dispatchNodes.map((node) => node.id));
    const callerGroups = new Map<string, RelatedSymbolRelationships>();
    for (const node of dispatchNodes) {
      mergeDirectRelationshipGroups(
        callerGroups,
        node,
        'incoming',
        cg.getDirectRelationshipGroups(node.id, 'incoming'),
        dispatchIds,
      );
    }

    if (callerGroups.size === 0) {
      const needle = this.rawEvidenceNeedle(target.symbol);
      const evidence = needle
        ? await this.renderRawEvidence(cg, [{ label: `zero callers: ${target.signature ?? target.symbol}`, needle }])
        : '';
      return this.textResult([
        `No callers found for ${this.formatRelationshipTarget(target)}${target.lookupNote}`,
        evidence,
        evidence ? '> Raw matches can include declarations, definitions, references, macros, or calls. They are shown to expose possible graph/index gaps; raw text alone is not classified as a caller.' : '',
      ].filter(Boolean).join('\n\n'));
    }

    const dispatchNote = dispatchNodes.length > target.nodes.length
      ? `\n\n> Virtual dispatch family expanded ${target.nodes.length} selected declaration/definition endpoint(s) to ${dispatchNodes.length} exact base/override endpoint(s); callers were deduplicated across that family.`
      : '';
    const formatted = this.formatRelationshipList(
      sortRelatedSymbolRelationships(callerGroups.values()).slice(0, limit),
      `Callers of ${this.formatRelationshipTarget(target)}`,
      'caller',
      true,
    ) + dispatchNote + target.lookupNote;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_callees
   */
  private async handleCallees(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const limit = clamp((args.limit as number) || 20, 1, 100);
    const resolved = await this.resolveRelationshipTarget(cg, args, 'callees');
    if ('result' in resolved) return resolved.result;
    const { target } = resolved;

    const calleeGroups = new Map<string, RelatedSymbolRelationships>();
    for (const node of target.nodes) {
      mergeDirectRelationshipGroups(
        calleeGroups,
        node,
        'outgoing',
        cg.getDirectRelationshipGroups(node.id, 'outgoing'),
      );
    }

    if (calleeGroups.size === 0) {
      const needle = this.rawEvidenceNeedle(target.symbol);
      const evidence = needle
        ? await this.renderRawEvidence(cg, [{ label: `zero callees: ${target.signature ?? target.symbol}`, needle }])
        : '';
      return this.textResult([
        `No callees found for ${this.formatRelationshipTarget(target)}${target.lookupNote}`,
        evidence,
        evidence ? '> Raw matches can include declarations, definitions, references, macros, or calls. They are shown to expose possible graph/index gaps; raw text alone is not classified as a callee.' : '',
      ].filter(Boolean).join('\n\n'));
    }

    const formatted = this.formatRelationshipList(
      sortRelatedSymbolRelationships(calleeGroups.values()).slice(0, limit),
      `Callees of ${this.formatRelationshipTarget(target)}`,
      'definition',
      false,
    ) + target.lookupNote;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_impact
   */
  private async handleImpact(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const depth = clamp((args.depth as number) || 2, 1, 10);
    const resolved = await this.resolveRelationshipTarget(cg, args, 'impact');
    if ('result' in resolved) return resolved.result;
    const { target } = resolved;

    const mergedNodes = new Map<string, Node>();
    const mergedEdges: Edge[] = [];
    const seenEdges = new Set<string>();

    for (const node of target.nodes) {
      const impact = cg.getImpactRadius(node.id, depth);
      for (const [id, n] of impact.nodes) {
        mergedNodes.set(id, n);
      }
      for (const e of impact.edges) {
        const key = `${e.source}->${e.target}:${e.kind}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          mergedEdges.push(e);
        }
      }
    }

    const mergedImpact = {
      nodes: mergedNodes,
      edges: mergedEdges,
      roots: target.nodes.map(n => n.id),
    };

    const formatted = this.formatImpact(this.formatRelationshipTarget(target), mergedImpact) + target.lookupNote;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Flow-from-named-symbols: an agent's codegraph_explore query is a bag of
   * symbol names that usually spans the flow it's investigating (e.g.
   * "PmsProductController getList PmsProductService list PmsProductServiceImpl").
   * Surface the longest call chain AMONG those named symbols — scoped to what the
   * agent explicitly named, so (unlike a fuzzy relevance set) there's no
   * wrong-feature wandering. Rides synthesized edges, so controller→service-
   * interface→impl shows up. Returns '' if no chain of >=3 nodes exists.
   *
   * Ambiguous tokens (Java `list` → dozens of nodes) are disambiguated by
   * CO-NAMING: the agent names the class too, so we keep only `list` candidates
   * whose qualifiedName contains another named token (`PmsProductServiceImpl::list`),
   * dropping unrelated `OmsOrderService::list`.
   */
  private buildFlowFromNamedSymbols(cg: CodeGraph, query: string): { text: string; pathNodeIds: Set<string>; namedNodeIds: Set<string>; uniqueNamedNodeIds: Set<string> } {
    const EMPTY = { text: '', pathNodeIds: new Set<string>(), namedNodeIds: new Set<string>(), uniqueNamedNodeIds: new Set<string>() };
    try {
      const CALLABLE = new Set(['method', 'function', 'component', 'constructor']);
      // Strip only a REAL file extension (Create.cs → Create); KEEP qualified
      // names (Class.method / Class::method) — the agent's most precise input,
      // resolved exactly by findAllSymbols. (The old strip mangled Class.method
      // into Class, throwing the method away.)
      const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte)$/i;
      const tokens = [...new Set(
        query.split(/[\s,()[\]]+/)
          .map((t) => t.replace(FILE_EXT, '').trim())
          .filter((t) => t.length >= 3 && /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/.test(t))
      )].slice(0, 16);
      if (tokens.length < 2) return EMPTY;
      // Pool of name SEGMENTS (Class + method from every token) used to
      // disambiguate an ambiguous SIMPLE name: keep a candidate only if its
      // CONTAINER class is itself named in the query.
      const segPool = new Set<string>();
      for (const t of tokens) for (const s of t.toLowerCase().split(/::|\./)) if (s) segPool.add(s);
      const named = new Map<string, Node>();
      // Nodes whose token is SPECIFIC — a (near-)unique callable name (<=3 defs in
      // the whole graph). These are safe to SPARE a file on: the agent named THIS
      // method (`getResponseWithInterceptorChain`, 1 def). A hyper-polymorphic name
      // (`as_sql`, 110 defs across every Expression/Compiler subclass) is NOT here,
      // so naming it doesn't keep every backend variant full and flood the budget.
      const uniqueNamedNodeIds = new Set<string>();
      for (const t of tokens) {
        const cands = this.findAllSymbols(cg, t).nodes.filter((n) => CALLABLE.has(n.kind));
        // A qualified or otherwise-specific name (<=3 hits) keeps all; an
        // ambiguous simple name keeps only candidates whose container is named.
        const specific = cands.length <= 3;
        const pick = specific
          ? cands
          : cands.filter((n) => {
              const segs = (n.qualifiedName || '').toLowerCase().split(/::|\./).filter(Boolean);
              const container = segs.length >= 2 ? segs[segs.length - 2] : '';
              return !!container && segPool.has(container);
            });
        for (const n of pick.slice(0, 6)) {
          named.set(n.id, n);
          if (specific) uniqueNamedNodeIds.add(n.id);
        }
        if (named.size > 40) break;
      }
      if (named.size < 2) return EMPTY;
      const MAX_HOPS = 7;
      let best: Array<{ node: Node; edge: Edge | null }> | null = null;
      // BFS the full call graph (incl. synth edges) from each named seed, but
      // only ACCEPT a sink that is also named — both ends anchored to symbols the
      // agent named, so the chain stays on-topic while bridging intermediates
      // (e.g. the exact interface overload) that the token resolution missed.
      for (const seed of [...named.values()].slice(0, 8)) {
        const parent = new Map<string, { prev: string | null; edge: Edge | null; node: Node }>();
        parent.set(seed.id, { prev: null, edge: null, node: seed });
        const q: Array<{ id: string; depth: number; streak: number }> = [{ id: seed.id, depth: 0, streak: 0 }];
        let deep: string | null = null, deepDepth = 0;
        const MAX_BRIDGE = 1; // ≤1 consecutive UNNAMED hop: bridge one missing intermediate, never wander a god-function's fan-out
        for (let h = 0; h < q.length && parent.size < 1500; h++) {
          const { id, depth, streak } = q[h]!;
          if (id !== seed.id && named.has(id) && depth > deepDepth) { deep = id; deepDepth = depth; }
          if (depth >= MAX_HOPS - 1) continue;
          for (const c of cg.getCallees(id)) {
            if (c.edge.kind !== 'calls' || parent.has(c.node.id)) continue;
            const newStreak = named.has(c.node.id) ? 0 : streak + 1;
            if (newStreak > MAX_BRIDGE) continue;
            parent.set(c.node.id, { prev: id, edge: c.edge, node: c.node });
            q.push({ id: c.node.id, depth: depth + 1, streak: newStreak });
          }
        }
        if (!deep) continue;
        const chain: Array<{ node: Node; edge: Edge | null }> = [];
        let cur: string | null = deep;
        while (cur) { const p = parent.get(cur); if (!p) break; chain.push({ node: p.node, edge: p.edge }); cur = p.prev; }
        chain.reverse();
        if (!best || chain.length > best.length) best = chain;
      }
      const hasMain = !!best && best.length >= 3;
      const pathIds = new Set((best ?? []).map((s) => s.node.id));

      // Supplementary: dynamic-dispatch (synthesized) edges incident to a NAMED
      // symbol — the indirect hops an agent would otherwise grep/Read to
      // reconstruct ("where do the appended `validators` actually run?"). The
      // synth edge IS that answer, so surface it even when the OTHER end wasn't
      // named (e.g. the agent names `validate` but not the `didCompleteTask`
      // that drains the collection). On-topic by construction: only heuristic
      // edges touching a symbol the agent named; skipped when the hop already
      // shows in the main chain.
      const synthLines: string[] = [];
      const synthSeen = new Set<string>();
      for (const n of named.values()) {
        if (synthLines.length >= 6) break;
        for (const { node: other, edge } of [...cg.getCallers(n.id), ...cg.getCallees(n.id)]) {
          if (synthLines.length >= 6) break;
          if (edge.provenance !== 'heuristic' || other.id === n.id) continue;
          if (pathIds.has(edge.source) && pathIds.has(edge.target)) continue; // already in the main chain
          const src = edge.source === n.id ? n : other;
          const tgt = edge.source === n.id ? other : n;
          const key = `${src.name}>${tgt.name}`;
          if (synthSeen.has(key)) continue;
          synthSeen.add(key);
          const note = synthEdgeNote(edge);
          synthLines.push(`- ${src.name} → ${tgt.name}   [${note ? note.compact : edge.kind}]`);
        }
      }

      if (!hasMain && synthLines.length === 0) return EMPTY;
      const out: string[] = [];
      if (hasMain) {
        out.push('## Flow (call path among the symbols you queried)', '');
        for (let i = 0; i < best!.length; i++) {
          const step = best![i]!;
          if (step.edge) { const sy = synthEdgeNote(step.edge); out.push(`   ↓ ${sy ? sy.compact : step.edge.kind}`); }
          out.push(`${i + 1}. ${step.node.name} (${step.node.filePath}:${step.node.startLine})`);
        }
        out.push('');
      }
      if (synthLines.length) {
        out.push(
          '## Dynamic-dispatch links among your symbols',
          '(synthesized — the indirect hops grep/Read would reconstruct; the `@file:line` is the wiring site)',
          '',
          ...synthLines,
          ''
        );
      }
      out.push('> Full source for these symbols is below — the call flow among them, followed by their bodies.', '');
      // namedNodeIds = every callable the agent explicitly named (a superset of
      // the spine). A file holding one is something the agent asked to SEE, so it
      // must keep full source even if it's an off-spine polymorphic sibling — the
      // agent named `getResponseWithInterceptorChain` / `SQLCompiler.execute_sql`
      // as the mechanism, not as an interchangeable leaf. See the skeleton gate.
      return { text: out.join('\n'), pathNodeIds: pathIds, namedNodeIds: new Set(named.keys()), uniqueNamedNodeIds };
    } catch {
      return EMPTY;
    }
  }

  /**
   * Compact "blast radius" for the entry symbols of an explore result: who
   * depends on each (callers) and which test files cover it — LOCATIONS ONLY,
   * no source, so the agent knows what to update / re-verify before editing
   * without reaching for a separate impact call. Always-on, but skips symbols
   * that have no dependents (nothing to warn about), and returns '' when none
   * qualify so a leaf-only exploration stays clean.
   */
  private buildBlastRadiusSection(cg: CodeGraph, subgraph: Subgraph): string {
    const ROOT_CAP = 5; // only the symbols the query actually targeted
    const FILE_CAP = 4; // caller files listed per symbol before "+N more"
    const MEANINGFUL = new Set<string>([
      'function', 'method', 'class', 'interface', 'struct', 'trait', 'protocol',
      'enum', 'type_alias', 'component', 'constant', 'variable', 'property', 'field',
    ]);
    const rel = (p: string) => p.replace(/\\/g, '/');

    const roots = subgraph.roots
      .map((id) => subgraph.nodes.get(id))
      .filter((n): n is Node => !!n && MEANINGFUL.has(n.kind))
      .slice(0, ROOT_CAP);
    if (roots.length === 0) return '';

    const entries: string[] = [];
    for (const root of roots) {
      let callers: Array<{ node: Node }> = [];
      try { callers = cg.getCallers(root.id) as Array<{ node: Node }>; } catch { /* skip this root */ }

      const seen = new Set<string>();
      const uniq: Node[] = [];
      for (const c of callers) {
        if (c?.node && !seen.has(c.node.id)) { seen.add(c.node.id); uniq.push(c.node); }
      }
      if (uniq.length === 0) continue; // no blast radius → nothing to flag

      const callerFiles = [...new Set(uniq.map((n) => rel(n.filePath)))];
      const testFiles = callerFiles.filter((f) => isTestFile(f));
      const nonTest = callerFiles.filter((f) => !isTestFile(f));

      const shown = nonTest.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ');
      const more = nonTest.length > FILE_CAP ? ` +${nonTest.length - FILE_CAP} more` : '';
      const where = nonTest.length > 0 ? ` in ${shown}${more}` : '';
      const tests = testFiles.length > 0
        ? `; tests: ${testFiles.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ')}${testFiles.length > FILE_CAP ? ` +${testFiles.length - FILE_CAP}` : ''}`
        : '; ⚠️ no covering tests found';

      entries.push(
        `- \`${root.name}\` (${rel(root.filePath)}:${root.startLine}) — ${uniq.length} caller${uniq.length === 1 ? '' : 's'}${where}${tests}`,
      );
    }
    if (entries.length === 0) return '';

    return [
      '### Blast radius — what depends on these (update/verify before editing)',
      '',
      ...entries,
      '',
    ].join('\n');
  }

  /**
   * Graph-connectivity relevance via Random-Walk-with-Restart (personalized
   * PageRank) from the query's matched SEED nodes over the call/reference graph.
   *
   * This is the ranking signal text search (FTS/bm25) CANNOT provide, and it's
   * codegraph's home turf: relevance by STRUCTURE, not words. A file whose
   * symbols are call-connected to the matched cluster accrues walk mass and
   * ranks high; a lone TEXT match — e.g. `LensSwitcher.swift` matched the word
   * "switch" from `switchOrganization`, but calls none of `setUser`/`fetchUser`
   * — gets only its own restart probability and ranks ~0. Immune to the
   * tokenization trap that fools term matching, deterministic, no embeddings.
   *
   * Undirected adjacency (reachability both ways), restart α=0.25 to the seeds,
   * power iteration to convergence. Bounded to the already-relevant subgraph, so
   * it's a few hundred nodes × ~25 iterations — negligible cost.
   */
  private computeGraphRelevance(
    nodeIds: string[],
    edges: Edge[],
    seedIds: Set<string>,
  ): Map<string, number> {
    const out = new Map<string, number>();
    const n = nodeIds.length;
    if (n === 0) return out;
    const idx = new Map<string, number>();
    for (let i = 0; i < n; i++) idx.set(nodeIds[i]!, i);

    const RANK_EDGES = new Set<string>([
      'calls', 'references', 'extends', 'implements', 'overrides',
      'instantiates', 'returns', 'type_of', 'imports',
    ]);
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const e of edges) {
      if (!RANK_EDGES.has(e.kind)) continue;
      const i = idx.get(e.source);
      const j = idx.get(e.target);
      if (i === undefined || j === undefined || i === j) continue;
      adj[i]!.push(j);
      adj[j]!.push(i); // undirected — reachable either direction
    }

    // Restart vector: uniform over seeds present in the candidate set. (Falls
    // back to uniform-over-all if no seed landed in the set, so we never return
    // all-zero.)
    const r = new Array<number>(n).fill(0);
    let rsum = 0;
    for (const id of seedIds) {
      const i = idx.get(id);
      if (i !== undefined) { r[i] = 1; rsum += 1; }
    }
    if (rsum === 0) { for (let i = 0; i < n; i++) r[i] = 1; rsum = n; }
    for (let i = 0; i < n; i++) r[i]! /= rsum;

    const alpha = 0.25;
    let s = r.slice();
    for (let iter = 0; iter < 25; iter++) {
      const next = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        const si = s[i]!;
        if (si === 0) continue;
        const d = adj[i]!.length;
        if (d === 0) { next[i]! += si; continue; } // dangling: keep its mass
        const share = si / d;
        for (const j of adj[i]!) next[j]! += share;
      }
      for (let i = 0; i < n; i++) s[i] = (1 - alpha) * next[i]! + alpha * r[i]!;
    }
    for (let i = 0; i < n; i++) out.set(nodeIds[i]!, s[i]!);
    return out;
  }

  /**
   * Handle codegraph_explore — deep exploration in a single call
   *
   * Strategy: find relevant symbols via graph traversal, group by file,
   * then read contiguous file sections covering all symbols per file.
   * This replaces multiple codegraph_node + Read calls.
   *
   * Output size is adaptive to project file count via
   * `getExploreOutputBudget` — see #185 for why a fixed 35k cap was a
   * tax on small projects while earning its keep on large ones.
   */
  private async handleExplore(args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    // Fast-fail: reject natural-language queries. Explore works best with
    // symbol/file names extracted from the question, not the raw question.
    const nlCheck = isNaturalLanguageQuery(query);
    if (nlCheck.isNatural) {
      // Extract any identifier-looking tokens as a hint for the agent.
      const idTokens = query
        .split(/[\s,;]+/)
        .map((t) => t.replace(/^[^\w]+|[^\w]+$/g, ''))
        .filter((t) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t) && t.length >= 2);
      const hint = idTokens.length >= 2
        ? `\n→ 请尝试: codegraph_explore query="${idTokens.join(' ')}"\n  （从问题中提取的关键符号名）`
        : '';
      return this.textResult(
        `codegraph_explore 使用符号名/文件名效果最好，不支持自然语言描述。\n\n` +
        `收到的查询: "${query}"\n` +
        `检测到: ${nlCheck.reason}\n\n` +
        `→ 请从问题中提取关键符号名后直接传入` +
        hint
      );
    }

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const projectRoot = cg.getProjectRoot();

    // Resolve adaptive output budget from project size. Falls back to the
    // largest-tier defaults if stats aren't available, which preserves
    // pre-#185 behavior for callers that hit the rare stats failure.
    let budget: ExploreOutputBudget;
    try {
      budget = getExploreOutputBudget(cg.getStats().fileCount);
    } catch {
      budget = getExploreOutputBudget(Infinity);
    }
    const maxFiles = clamp((args.maxFiles as number) || budget.defaultMaxFiles, 1, 20);

    // Step 1: Find relevant context with generous parameters.
    // Use a large maxNodes budget — explore has its own 35k char output limit
    // that prevents context bloat, so more nodes just means better coverage
    // across entry points (especially for large files like Svelte components).
    const subgraph = await cg.findRelevantContext(query, {
      searchLimit: 8,
      traversalDepth: 3,
      maxNodes: 200,
      minScore: 0.2,
    });

    if (subgraph.nodes.size === 0) {
      return this.textResult(`No relevant code found for "${query}"`);
    }

    // Graph-aware glue: findRelevantContext builds the subgraph from name/text
    // search, so a method that BRIDGES named symbols — e.g. App.tsx's
    // triggerRender, which calls the named triggerUpdate — is never a search hit
    // and gets missed, forcing the agent to Read the file to trace it. Pull in
    // the callers/callees of the entry (root) nodes, but ONLY those that live in
    // files the subgraph already surfaces (where the agent reads to fill gaps),
    // so we add wiring without dragging in unrelated files. These get an
    // importance boost below so they survive the per-file cluster budget.
    const glueNodeIds = new Set<string>();
    const subgraphFiles = new Set<string>();
    for (const n of subgraph.nodes.values()) subgraphFiles.add(n.filePath);
    const GLUE_NODE_CAP = 60;
    for (const rootId of subgraph.roots) {
      if (glueNodeIds.size >= GLUE_NODE_CAP) break;
      let neighbors: Node[] = [];
      try {
        neighbors = [
          ...cg.getCallers(rootId).map(c => c.node),
          ...cg.getCallees(rootId).map(c => c.node),
        ];
      } catch {
        continue;
      }
      for (const nb of neighbors) {
        if (glueNodeIds.size >= GLUE_NODE_CAP) break;
        if (subgraph.nodes.has(nb.id)) continue;
        if (!subgraphFiles.has(nb.filePath)) continue;
        subgraph.nodes.set(nb.id, nb);
        glueNodeIds.add(nb.id);
      }
    }

    // Named-symbol seeding: findRelevantContext is an FTS/text rank, so a query
    // that's a BAG of symbol names skewed toward one phase (Alamofire: 5 build
    // terms, each a high-frequency name, vs 3 validate terms) lets the
    // lower-frequency names fall below the search cut — their definitions, and
    // whole files (Validation.swift), never get gathered, so they can never
    // render and the agent Reads them. Resolve EACH named token to its
    // substantive definition (skip empty stubs + test files, same relevance the
    // trace endpoint picker uses) and inject it as an entry, so every symbol the
    // agent explicitly named is in the subgraph and its file is scored.
    const namedSeedIds = new Set<string>();
    {
      const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte)$/i;
      const CALLABLE = new Set(['method', 'function', 'component', 'constructor']);
      const isTestPath = (p: string) => /(^|\/)(tests?|specs?|__tests__|testdata|mocks?|fixtures?)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p);
      const bodyLines = (n: Node) => Math.max(0, (n.endLine ?? n.startLine) - n.startLine);
      const tokens = [...new Set(
        query.split(/[\s,()[\]]+/)
          .map((t) => t.replace(FILE_EXT, '').trim())
          .filter((t) => t.length >= 3 && /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/.test(t))
      )].slice(0, 16);
      // PascalCase tokens in the query are type/file disambiguators — when the
      // agent writes "DataRequest task validate", the `task`/`validate` it wants
      // are DataRequest's, NOT the same-named overloads in Validation.swift /
      // Concurrency.swift / the abstract base. Used below to bias overloaded
      // names toward the file/class the query also names. EXCLUDE the project
      // name (a PascalCase token a user naturally includes) — it names the whole
      // repo, so biasing toward it just pulls overloads to whichever stack
      // embeds it, re-burying the rest (#720).
      const projectNameTokens = cg.getProjectNameTokens();
      const typeTokens = tokens.filter(
        (o) => /^[A-Z][A-Za-z0-9]{3,}/.test(o) && !projectNameTokens.has(normalizeNameToken(o)),
      );
      const inNamedContext = (n: Node) =>
        typeTokens.some((ct) => {
          const lc = ct.toLowerCase();
          return n.filePath.toLowerCase().includes(lc) || n.qualifiedName.toLowerCase().includes(lc);
        });
      for (const t of tokens) {
        // Enumerate ALL defs of a bare token via the direct index, not FTS — a
        // 50+-overload name (tokio `poll`) ranks the wanted def (`Harness::poll`)
        // below the FTS cut, so findAllSymbols would never see it and the
        // type-token bias below couldn't pick the harness.rs one. (Same fix as
        // codegraph_node's findSymbolMatches.) Qualified tokens keep findAllSymbols.
        const isQual = /[.\/]|::/.test(t);
        const raw = isQual ? this.findAllSymbols(cg, t).nodes : cg.getNodesByName(t);
        const cands = raw
          .filter((n) => CALLABLE.has(n.kind) && !isTestPath(n.filePath))
          .sort((a, b) => (bodyLines(b) > 1 ? 1 : 0) - (bodyLines(a) > 1 ? 1 : 0) || bodyLines(b) - bodyLines(a));
        // A specific name (<=3 defs) injects all its defs. An overloaded name
        // (`validate` = 10, `request` = 44) would flood the subgraph, so inject
        // only: the overloads whose file/class the query ALSO names (the agent
        // told us which one it wants — DataRequest's, not Validation.swift's),
        // capped; else fall back to the single most-substantive def. This is the
        // explore-side mirror of codegraph_node's overload disambiguation.
        let picks: Node[];
        if (cands.length <= 3) {
          picks = cands;
        } else {
          const ctx = cands.filter(inNamedContext);
          picks = ctx.length > 0 ? ctx.slice(0, 4) : cands.slice(0, 1);
        }
        for (const n of picks) {
          if (!subgraph.nodes.has(n.id)) subgraph.nodes.set(n.id, n);
          // Mark as a named seed EVEN IF the FTS gather already had it — being
          // "named by the agent" is independent of whether search happened to
          // surface it, and it drives the +50 score, the gate, and the
          // named-file sort below. (Previously only NEW injections were marked,
          // so a named symbol FTS already gathered never sorted to the top.)
          namedSeedIds.add(n.id);
        }
      }
    }

    // Step 2: Group nodes by file, score by relevance
    const fileGroups = new Map<string, { nodes: Node[]; score: number }>();
    const entryNodeIds = new Set([...subgraph.roots, ...namedSeedIds]);

    // Build a set of nodes directly connected to entry points (depth 1)
    const connectedToEntry = new Set<string>();
    for (const edge of subgraph.edges) {
      if (entryNodeIds.has(edge.source)) connectedToEntry.add(edge.target);
      if (entryNodeIds.has(edge.target)) connectedToEntry.add(edge.source);
    }

    for (const node of subgraph.nodes.values()) {
      // Skip import/export nodes — they add noise without information
      if (node.kind === 'import' || node.kind === 'export') continue;
      // SECURITY (#383): never render the on-disk source of a config-leaf
      // (Spring application.{yml,properties} key) — its line is `key = <secret>`,
      // so whole-file/cluster rendering here would push secrets into context
      // unbidden. The key still appears in the flow/symbol listing above.
      if (isConfigLeafNode(node)) continue;

      const group = fileGroups.get(node.filePath) || { nodes: [], score: 0 };
      group.nodes.push(node);
      // Score: a NAMED-SEED node (a symbol the agent named that FTS missed, now
      // injected) is worth far more than a mere reference — its file is where the
      // answer lives. Without this, an incidental file that name-drops the flow
      // (Combine.swift references request/task → score 23 from connected nodes)
      // outranks the file that DEFINES a named symbol (Validation.swift's
      // `validate` → 10) and steals its render slot. Definition ≫ reference.
      if (namedSeedIds.has(node.id)) {
        group.score += 50;
      } else if (entryNodeIds.has(node.id)) {
        group.score += 10;
      } else if (connectedToEntry.has(node.id)) {
        group.score += 3;
      } else {
        group.score += 1;
      }
      fileGroups.set(node.filePath, group);
    }

    // Only include files that have entry points or nodes directly connected to entry points
    let relevantFiles = [...fileGroups.entries()].filter(([, group]) => group.score >= 3);

    // Extract query terms for relevance checking
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);

    // Test/spec/icon/i18n file detector — used both for the pre-sort hard
    // filter (tiny tier) and the comparator deprioritization (all tiers).
    const isLowValue = (p: string) => {
      const lp = p.toLowerCase();
      return (
        /\/(tests?|__tests?__|spec)\//.test(lp) ||
        /_test\.go$/.test(lp) ||
        /(?:^|\/)test_[^/]+\.py$/.test(lp) ||
        /_test\.py$/.test(lp) ||
        /_spec\.rb$/.test(lp) ||
        /_test\.rb$/.test(lp) ||
        /\.(test|spec)\.[jt]sx?$/.test(lp) ||
        /(test|spec|tests)\.(java|kt|scala)$/.test(lp) ||
        /(tests?|spec)\.cs$/.test(lp) ||
        /tests?\.swift$/.test(lp) ||
        /_test\.dart$/.test(lp) ||
        /\bicons?\b/.test(lp) ||
        /\bi18n\b/.test(lp)
      );
    };

    // Hard-exclude test/spec files (ALL tiers, not just tiny). One slipped test
    // file dominates the per-file budget on small repos (cobra's `command_test.go`
    // displaced `args.go`) AND wastes budget on large ones (Django's
    // `custom_lookups/tests.py` ate ~2.3 KB of the 28 KB cap, crowding out the
    // SQLCompiler mechanism the agent then Read). A test file almost never answers
    // an architecture question. Skip when the query itself is about tests — the
    // legitimate "explore the tests" case — and only cut if ≥2 non-test candidates
    // remain (else tests are the only signal for this area).
    {
      const queryMentionsTests = /\b(test|tests|testing|spec|verify|verifies)\b/i.test(query);
      if (!queryMentionsTests) {
        const nonLow = relevantFiles.filter(([p]) => !isLowValue(p));
        if (nonLow.length >= 2) {
          relevantFiles = nonLow;
        }
      }
    }

    // Secondary signal: how many DISTINCT query terms each file matches (path +
    // symbol names). Kept only as a tiebreak — the PRIMARY relevance is graph
    // connectivity below. (Term counting alone tied the real central file with
    // incidental same-word matches; it's a weak text signal, not the ranker.)
    const uniqueQueryTerms = [...new Set(queryTerms)].filter(t => t.length >= 3);
    const fileTermHits = new Map<string, number>();
    for (const [fp, group] of relevantFiles) {
      const hay = fp.toLowerCase() + ' ' + group.nodes.map(n => n.name.toLowerCase()).join(' ');
      let hits = 0;
      for (const t of uniqueQueryTerms) if (hay.includes(t)) hits++;
      fileTermHits.set(fp, hits);
    }

    // PRIMARY relevance: graph connectivity (Random-Walk-with-Restart from the
    // matched seeds — see computeGraphRelevance). Aggregate each file's nodes'
    // walk mass. This is the signal text search lacks: the real cluster
    // (org-user.storage.ts, call-connected to the matches) accrues mass; a lone
    // text match (LensSwitcher.swift, matched "switch" but calls nothing in the
    // flow) gets only its restart probability → ~0, and is dropped by the gate.
    const nodeRwr = this.computeGraphRelevance(
      [...subgraph.nodes.keys()], subgraph.edges, entryNodeIds,
    );
    const fileGraphScore = new Map<string, number>();
    for (const node of subgraph.nodes.values()) {
      fileGraphScore.set(
        node.filePath,
        (fileGraphScore.get(node.filePath) ?? 0) + (nodeRwr.get(node.id) ?? 0),
      );
    }
    const maxGraph = Math.max(0, ...fileGraphScore.values());

    // Central file(s): the 1-2 most graph-central files that also match the
    // query textually (so a connected hub-utility with no term match isn't
    // mistaken for the subject). The heart of the answer — they earn the larger
    // WHOLE-FILE ceiling below (a god-file central file still exceeds it and
    // falls to generous full-method sectioning — never a whole dump).
    const centralFiles = new Set(
      [...fileGraphScore.entries()]
        .filter(([fp, g]) => g > 0 && (fileTermHits.get(fp) ?? 0) >= 1)
        .sort((a, b) => b[1] - a[1] || (fileTermHits.get(b[0]) ?? 0) - (fileTermHits.get(a[0]) ?? 0))
        .slice(0, 2)
        .map(([f]) => f),
    );

    // Files that DEFINE a symbol the agent named (or a subgraph root). These are
    // the highest-relevance files there are — the agent asked for them by name —
    // so the connectivity gate below must never drop them, even when their RWR
    // mass is low (a leaf family file like codec.ts is call-connected to little
    // but is exactly what the agent queried). Without this protection the gate
    // prunes a named file and the agent Reads it back.
    const entryFiles = new Set<string>();
    for (const id of entryNodeIds) {
      const n = subgraph.nodes.get(id);
      if (n) entryFiles.add(n.filePath);
    }

    // Relevance gate (so the generous budget is a CEILING, not a target): keep a
    // file only if it is STRUCTURALLY relevant by ANY of:
    //   - graph score within a fraction of the top (it's on/near the flow), OR
    //   - central (a query entry-point lives here), OR
    //   - it DEFINES a symbol the agent named (entryFiles), OR
    //   - it matches >= 2 DISTINCT named query terms — a strong text signal that
    //     the agent is asking about this file even when nothing calls it (codec.ts:
    //     the agent named `encode`/`Codec`/`JsonCodec`, all leaf classes with zero
    //     RWR mass — graph alone wrongly drops it).
    // A lone text match on one shared word (LensSwitcher: term=1, g~0) is still
    // dropped, so the budget never fills with incidental files. Guarded so it
    // never prunes below 2.
    if (maxGraph > 0) {
      const gated = relevantFiles.filter(([fp]) =>
        (fileGraphScore.get(fp) ?? 0) >= maxGraph * 0.06
        || centralFiles.has(fp)
        || entryFiles.has(fp)
        || (fileTermHits.get(fp) ?? 0) >= 2,
      );
      if (gated.length >= 2) relevantFiles = gated;
    }

    // Sort files: graph-central first, then distinct-term match, then the
    // existing low-value/generated/score tiebreaks.
    // Files that DEFINE a symbol the agent NAMED. These sort first — ahead of
    // graph connectivity — because the agent asked for them by name. Without
    // this, a named leaf override reached only by dynamic dispatch (Alamofire's
    // `DataRequest.task`/`validate`, low RWR mass) sorts below the high-
    // connectivity abstract base (`Request.swift`) and the same-named overloads
    // in other files (`Validation.swift`), falls outside the budget, and the
    // agent Reads it. The named file is the answer — rank it at the top.
    const namedSeedFiles = new Set<string>();
    for (const id of namedSeedIds) {
      const n = subgraph.nodes.get(id);
      if (n) namedSeedFiles.add(n.filePath);
    }

    const sortedFiles = relevantFiles.sort((a, b) => {
      const aPath = a[0].toLowerCase();
      const bPath = b[0].toLowerCase();

      // Agent-named files first (it asked for a symbol defined here by name).
      const aNamed = namedSeedFiles.has(a[0]) ? 1 : 0;
      const bNamed = namedSeedFiles.has(b[0]) ? 1 : 0;
      if (aNamed !== bNamed) return bNamed - aNamed;

      // Graph connectivity is the next key (small epsilon so near-ties fall
      // through to the text signal rather than coin-flipping on float noise).
      const aG = fileGraphScore.get(a[0]) ?? 0;
      const bG = fileGraphScore.get(b[0]) ?? 0;
      if (Math.abs(aG - bG) > maxGraph * 0.01) return bG - aG;

      const aHits = fileTermHits.get(a[0]) ?? 0;
      const bHits = fileTermHits.get(b[0]) ?? 0;
      if (aHits !== bHits) return bHits - aHits;

      const aLow = isLowValue(aPath);
      const bLow = isLowValue(bPath);
      if (aLow !== bLow) return aLow ? 1 : -1;

      // Deprioritize generated source (.pb.go / .pulsar.go / _mocks.go / …) —
      // the agent rarely needs to see the protobuf scaffold or gomock output
      // when asking about the actual flow, and dumping their bodies inflates
      // the response (the cosmos Q3 explore otherwise leads with
      // `expected_keepers_mocks.go`, displacing the real `tally.go` content
      // and forcing the agent to Read tally.go anyway).
      const aGen = isGeneratedFile(a[0]);
      const bGen = isGeneratedFile(b[0]);
      if (aGen !== bGen) return aGen ? 1 : -1;

      if (a[1].score !== b[1].score) return b[1].score - a[1].score;
      return b[1].nodes.length - a[1].nodes.length;
    });

    // Step 3: Build relationship map
    const lines: string[] = [
      `## Exploration: ${query}`,
      '',
      `Found ${subgraph.nodes.size} symbols across ${fileGroups.size} files.`,
      '',
    ];

    // Blast radius (always-on, compact): for the entry symbols, who depends on
    // them + which tests cover them — locations only, no source — so the agent
    // knows what to update/verify before editing without a separate call.
    const blastRadius = this.buildBlastRadiusSection(cg, subgraph);
    if (blastRadius) lines.push(blastRadius);

    // Relationship map — show how symbols connect
    const significantEdges = subgraph.edges.filter(e =>
      e.kind !== 'contains' // skip contains — it's implied by file grouping
    );

    if (budget.includeRelationships && significantEdges.length > 0) {
      lines.push('### Relationships');
      lines.push('');

      // Group edges by kind for readability
      const byKind = new Map<string, Array<{ source: string; target: string }>>();
      for (const edge of significantEdges) {
        const sourceNode = subgraph.nodes.get(edge.source);
        const targetNode = subgraph.nodes.get(edge.target);
        if (!sourceNode || !targetNode) continue;

        const group = byKind.get(edge.kind) || [];
        group.push({ source: sourceNode.name, target: targetNode.name });
        byKind.set(edge.kind, group);
      }

      for (const [kind, edges] of byKind) {
        const cap = budget.maxEdgesPerRelationshipKind;
        const shown = edges.slice(0, cap);
        lines.push(`**${kind}:**`);
        for (const e of shown) {
          lines.push(`- ${e.source} → ${e.target}`);
        }
        if (edges.length > cap) {
          lines.push(`- ... and ${edges.length - cap} more`);
        }
        lines.push('');
      }
    }

    // Step 4: Read contiguous file sections
    // Compute the flow spine once — used both to prepend the Flow section (below)
    // and to gate adaptive source sizing: files on the spine get full source,
    // off-spine peers skeletonize.
    const flow = this.buildFlowFromNamedSymbols(cg, query);

    // Polymorphic-sibling detector for adaptive sizing. A class that implements/
    // extends a supertype shared by >= MIN_SIBLINGS classes is one of many
    // INTERCHANGEABLE implementations (OkHttp's 14 `: Interceptor` classes —
    // showing one + the rest as signatures is enough), as opposed to a DISTINCT
    // pipeline step (Excalidraw's `renderStaticScene`, which shares no supertype and
    // must stay full or the agent loses real content). Only off-spine sibling files
    // skeletonize; distinct steps and on-spine files keep full source. Cache
    // supertype→(has ≥N implementers) so this stays a handful of edge queries.
    const MIN_SIBLINGS = 3;
    const siblingSuper = new Map<string, boolean>();
    const isPolymorphicSibling = (nodes: Node[]): boolean => {
      for (const n of nodes) {
        for (const e of cg.getOutgoingEdges(n.id)) {
          if (e.kind !== 'implements' && e.kind !== 'extends') continue;
          let many = siblingSuper.get(e.target);
          if (many === undefined) {
            many = cg.getIncomingEdges(e.target)
              .filter((x) => x.kind === 'implements' || x.kind === 'extends').length >= MIN_SIBLINGS;
            siblingSuper.set(e.target, many);
          }
          if (many) return true;
        }
      }
      return false;
    };

    // A file that DEFINES a polymorphic supertype (a class/interface with ≥
    // MIN_SIBLINGS implementers) AND co-locates its subclasses is a redundant
    // "family" file — Django's compiler.py holds `SQLCompiler` + its 4 subclasses
    // (SQLInsert/Update/Delete/AggregateCompiler) in 2,266 lines. Such files are
    // huge and read-anyway, so they should STILL skeletonize even when the agent
    // named a method in them: a full one eats ~6.5K of the explore budget (Django
    // is pinned at the 28K cap, truncating), starving the sibling files the agent
    // then Reads. This flag OVERRIDES the named-callable spare below — it does NOT
    // by itself spare a file. (OkHttp's RealCall implements the `Lockable` mixin
    // but defines no ≥3-impl supertype, so the named spare keeps it full.)
    const superMany = new Map<string, boolean>();
    const definesPolymorphicSupertype = (nodes: Node[]): boolean => {
      for (const n of nodes) {
        if (n.kind !== 'class' && n.kind !== 'interface' && n.kind !== 'struct'
            && n.kind !== 'trait' && n.kind !== 'protocol' && n.kind !== 'type_alias') continue;
        let many = superMany.get(n.id);
        if (many === undefined) {
          many = cg.getIncomingEdges(n.id)
            .filter((x) => x.kind === 'implements' || x.kind === 'extends').length >= MIN_SIBLINGS;
          superMany.set(n.id, many);
        }
        if (many) return true;
      }
      return false;
    };

    lines.push('### Source Code');
    lines.push('');
    lines.push('> The code below is the **verbatim, current on-disk source** of these files — re-read from disk on this call and line-numbered, byte-for-byte identical to what the Read tool returns. It is NOT a summary, outline, or stale cache. Treat each block as a Read you have already performed: do not Read a file shown here.');
    lines.push('');

    let totalChars = lines.join('\n').length;
    let filesIncluded = 0;
    let anyFileTrimmed = false;

    for (const [filePath, group] of sortedFiles) {
      if (filesIncluded >= maxFiles) break;
      // A file DEFINES a named/spine symbol (the answer) vs merely references the
      // flow. Past 90% budget, stop pulling INCIDENTAL files — but keep scanning
      // for necessary ones, which render even past the cap (bounded by maxFiles).
      // Without this `continue` (was an unconditional `break`), the loop stopped
      // after the build + validators-exec files and never reached the ranked-in
      // validate-logic file (Alamofire's Validation.swift).
      const fileNecessary = group.nodes.some(n =>
        entryNodeIds.has(n.id) || flow.pathNodeIds.has(n.id) || flow.uniqueNamedNodeIds.has(n.id));
      if (!fileNecessary && totalChars > budget.maxOutputChars * 0.9) continue;

      const absPath = validatePathWithinRoot(projectRoot, filePath);
      if (!absPath || !existsSync(absPath)) continue;

      let fileContent: string;
      try {
        fileContent = readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      const fileLines = fileContent.split('\n');
      const lang = group.nodes[0]?.language || '';

      // Adaptive sizing (CODEGRAPH_ADAPTIVE_EXPLORE, default on): collapse a file
      // to a per-symbol view when it's a redundant member of a polymorphic family.
      // Engages iff ALL hold:
      //   1. a flow spine exists,
      //   2. no symbol in the file is on that spine (it's not the mechanism path),
      //   3. it IS a polymorphic sibling (≥ MIN_SIBLINGS impls of a shared supertype),
      //   4. it is NOT SPARED, where a file is spared iff the agent named a
      //      (near-)UNIQUE callable in it (`getResponseWithInterceptorChain`, 1 def →
      //      keep RealCall.kt full) UNLESS the file DEFINES the family supertype (a
      //      base+subclasses "family" file like Django's compiler.py — collapse it).
      //      Uniqueness matters: `as_sql` has 110 defs across every Compiler/Expression
      //      subclass; naming it must NOT keep every backend variant + test file full
      //      and flood the budget. That's why the spare reads uniqueNamedNodeIds.
      // Within a collapsed file the render is PER-SYMBOL (condition B): a method the
      // agent NAMED or that's on the spine is shown with its FULL body (so the agent
      // doesn't Read the file back for it — Django's SQLCompiler.execute_sql/as_sql);
      // every other symbol is just its signature. So the base mechanism survives while
      // the file's other ~80 symbols + the redundant subclasses collapse to one line each.
      const spareNamed = group.nodes.some(n => flow.uniqueNamedNodeIds.has(n.id));
      const fileDefinesSuper = definesPolymorphicSupertype(group.nodes);
      const spared = spareNamed && !fileDefinesSuper;
      const CALLABLE_BODY = new Set(['method', 'function', 'constructor', 'component']);
      const hasSpineNode = group.nodes.some(n => flow.pathNodeIds.has(n.id));
      // On-spine god-file: the flow path runs THROUGH this file, but it also holds
      // many OTHER named methods, and rendering all of them in full blows the
      // per-file budget and starves the other flow files (Alamofire: the agent
      // names ~7 Session.swift methods — the build spine PLUS off-path
      // task/didCompleteTask — far past the whole response budget). Engage the
      // per-symbol view to keep the SPINE full and collapse the off-path named
      // methods to signatures. Only when there IS off-path content to shed —
      // otherwise the spine is irreducible (a sequential flow has no redundancy),
      // so leave it to the normal full render.
      const namedBodyChars = group.nodes
        .filter(n => CALLABLE_BODY.has(n.kind) && (flow.pathNodeIds.has(n.id) || flow.uniqueNamedNodeIds.has(n.id)))
        .reduce((s, n) => s + fileLines.slice(n.startLine - 1, n.endLine).join('\n').length, 0);
      const onSpineGodFile = hasSpineNode
        && namedBodyChars > budget.maxCharsPerFile
        && group.nodes.some(n => CALLABLE_BODY.has(n.kind) && flow.uniqueNamedNodeIds.has(n.id) && !flow.pathNodeIds.has(n.id));
      if (adaptiveExploreEnabled() && flow.pathNodeIds.size > 0
          && (onSpineGodFile || (!hasSpineNode && isPolymorphicSibling(group.nodes) && !spared))) {
        const syms = group.nodes
          .filter(n => n.kind !== 'import' && n.kind !== 'export' && n.startLine > 0)
          .sort((a, b) => a.startLine - b.startLine);
        // Pass 1: choose which symbols get a FULL body, by priority, greedily within
        // a per-file body cap — so one huge family file can't body every named method
        // and crowd out the other flow files (Django's query.py). A symbol earns a
        // body if it's on-spine, or UNIQUELY named (`SQLCompiler.execute_sql`), or a
        // co-named method WHEN this file DEFINES the family supertype (so the base
        // `SQLCompiler.as_sql` body shows, but the 110 leaf `as_sql` overrides — and
        // OkHttp's 5 `intercept`s if the agent names `intercept` — stay signatures).
        const prio = (n: Node) => !CALLABLE_BODY.has(n.kind) ? 99
          : flow.pathNodeIds.has(n.id) ? 0
          : flow.uniqueNamedNodeIds.has(n.id) ? 1
          : (fileDefinesSuper && flow.namedNodeIds.has(n.id)) ? 2 : 99;
        // One ~250-line WINDOW per file. syms are taken by priority (spine first,
        // then uniquely-named, then family-base), and the cap applies to ALL of
        // them — including the spine — so a big-spine god-file (tokio's worker.rs:
        // run→run_task→next_task→steal_work) can't eat the whole response and
        // starve the co-flow file (harness.rs's poll). The native agent windows
        // such a file too (~190 lines at a time), so this mimics, not truncates.
        // Always emit ≥1 (never an empty section).
        const bodyCap = budget.maxCharsPerFile * 1.5;
        const bodyIds = new Set<string>();
        let bodyChars = 0;
        for (const n of syms.filter(n => prio(n) < 99 && n.endLine >= n.startLine).sort((a, b) => prio(a) - prio(b))) {
          const sz = fileLines.slice(n.startLine - 1, n.endLine).join('\n').length;
          if (bodyChars + sz > bodyCap && bodyIds.size > 0) continue;
          bodyIds.add(n.id);
          bodyChars += sz;
        }
        // Pass 2: render in line order — full body for chosen symbols, else the
        // signature line (capped, with a "+N more" tail so the structure map of a
        // god-file doesn't itself bloat the budget).
        const skel: string[] = [];
        let coveredUntil = 0; // skip symbols already inside an emitted body
        let sigCount = 0, sigDropped = 0;
        const SIG_MAX = Math.max(12, budget.maxSymbolsInFileHeader * 2);
        for (const n of syms) {
          if (n.startLine <= coveredUntil) continue;
          if (bodyIds.has(n.id)) {
            const end = n.endLine;
            const body = fileLines.slice(n.startLine - 1, end).join('\n');
            skel.push(exploreLineNumbersEnabled() ? numberSourceLines(body, n.startLine) : body);
            coveredUntil = end;
          } else {
            // Elide the body, emit the signature. node.startLine can point at a
            // decorator/annotation, so scan forward for the line that names the symbol.
            let lineNo = n.startLine;
            for (let k = 0; k < 4; k++) {
              if ((fileLines[n.startLine - 1 + k] || '').includes(n.name)) { lineNo = n.startLine + k; break; }
            }
            if (lineNo <= coveredUntil) continue;
            if (sigCount >= SIG_MAX) { sigDropped++; continue; }
            const sig = (fileLines[lineNo - 1] || '').trim();
            if (sig) { skel.push(exploreLineNumbersEnabled() ? `${lineNo}\t${sig}` : sig); sigCount++; }
          }
        }
        if (sigDropped > 0) skel.push(`… +${sigDropped} more (signatures elided)`);
        if (skel.length > 0) {
          const names = [...new Set(group.nodes.filter(n => n.kind !== 'import' && n.kind !== 'export').map(n => n.name))]
            .slice(0, budget.maxSymbolsInFileHeader).join(', ');
          // Steer the agent to codegraph_explore for an elided body — NEVER to
          // Read. The old "Read for more" / "Read for a full body" tags invited
          // a Read of the very file just skeletonized; on a central, wanted file
          // (Session.swift, DataRequest.swift) that fired an over-investigation
          // spiral (the agent Read the skeletonized file, then kept digging).
          // CLAUDE.md: explore output must never tell the agent to Read.
          const tag = bodyIds.size > 0
            ? 'focused (the methods you named in full, the rest as signatures — codegraph_explore a signature by name for its body; do NOT Read)'
            : 'skeleton (signatures only — codegraph_explore a name for its full body; do NOT Read)';
          lines.push(`#### ${filePath} — ${names} · ${tag}`, '', '```' + lang, skel.join('\n'), '```', '');
          totalChars += skel.join('\n').length + 120;
          filesIncluded++;
          continue;
        }
      }

      // Whole-file rule: if a relevant file is small enough to afford, return it
      // ENTIRELY instead of clustering. Clustering exists to tame god-files
      // (App.tsx ~13k lines); on a ~134-line component a cluster is a lossy
      // subset of a file the agent will just Read in full anyway — costing a
      // round-trip and a re-read every later turn. Reserve clustering for files
      // too big to ship whole. Still bounded by the total maxOutputChars check.
      //
      // CENTRAL files (where the query's entry points live) get a larger — but
      // bounded — ceiling: they're the heart of the answer, the file(s) the agent
      // would Read whole, so a genuinely small one comes back whole rather than as
      // thin clusters. A LARGE central file (the 791-line org-user store) exceeds
      // the ceiling and falls through to sectioning/clustering below — full method
      // bodies + signatures — so we never dump (or overflow on) a whole god-file.
      const isCentralFile = centralFiles.has(filePath);
      // Central files get a slightly larger whole-file window than peripheral ones,
      // but a TIGHT one (~1.5× the per-file cap): the native read of a central file
      // is a ~150–250 line orientation window, NOT the whole file. A flat "whole
      // central file" both overflowed the inline cap AND starved the co-flow files
      // (worker.rs ate the budget, dropping harness.rs's poll). A larger central
      // file falls through to per-method windowing/clustering below.
      const WHOLE_FILE_MAX_LINES = isCentralFile ? 280 : 220;
      const WHOLE_FILE_MAX_CHARS = isCentralFile
        ? Math.min(Math.max(0, budget.maxOutputChars - totalChars - 200), Math.round(budget.maxCharsPerFile * 1.5))
        : budget.maxCharsPerFile * 3;
      if (fileLines.length <= WHOLE_FILE_MAX_LINES && fileContent.length <= WHOLE_FILE_MAX_CHARS) {
        const body = fileContent.replace(/\n+$/, '');
        let wholeSection = exploreLineNumbersEnabled() ? numberSourceLines(body, 1) : body;
        const uniqSymbols = [...new Set(
          group.nodes
            .filter(n => n.kind !== 'import' && n.kind !== 'export')
            .map(n => `${n.name}(${n.kind})`)
        )];
        const headerNames = uniqSymbols.slice(0, budget.maxSymbolsInFileHeader);
        const omitted = uniqSymbols.length - headerNames.length;
        const wholeHeader = `#### ${filePath} — ${omitted > 0 ? `${headerNames.join(', ')}, +${omitted} more` : headerNames.join(', ')}`;

        if (!fileNecessary && totalChars + wholeSection.length + 200 > budget.maxOutputChars) {
          // Don't slice a whole file mid-method: an incidental file that doesn't
          // fit is skipped; a necessary one (below) renders in full. Half a file
          // forces the Read this is meant to prevent.
          anyFileTrimmed = true;
          continue;
        }
        lines.push(wholeHeader, '', '```' + lang, wholeSection, '```', '');
        totalChars += wholeSection.length + 200;
        filesIncluded++;
        continue;
      }

      // Cluster nearby symbols to avoid reading huge gaps between distant symbols.
      // Sort by start line, then merge overlapping/adjacent ranges (within the
      // adaptive gap threshold). Include both node ranges AND edge source
      // locations so template sections with component usages/calls are
      // covered (not just script block symbols).
      //
      // Each range carries an `importance` score so we can rank clusters
      // when the per-file budget forces us to drop some: entry-point nodes
      // are worth 10, directly-connected nodes 3, peripheral nodes 1, and
      // bare edge-source lines 2 (less than a connected node but more than
      // a peripheral one — they hint at a reference but aren't a definition).
      // Container kinds whose body can span most/all of a file. When such a
      // node covers most of the file we drop it from the ranges: keeping it
      // would merge every method inside it into one giant cluster spanning
      // the whole file, which then tail-trims down to just the container's
      // opening lines (its header/declarations) and buries the methods the
      // query actually asked about (#185 follow-up — Session.swift in
      // Alamofire is the canonical case: the `Session` class spans ~1,400
      // lines). We want the granular symbols inside, not the envelope.
      const ENVELOPE_KINDS = new Set(['file', 'module', 'class', 'struct', 'interface', 'enum', 'namespace', 'protocol', 'trait', 'component']);
      // Cluster from this file's gathered nodes PLUS any callable the agent NAMED that
      // lives here. Explore's relevance gather can miss a named method def in a huge
      // non-sibling file — Django's query.py is 3,040 lines and `_fetch_all` (L2237)
      // was gathered only as call-reference edges, never as a def, so it formed no
      // cluster and the agent Read it back. Inject named defs directly and rank them
      // ABOVE connected/glue nodes (importance 9) so their cluster wins the per-file
      // budget — the agent explicitly asked for these symbols.
      const rangeNodes = new Map<string, Node>();
      for (const n of group.nodes) if (n.startLine > 0 && n.endLine > 0) rangeNodes.set(n.id, n);
      for (const id of flow.namedNodeIds) {
        if (rangeNodes.has(id)) continue;
        const n = cg.getNode(id);
        if (n && n.filePath === filePath && n.startLine > 0 && n.endLine > 0) rangeNodes.set(id, n);
      }
      const ranges: Array<{ start: number; end: number; name: string; kind: string; importance: number }> = [...rangeNodes.values()]
        // Drop whole-file envelope nodes (containers covering >50% of the file).
        .filter(n => !(ENVELOPE_KINDS.has(n.kind) && (n.endLine - n.startLine + 1) > fileLines.length * 0.5))
        .map(n => {
          let importance = 1;
          if (entryNodeIds.has(n.id)) importance = 10;
          else if (flow.namedNodeIds.has(n.id)) importance = 9; // agent named it → keep its cluster
          else if (glueNodeIds.has(n.id)) importance = 6; // bridging caller/callee of an entry
          else if (connectedToEntry.has(n.id)) importance = 3;
          return { start: n.startLine, end: n.endLine, name: n.name, kind: n.kind, importance };
        });

      // Add edge source locations in this file — captures template references
      // (component usages, event handlers) that aren't nodes themselves.
      // Query edges directly from the DB (not just the subgraph) because BFS
      // traversal may have pruned template reference targets due to node budget.
      const edgeLines = new Set<string>(); // dedup by "line:name"
      for (const node of group.nodes) {
        const outgoing = cg.getOutgoingEdges(node.id);
        for (const edge of outgoing) {
          if (!edge.line || edge.line <= 0 || edge.kind === 'contains') continue;
          const key = `${edge.line}:${edge.target}`;
          if (edgeLines.has(key)) continue;
          edgeLines.add(key);
          // Look up target name from subgraph first, fall back to edge kind
          const targetNode = subgraph.nodes.get(edge.target);
          const targetName = targetNode?.name ?? edge.kind;
          ranges.push({ start: edge.line, end: edge.line, name: targetName, kind: edge.kind, importance: 2 });
        }
      }

      ranges.sort((a, b) => a.start - b.start);

      if (ranges.length === 0) continue;

      const gapThreshold = budget.gapThreshold;
      const clusters: Array<{ start: number; end: number; symbols: string[]; score: number; maxImportance: number }> = [];
      let current = {
        start: ranges[0]!.start,
        end: ranges[0]!.end,
        symbols: [`${ranges[0]!.name}(${ranges[0]!.kind})`],
        score: ranges[0]!.importance,
        maxImportance: ranges[0]!.importance,
      };

      for (let i = 1; i < ranges.length; i++) {
        const r = ranges[i]!;
        if (r.start <= current.end + gapThreshold) {
          current.end = Math.max(current.end, r.end);
          current.symbols.push(`${r.name}(${r.kind})`);
          current.score += r.importance;
          current.maxImportance = Math.max(current.maxImportance, r.importance);
        } else {
          clusters.push(current);
          current = {
            start: r.start,
            end: r.end,
            symbols: [`${r.name}(${r.kind})`],
            score: r.importance,
            maxImportance: r.importance,
          };
        }
      }
      clusters.push(current);

      // Build file section output from clusters, capped by per-file budget.
      // The pathological case (#185): a file like Session.swift where every
      // method is adjacent collapses into one cluster spanning the whole
      // file, and dumping that into the agent's context is most of the
      // token cost on small projects. We pick clusters in priority order
      // until the per-file char cap is hit. Truly enormous single clusters
      // get tail-trimmed with a marker.
      const contextPadding = 3;
      const withLineNumbers = exploreLineNumbersEnabled();
      const buildSection = (c: { start: number; end: number }): string => {
        const startIdx = Math.max(0, c.start - 1 - contextPadding);
        const endIdx = Math.min(fileLines.length, c.end + contextPadding);
        const slice = fileLines.slice(startIdx, endIdx).join('\n');
        // startIdx is 0-based, so the slice's first line is line startIdx + 1.
        return withLineNumbers ? numberSourceLines(slice, startIdx + 1) : slice;
      };
      // Language-neutral separator (no `//` — not a comment in Python, Ruby,
      // etc.). With line numbers on, the line-number jump also signals the gap.
      const GAP_MARKER = '\n\n... (gap) ...\n\n';

      // Rank clusters for inclusion under the per-file cap. Entry-point
      // clusters come first: a cluster containing a query entry point
      // (importance 10) must outrank a dense block of mere declarations,
      // otherwise on a large file like Session.swift the top-of-file class
      // header + property list (many adjacent low-importance nodes, high
      // density) wins the budget and buries the actual methods the query
      // asked about (perform/didCreateURLRequest/task live deep in the
      // file). Within the same importance tier, prefer density (score per
      // line) so we still favor focused clusters over sprawling ones, then
      // smaller span as a cheap-to-include tiebreak.
      const rankedClusters = clusters
        .map((c, i) => ({ idx: i, span: c.end - c.start + 1, c }))
        .sort((a, b) => {
          if (b.c.maxImportance !== a.c.maxImportance) return b.c.maxImportance - a.c.maxImportance;
          const densityA = a.c.score / a.span;
          const densityB = b.c.score / b.span;
          if (densityB !== densityA) return densityB - densityA;
          if (b.c.score !== a.c.score) return b.c.score - a.c.score;
          return a.span - b.span;
        });

      // Per-file budget is the SMALLER of the per-file cap and what's left of the
      // total output cap — so selection (which ranks by importance) keeps the
      // high-importance clusters and drops peripheral ones, instead of the
      // downstream source-order trim slicing off whatever comes last in the file.
      // That source-order slice is what cut Django's `_fetch_all` (L2237, importance
      // 9 — agent-named) when query.py was the last of four big files to be emitted.
      const fileBudget = Math.min(budget.maxCharsPerFile, Math.max(0, budget.maxOutputChars - totalChars - 200));
      const chosenIndices = new Set<number>();
      let projectedChars = 0;
      for (const rc of rankedClusters) {
        const sectionLen = buildSection(rc.c).length + (chosenIndices.size > 0 ? GAP_MARKER.length : 0);
        // Always take the top-ranked cluster, even if oversize, so we don't
        // return an empty file section (agent would then re-Read the file,
        // negating the savings).
        if (chosenIndices.size === 0) {
          chosenIndices.add(rc.idx);
          projectedChars += sectionLen;
          continue;
        }
        if (projectedChars + sectionLen > fileBudget) continue;
        chosenIndices.add(rc.idx);
        projectedChars += sectionLen;
      }

      // Emit chosen clusters in source order so the file reads top-to-bottom.
      let fileSection = '';
      const allSymbols: string[] = [];
      for (let i = 0; i < clusters.length; i++) {
        if (!chosenIndices.has(i)) continue;
        const cluster = clusters[i]!;
        const section = buildSection(cluster);
        if (fileSection.length > 0) fileSection += GAP_MARKER;
        fileSection += section;
        allSymbols.push(...cluster.symbols);
      }

      // A chosen cluster is a COMPLETE method-range — we never cut through a body.
      // An oversize single cluster (a long monolithic function) renders in FULL:
      // half a method is useless (the agent just Reads the rest for the other half),
      // which is the very fallback explore exists to prevent. A pathological file is
      // bounded by the per-file cluster SELECTION above + the total hard ceiling.
      if (chosenIndices.size < clusters.length) {
        anyFileTrimmed = true;
      }

      // Dedupe + cap the symbols list shown in the per-file header. Some
      // files (Session.swift in Alamofire) produced 3.4KB symbol lists
      // from cluster scoring + edge-source lines, dwarfing the per-file
      // body cap. Show top names by frequency, with a "+N more" tail.
      const symbolCounts = new Map<string, number>();
      for (const s of allSymbols) {
        symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
      }
      const sortedSymbols = [...symbolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name);
      const headerCap = budget.maxSymbolsInFileHeader;
      const headerSymbols = sortedSymbols.slice(0, headerCap);
      const omittedCount = sortedSymbols.length - headerSymbols.length;
      const headerSuffix = omittedCount > 0
        ? `${headerSymbols.join(', ')}, +${omittedCount} more`
        : headerSymbols.join(', ');
      const fileHeader = `#### ${filePath} — ${headerSuffix}`;

      // The total cap bounds INCIDENTAL files only. A file that DEFINES a symbol
      // the agent named (or that's on the flow spine) renders even when the
      // nominal total is used up — it's the answer, and the set is bounded by
      // maxFiles AND by true-spine/named-seeding having already trimmed each file
      // to its necessary content. A file that merely REFERENCES the flow
      // (Combine.swift name-drops request/task) is incidental → still capped, so
      // freed budget never leaks into noise. This is the last god-file layer:
      // build (Session, true-spined) + validators-exec (Request) + validate
      // (DataRequest/Validation) all render, instead of the cap dropping whichever
      // phase the file order happened to put last.
      if (!fileNecessary && totalChars + fileSection.length + 200 > budget.maxOutputChars) {
        // Incidental file that doesn't fit: SKIP it whole — never slice mid-method.
        // Keep scanning for necessary files (which bypass this cap and render in
        // full, bounded by the hard ceiling).
        anyFileTrimmed = true;
        continue;
      }

      lines.push(fileHeader);
      lines.push('');
      lines.push('```' + lang);
      lines.push(fileSection);
      lines.push('```');
      lines.push('');

      totalChars += fileSection.length + 200;
      filesIncluded++;
    }

    // Add remaining files as references (from both relevant and peripheral files).
    // Small projects (per budget) skip this — the relevant story already fits
    // in the source section, and a trailing pointer list is pure overhead.
    if (budget.includeAdditionalFiles) {
      const remainingRelevant = sortedFiles.slice(filesIncluded);
      const peripheralFiles = [...fileGroups.entries()]
        .filter(([, group]) => group.score < 3)
        .sort((a, b) => b[1].score - a[1].score);
      const remainingFiles = [...remainingRelevant, ...peripheralFiles];
      if (remainingFiles.length > 0) {
        lines.push('### Not shown above — explore these names for their source');
        lines.push('');
        for (const [filePath, group] of remainingFiles.slice(0, 10)) {
          const symbols = group.nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
          lines.push(`- ${filePath}: ${symbols}`);
        }
        if (remainingFiles.length > 10) {
          lines.push(`- ... and ${remainingFiles.length - 10} more files`);
        }
      }
    }

    // Add completeness signal so agents know they don't need to re-read these files.
    // On small projects the budget gates this off — but if we actually had to
    // trim or drop clusters, surface a brief note so the agent knows it can
    // still Read for more detail.
    if (budget.includeCompletenessSignal) {
      lines.push('');
      lines.push('---');
      lines.push(`> **Complete source for ${filesIncluded} files is included above — do NOT re-read them.** If your question also needs files/symbols listed under "Not shown above" (or any area this call didn't cover), make ANOTHER codegraph_explore targeting those names — it returns the same source with line numbers and is cheaper and more complete than reading. Reserve Read for a single specific line range explore can't surface.`);
    } else if (anyFileTrimmed) {
      lines.push('');
      lines.push(`> Some file sections were trimmed for size. For a specific symbol you still need, run another \`codegraph_explore\` (or \`codegraph_node\`) with its exact name — line-numbered source, cheaper and more complete than Read.`);
    }

    // Add explore budget note based on project size
    if (budget.includeBudgetNote) {
      try {
        const stats = cg.getStats();
        const callBudget = getExploreBudget(stats.fileCount);
        lines.push('');
        lines.push(`> **Explore budget: ${callBudget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).** Each call covers ~6 files; if your question spans more, spend your remaining calls on the uncovered area BEFORE falling back to Read — another explore is cheaper and more complete than reading those files. Synthesize once you've used ${callBudget}.`);
      } catch {
        // Stats unavailable — skip budget note
      }
    }

    // Final ceiling — an ABSOLUTE inline cap, not a multiple of the budget. The
    // render loop renders necessary (named/spine) files even a bit past
    // maxOutputChars and caps only incidental ones, so this is the last safety.
    // It MUST stay under the host's inline tool-result limit (~25K chars): above
    // that the result is externalized to a file the agent Reads back (a 35K
    // vscode explore did exactly this in the n=4 A/B). So allow a little
    // necessary overflow above the 24K budget, but hard-stop at 25K — never into
    // externalize territory.
    const output = flow.text + lines.join('\n');
    const hardCeiling = Math.min(Math.round(budget.maxOutputChars * 1.5), 25000);
    if (output.length > hardCeiling) {
      // Cut at a FILE-SECTION boundary (the last `#### ` header before the
      // ceiling) so we drop whole trailing file-sections rather than slicing
      // through a method body — a half-rendered method just forces the Read this
      // tool exists to prevent. Fall back to a line boundary only if no section
      // header sits in the back half (degenerate single-giant-section case).
      const cut = output.slice(0, hardCeiling);
      const lastSection = cut.lastIndexOf('\n#### ');
      const boundary = lastSection > hardCeiling * 0.5 ? lastSection : cut.lastIndexOf('\n');
      const safe = boundary > 0 ? cut.slice(0, boundary) : cut;
      return this.textResult(safe + '\n\n... (output truncated to budget; the source above is complete and verbatim — treat it as already Read. For any area not covered, run another codegraph_explore with the specific names — do NOT Read these files.)');
    }
    return this.textResult(output);
  }

  /**
   * Handle codegraph_node
   */
  private async handleNode(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.targets !== undefined) {
      const conflicting = [
        'symbol', 'file', 'line', 'offset', 'limit', 'symbolsOnly', 'outlineQuery', 'outlineQueries', 'outlineLimit',
      ].filter((key) => args[key] !== undefined);
      if (conflicting.length > 0) {
        return this.errorResult(
          `codegraph_node batch mode cannot combine targets with top-level ${conflicting.join(', ')}. ` +
          'Move each precise symbol/member/text/file-region request inside targets.',
        );
      }
      const bundled = await this.handleContext({
        targets: args.targets,
        includeRelations: args.includeRelations,
        expand: args.expand,
        expectedMissing: args.expectedMissing,
        projectPath: args.projectPath,
      });
      if (!bundled.isError && bundled.content[0]?.type === 'text') {
        bundled.content[0].text =
          '> Native codegraph_node batch mode used one merged implementation bundle. Treat every source range below as already read.\n\n' +
          bundled.content[0].text;
      }
      return bundled;
    }

    if (args.expand !== undefined || args.expectedMissing !== undefined) {
      return this.errorResult('codegraph_node expand and expectedMissing are batch-only; provide targets=[...].');
    }

    const fileHint = typeof args.file === 'string' && args.file.trim() ? args.file.trim() : undefined;
    const lineHint = typeof args.line === 'number' && args.line > 0 ? args.line : undefined;
    const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : undefined;
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : undefined;
    const symbolRaw = typeof args.symbol === 'string' ? args.symbol.trim() : '';
    const inferredOutlineMode = Boolean(
      !symbolRaw && fileHint && args.symbolsOnly === undefined &&
      (args.outlineQuery !== undefined || args.outlineQueries !== undefined || args.outlineLimit !== undefined)
    );
    const symbolsOnly = args.symbolsOnly === true || inferredOutlineMode;
    const outlineQuery = typeof args.outlineQuery === 'string' ? args.outlineQuery.trim() : undefined;
    const outlineQueries: string[] = [];
    if (outlineQuery) {
      for (const token of outlineQuery.split('|').map((part) => part.trim()).filter(Boolean)) {
        if (!outlineQueries.includes(token)) outlineQueries.push(token);
      }
    }
    if (args.outlineQueries !== undefined) {
      if (!Array.isArray(args.outlineQueries) || args.outlineQueries.length < 1 || args.outlineQueries.length > 8) {
        return this.errorResult('outlineQueries must contain 1 to 8 filters');
      }
      for (let i = 0; i < args.outlineQueries.length; i++) {
        const value = this.validateString(args.outlineQueries[i], `outlineQueries[${i}]`, 256);
        if (typeof value !== 'string') return value;
        const token = value.trim();
        if (!token) return this.errorResult(`outlineQueries[${i}] must not be blank`);
        if (!outlineQueries.includes(token)) outlineQueries.push(token);
      }
    }
    if (outlineQueries.length > 8) return this.errorResult('outline filters exceed 8 after expanding outlineQuery OR terms');
    const outlineLimit = typeof args.outlineLimit === 'number' && Number.isFinite(args.outlineLimit)
      ? clamp(Math.floor(args.outlineLimit), 1, MCP_NODE_MAX_OUTLINE_SYMBOLS)
      : MCP_NODE_DEFAULT_OUTLINE_SYMBOLS;
    const hasWindowArgs = args.offset !== undefined || args.limit !== undefined;
    const hasOutlineArgs = symbolsOnly || args.outlineQuery !== undefined || args.outlineQueries !== undefined || args.outlineLimit !== undefined;
    // A surprisingly common agent call supplies an exact symbol and also carries
    // file-outline knobs copied from a previous call. This is not ambiguous: the
    // exact symbol is the smaller context target, so accept it and ignore only
    // the outline-only knobs. A file window remains a hard conflict because the
    // caller may genuinely be asking for either source range.
    const autoCorrectedOutlineArgs = Boolean(symbolRaw && !hasWindowArgs && hasOutlineArgs);
    const autoCorrectedOutlineWindow = Boolean(!symbolRaw && fileHint && symbolsOnly && hasWindowArgs);
    // `symbolsOnly=true` expresses an intent to inspect structure, so preserve
    // that intent by rendering the named container outline in symbol mode.
    const includeCode = args.includeCode === true || autoCorrectedOutlineArgs;
    const forceOutline = autoCorrectedOutlineArgs;
    const includeRelations = args.includeRelations === true;
    const preciseSymbolTarget = /[.]|::/.test(symbolRaw) || Boolean(fileHint && lineHint !== undefined);
    const relationshipRouteNotice = preciseSymbolTarget && !includeRelations
      ? '> Caller/callee relations were omitted. Use `codegraph_callers` or `codegraph_callees` only if that relationship direction is needed.'
      : '';

    // File windows and symbol reads are genuinely different requests, so keep
    // this combination explicit and return copyable corrected calls.
    if (symbolRaw && hasWindowArgs) {
      const symbolExample = `{ symbol: ${JSON.stringify(symbolRaw)}, file: ${JSON.stringify(fileHint ?? 'path/to/file.cpp')}, line: 123, includeCode: true }`;
      const outlineExample = `{ file: ${JSON.stringify(fileHint ?? 'path/to/file.cpp')}, symbolsOnly: true, outlineQuery: "optional-name" }`;
      return this.errorResult(
        'codegraph_node symbol mode cannot use offset, limit, symbolsOnly, outlineQuery, or outlineLimit. ' +
        `Choose ONE corrected call:\n- Known symbol: ${symbolExample}\n- Unknown symbol in file: ${outlineExample}`
      );
    }

    // Guard MCP file mode against accidental whole-file context dumps. The CLI
    // retains its explicit whole-file workflow for scripts/CI; agent calls must
    // choose an outline or a small, intentional source window.
    if (!symbolRaw && fileHint) {
      if (includeCode) {
        return this.errorResult(
          'includeCode is only valid in symbol mode. For a file outline use ' +
          '{ file, symbolsOnly: true }; for source use { file, offset, limit } with limit <= 500.'
        );
      }
      if (args.includeRelations !== undefined) {
        return this.errorResult('includeRelations is only valid in symbol mode.');
      }
      if (!symbolsOnly && (args.outlineQuery !== undefined || args.outlineQueries !== undefined || args.outlineLimit !== undefined)) {
        return this.errorResult('outlineQuery, outlineQueries, and outlineLimit require symbolsOnly=true.');
      }
      if (!symbolsOnly) {
        if (offset === undefined || limit === undefined) {
          return this.errorResult(
            'MCP file mode rejects bare or partially bounded file reads. Use ' +
            '{ file, symbolsOnly: true } first, or provide both offset and limit (limit <= 500).'
          );
        }
      }
      const cg = this.getCodeGraph(args.projectPath as string | undefined);
      return this.handleFileView(cg, fileHint, {
        offset: autoCorrectedOutlineWindow ? undefined : offset,
        limit: autoCorrectedOutlineWindow || limit === undefined ? undefined : Math.min(limit, MCP_NODE_MAX_FILE_WINDOW_LINES),
        requestedLimit: limit,
        symbolsOnly,
        outlineQuery,
        outlineQueries: outlineQueries.length > 0 ? outlineQueries : undefined,
        outlineLimit,
        notice: [
          inferredOutlineMode
            ? '> Automatically inferred `symbolsOnly=true` because a file plus `outlineQuery`/`outlineLimit` was supplied.'
            : '',
          autoCorrectedOutlineWindow
            ? '> Automatically used `symbolsOnly` outline mode and ignored copied `offset`/`limit` fields.'
            : '',
        ].filter(Boolean).join('\n') || undefined,
      });
    }

    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);

    const allMatches = this.findSymbolMatches(cg, symbol);
    let matches = allMatches;
    if (matches.length === 0) {
      const needle = this.rawEvidenceNeedle(symbol);
      const evidence = needle
        ? await this.renderRawEvidence(cg, [{ label: symbol, needle, path: fileHint }])
        : '';
      return this.textResult([`Symbol "${symbol}" not found in the codebase`, evidence].filter(Boolean).join('\n\n'));
    }

    // Disambiguate a heavily-overloaded name to a specific definition the caller
    // pinned by file/line (the `file:start-end` a trail or another tool showed it) —
    // so it can fetch e.g. `Harness::poll` at harness.rs:153 out of 50+ `poll`s
    // instead of Reading. A supplied line is an assertion, not a nearest-line
    // guess: when it falls outside every same-file match, preserve the candidates
    // and surface a warning instead of silently returning an unrelated overload.
    const narrowed = this.narrowSymbolMatches(matches, fileHint, lineHint);
    matches = narrowed.matches;
    matches = this.preferContainerMatches(matches, lineHint);
    const hintWarning = this.formatSymbolHintWarning(symbol, narrowed);
    const autoCorrectionNotice = autoCorrectedOutlineArgs
      ? '> Automatically used symbol mode with a named-container outline and ignored `outlineQuery`/`outlineLimit` because an exact `symbol` was supplied.'
      : '';

    // Single definition — the common case.
    const overloadGroups = this.relationshipOverloadGroups(cg, matches, allMatches);
    if (overloadGroups.length === 1) {
      const primary = this.rankExactSymbolNodes(overloadGroups[0]!)[0]!;
      const renderedSection = includeCode
        ? await this.renderImplementationGroup(cg, overloadGroups[0]!, includeRelations, forceOutline)
        : await this.renderNodeSection(cg, primary, false, includeRelations);
      const overloadSummary = this.formatOtherOverloadSummary(cg, symbol, primary);
      return this.textResult(this.truncateOutput(
        [autoCorrectionNotice, hintWarning, renderedSection.text, overloadSummary, relationshipRouteNotice].filter(Boolean).join('\n\n')
      ));
    }

    // Multiple definitions share this name — overloads, or same-named methods on
    // different types (Alamofire `didCompleteTask`/`task`/`validate`, gin
    // `reset`). Returning ONE forces the agent to guess, and when it guesses
    // wrong it READS the file to find the right overload — the dominant
    // codegraph_node read cause on Swift/Go. So return them ALL: pack as many
    // FULL bodies as fit a char budget (the agent gets the one it needs in this
    // one call, no follow-up parameter to learn), and list any remainder by
    // file:start-end so a large overload set can't overflow the per-tool cap.
    const header = [
      autoCorrectionNotice,
      `**${matches.length} definitions named "${symbol}"**`,
    ].filter(Boolean).join('\n\n');
    if (!includeCode) {
      const list = matches.map((n) => `- \`${displaySymbol(n)}\` (${n.kind}) — ${formatDefinitionLocation(n)}`);
      return this.textResult(this.truncateOutput(
        [header, '', 'Re-query with `includeCode: true` to get every body in one call — no need to pick one first.', '', ...list].join('\n'),
      ));
    }

    const BODY_BUDGET = 12000; // leaves room under MAX_OUTPUT_LENGTH for the header + list
    // The CHAR budget is the real limiter — keep the count cap high so a set of
    // SHORT overloads (Alamofire's 10 `validate` variants, each a few lines) all
    // render in full rather than relegating the one the agent wanted to a
    // bodiless list. Only a set of many LARGE bodies hits the char budget first.
    const HARD_CAP = 16;
    const rendered: string[] = [];
    const listed: Node[] = [];
    let used = 0;
    for (const n of matches) {
      if (rendered.length >= HARD_CAP) { listed.push(n); continue; }
      const section = await this.renderNodeSection(cg, n, true, includeRelations, forceOutline);
      // Always emit the first; emit the rest only while within the char budget.
      if (rendered.length === 0 || used + section.text.length <= BODY_BUDGET) {
        rendered.push(section.text);
        used += section.text.length;
      } else {
        listed.push(n);
      }
    }

    const out: string[] = [
      hintWarning,
      header,
      `Returning ${rendered.length} in full${listed.length ? `; ${listed.length} more listed below` : ''} — pick the one you need (no Read required).`,
      '',
      rendered.join('\n\n---\n\n'),
    ];
    if (listed.length) {
      const LIST_CAP = 20;
      const shownList = listed.slice(0, LIST_CAP);
      out.push(
        '',
        '### Other definitions',
        ...shownList.map((n) => `- \`${displaySymbol(n)}\` (${n.kind}) — ${formatDefinitionLocation(n)}`),
      );
      if (listed.length > LIST_CAP) out.push(`- … +${listed.length - LIST_CAP} more`);
      out.push(
        '',
        `> Need one of these in full? Call codegraph_node again with the same \`symbol\` plus \`file\` (e.g. \`"${listed[0]!.filePath.split('/').pop()}"\`) and/or \`line\` — do NOT read the file.`,
      );
    }
    if (relationshipRouteNotice) out.push('', relationshipRouteNotice);
    return this.textResult(this.truncateOutput(out.filter(Boolean).join('\n')));
  }

  /**
   * Guarded MCP file mode: resolve `fileArg` (path or basename) to an indexed
   * file, then return either its structural map (`symbolsOnly`) or a bounded
   * source window (`offset` + `limit`, at most 500 lines). The public handler
   * rejects bare-file requests before reaching this method.
   *
   * Parity goal: the numbered source block is byte-for-byte the shape Read
   * returns (`<n>\t<line>`, no padding), so the agent treats it as a Read — only
   * index-resolved and current on disk. Repetitive dependency paths are omitted
   * from source windows; outlines retain only the compact dependent count. Security:
   * yaml/properties files are summarized by key, never dumped (#383); reads go
   * through validatePathWithinRoot (#527).
   */
  private async handleFileView(
    cg: CodeGraph,
    fileArg: string,
    opts: {
      offset?: number;
      limit?: number;
      symbolsOnly?: boolean;
      outlineQuery?: string;
      outlineQueries?: string[];
      outlineLimit?: number;
      requestedLimit?: number;
      notice?: string;
    } = {},
  ): Promise<ToolResult> {
    const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^(?:\.?\/+)+/, '').replace(/\/+$/, '');
    // Canonicalize so an agent passing a symlink path resolves to the file's
    // canonical (realpath-relative) path as stored. A bare basename (not
    // root-relative) degrades to the normalized basename via realpath ENOENT,
    // so suffix/include matching still works unchanged.
    const wantLower = canonicalFilePath(cg.getProjectRoot(), normalize(fileArg)).toLowerCase();
    const allFiles = cg.getFiles();
    if (allFiles.length === 0) return this.textResult('No files indexed. Run `codegraph index` first.');

    let resolved = allFiles.find((f) => f.path.toLowerCase() === wantLower);
    let candidates: typeof allFiles = [];
    if (!resolved) {
      candidates = allFiles.filter((f) => f.path.toLowerCase().endsWith('/' + wantLower));
      if (candidates.length === 1) resolved = candidates[0];
    }
    if (!resolved && candidates.length === 0) {
      candidates = allFiles.filter((f) => f.path.toLowerCase().includes(wantLower));
      if (candidates.length === 1) resolved = candidates[0];
    }
    if (!resolved && candidates.length > 1) {
      return this.textResult(
        [`"${fileArg}" matches ${candidates.length} indexed files — pass a longer path:`, '',
          ...candidates.slice(0, 25).map((f) => `- ${f.path}`)].join('\n'),
      );
    }
    if (!resolved) {
      return this.textResult(
        `No indexed file matches "${fileArg}". Codegraph indexes source files; configs/docs it doesn't parse won't appear — Read those directly.`,
      );
    }

    const filePath = resolved.path;
    const nodes = cg.getNodesInFile(filePath)
      .filter((n) => n.kind !== 'file' && n.kind !== 'import' && n.kind !== 'export')
      .sort((a, b) => a.startLine - b.startLine);
    const includeDependencySummary = opts.symbolsOnly || CONFIG_LEAF_LANGUAGES.has(resolved.language);
    const dependents = includeDependencySummary ? cg.getFileDependents(filePath) : [];

    // Dependency metadata is useful once in an outline/config summary but is
    // intentionally absent from every repeated source-window response.
    const depSummary = dependents.length
      ? `used by ${dependents.length} file${dependents.length === 1 ? '' : 's'}: ${dependents.slice(0, 8).join(', ')}${dependents.length > 8 ? `, +${dependents.length - 8} more` : ''}`
      : 'no other indexed file depends on it';
    const compactDepSummary = dependents.length
      ? `used by ${dependents.length} file${dependents.length === 1 ? '' : 's'}`
      : 'no other indexed file depends on it';

    // Symbol-map renderer — for symbolsOnly, the config fallback, and read errors.
    const symbolMap = (mapNodes: Node[], heading: string, limit: number): string[] => {
      const lines: string[] = [heading];
      for (const n of mapNodes.slice(0, limit)) {
        const sig = n.signature ? ` ${n.signature.replace(/\s+/g, ' ').trim()}` : '';
        lines.push(`- \`${displaySymbol(n)}\` (${n.kind})${sig} — :${formatSourceRange(n.startLine, n.endLine)}`);
      }
      if (mapNodes.length > limit) lines.push(`- … +${mapNodes.length - limit} more`);
      return lines;
    };

    // symbolsOnly → the cheap structural overview, no source.
    if (opts.symbolsOnly) {
      const queries = (opts.outlineQueries?.length
        ? opts.outlineQueries
        : opts.outlineQuery ? opts.outlineQuery.split('|') : [])
        .map((query) => query.trim().toLowerCase())
        .filter(Boolean);
      const matchesByQuery = queries.map((needle) => nodes.filter((node) =>
        node.name.toLowerCase().includes(needle)
      ));
      const filtered = queries.length > 0
        ? [...new Map(matchesByQuery.flat().map((node) => [node.id, node])).values()]
        : nodes;
      const outlineLimit = clamp(
        opts.outlineLimit ?? MCP_NODE_DEFAULT_OUTLINE_SYMBOLS,
        1,
        MCP_NODE_MAX_OUTLINE_SYMBOLS,
      );
      const broadQuery = matchesByQuery.some((matches) =>
        matches.length >= MCP_NODE_BROAD_OUTLINE_MIN_MATCHES &&
        matches.length / Math.max(nodes.length, 1) >= MCP_NODE_BROAD_OUTLINE_MATCH_RATIO
      );
      const rankFor = (needle: string, candidates: Node[]): Node[] => [...candidates].sort((a, b) => {
        const score = (node: Node): number => {
          const name = node.name.toLowerCase();
          if (name === needle) return 0;
          if (name.startsWith(needle)) return 1;
          return 2;
        };
        return score(a) - score(b) || a.startLine - b.startLine || a.name.localeCompare(b.name);
      });
      const ranked = queries.length === 0
        ? filtered
        : (() => {
          const queues = matchesByQuery.map((matches, index) => rankFor(queries[index]!, matches));
          const seen = new Set<string>();
          const interleaved: Node[] = [];
          for (let offset = 0; queues.some((queue) => offset < queue.length); offset++) {
            for (const queue of queues) {
              const node = queue[offset];
              if (!node || seen.has(node.id)) continue;
              seen.add(node.id);
              interleaved.push(node);
            }
          }
          return interleaved;
        })();
      const effectiveOutlineLimit = broadQuery
        ? Math.min(outlineLimit, MCP_NODE_BROAD_OUTLINE_RESULT_LIMIT)
        : outlineLimit;
      const filterLabel = queries.join('|');
      const filterDescription = queries.length === 1
        ? `outlineQuery="${filterLabel}"`
        : `outline OR="${filterLabel}"`;
      const filterNote = queries.length > 0 ? `; ${filtered.length} match ${filterDescription}` : '';
      const out = [
        ...(opts.notice ? [opts.notice, ''] : []),
        `**${filePath}** — ${nodes.length} symbol${nodes.length === 1 ? '' : 's'}${filterNote}, ${compactDepSummary}`,
        '',
      ];
      if (broadQuery) {
        const percentage = Math.round((filtered.length / Math.max(nodes.length, 1)) * 100);
        out.push(
          `> Query too broad: outline filter="${filterLabel}" matched ${filtered.length}/${nodes.length} symbols (${percentage}%). ` +
          `Showing only the ${effectiveOutlineLimit} best leaf-name candidates. ` +
          'Refine with a more specific leaf symbol/member token.',
          '',
        );
      }
      if (filtered.length) out.push(...symbolMap(ranked, '### Symbols', effectiveOutlineLimit));
      else if (queries.length > 0) out.push(`_No indexed symbols match outline OR="${filterLabel}"._`);
      else out.push('_No indexed symbols in this file._');
      if (!broadQuery && filtered.length > outlineLimit) {
        out.push('', `> Outline capped at ${outlineLimit} of ${filtered.length} matching symbols. Narrow with \`outlineQuery\`; do not read the file to recover the omitted list.`);
      }
      out.push('', '> Choose exact names from this outline. Read one implementation with `codegraph_node`; batch 1–8 precise symbol/member/text/file-region targets with ONE `codegraph_node(targets=[...])` implementation bundle (or `codegraph_context(targets=[...])`). Do not page through the file.');
      return this.textResult(this.truncateOutput(out.join('\n')));
    }

    // SECURITY (#383): never dump a raw config/data file — a yaml/properties
    // line is `key: <secret>`. Summarize by key and point to a real Read.
    if (CONFIG_LEAF_LANGUAGES.has(resolved.language)) {
      const out = [`**${filePath}** — configuration/data file, ${depSummary}`, ''];
      if (nodes.length) out.push(...symbolMap(nodes, '### Keys (values withheld for safety)', MCP_NODE_DEFAULT_OUTLINE_SYMBOLS));
      out.push('', '> Values may be secrets, so codegraph indexes keys only. Read the file directly if you need a value.');
      return this.textResult(this.truncateOutput(out.join('\n')));
    }

    // Read the current bytes from disk through the security chokepoint
    // (validatePathWithinRoot: blocks `../` traversal and symlink escapes, #527).
    const abs = validatePathWithinRoot(cg.getProjectRoot(), filePath);
    let content: string | null = null;
    if (abs) {
      try { content = readFileSync(abs, 'utf-8'); } catch { content = null; }
    }
    if (content === null) {
      const out = [`**${filePath}** — could not read from disk (it may have moved since indexing).`, ''];
      if (nodes.length) out.push(...symbolMap(nodes, '### Symbols', MCP_NODE_DEFAULT_OUTLINE_SYMBOLS));
      out.push('', `> Read \`${filePath}\` directly for its current content.`);
      return this.textResult(this.truncateOutput(out.join('\n')));
    }

    // Split exactly as Read does — keep the trailing empty line a final newline
    // produces (Read numbers it too), so line numbers line up byte-for-byte.
    const fileLines = content.split('\n');
    const total = fileLines.length;

    // Defense in depth: keep the renderer bounded even when another caller
    // supplies a larger value. The public MCP handler reports the auto-clamp.
    const CHAR_BUDGET = 38000;
    const offset = Math.max(1, opts.offset ?? 1);
    if (offset > total) {
      return this.textResult(`**${filePath}** has ${total} line${total === 1 ? '' : 's'} — offset ${offset} is past the end.`);
    }
    const maxLines = Math.min(
      MCP_NODE_MAX_FILE_WINDOW_LINES,
      Math.max(1, opts.limit ?? MCP_NODE_MAX_FILE_WINDOW_LINES),
    );
    const start = offset - 1; // 0-based
    // Numbered lines, byte-for-byte Read's shape: `<n>\t<line>`, no left-pad.
    const numbered: string[] = [];
    let used = filePath.length + 80;
    let i = start;
    for (; i < total && numbered.length < maxLines; i++) {
      const ln = `${i + 1}\t${fileLines[i]}`;
      if (used + ln.length + 1 > CHAR_BUDGET && numbered.length > 0) break;
      numbered.push(ln);
      used += ln.length + 1;
    }
    const shownEnd = start + numbered.length;
    const complete = offset === 1 && shownEnd >= total;
    const header = `**${filePath}** — lines ${offset}–${shownEnd} of ${total}`;

    const clampNotice = (opts.requestedLimit ?? maxLines) > MCP_NODE_MAX_FILE_WINDOW_LINES
      ? `> Requested ${opts.requestedLimit} lines; safely clamped to ${MCP_NODE_MAX_FILE_WINDOW_LINES}.`
      : '';
    const out: string[] = [header, ...(clampNotice ? ['', clampNotice] : []), '', ...numbered];
    if (!complete) {
      out.push(
        '',
        `(lines ${offset}–${shownEnd} of ${total} — stop here unless a specific non-symbol/edit-boundary line is still missing; for named code use \`codegraph_node\` or \`codegraph_context\`; do not request the next file window)`,
      );
    }
    // Self-bounded to CHAR_BUDGET — do NOT route through truncateOutput (15k).
    return this.textResult(out.join('\n'));
  }

  /** Render one symbol: details + (optional) body/outline + its caller/callee trail. */
  private async renderNodeSection(
    cg: CodeGraph,
    node: Node,
    includeCode: boolean,
    includeRelations: boolean = false,
    forceOutline: boolean = false,
    sourceCharBudget: number = SYMBOL_SOURCE_MAX_CHARS,
  ): Promise<RenderedNodeSection> {
    let code: string | null = null;
    let outline: string | null = null;
    if (includeCode) {
      if (forceOutline && CONTAINER_NODE_KINDS.has(node.kind)) {
        outline = this.buildContainerOutlineFromChildren(this.containerChildren(cg, node));
      }
      if (!outline) code = await cg.getCode(node.id);
    }
    const details = this.formatNodeDetails(node, code, outline, sourceCharBudget);
    return {
      text: details.text +
        (includeRelations ? this.formatTrail(cg, node) : this.formatDeclDef(cg, node, false)),
      contentMode: outline
        ? 'outline'
        : code
          ? details.sourceTruncated ? 'source_truncated' : 'source'
          : 'metadata',
    };
  }

  /** Render implementation bodies once; declarations remain compact pointers. */
  private async renderImplementationGroup(
    cg: CodeGraph,
    nodes: Node[],
    includeRelations: boolean,
    forceOutline: boolean = false,
  ): Promise<RenderedImplementationGroup> {
    const unique = this.rankExactSymbolNodes(
      [...new Map(nodes.map((node) => [node.id, node])).values()],
    );
    const definitions = unique.filter((node) => node.isDeclaration !== true);
    const sourceNodes = definitions.length > 0 ? definitions : unique;
    const compactDeclarationCount = definitions.length > 0 ? unique.length - definitions.length : 0;
    const reservedChars = 2_000 + sourceNodes.length * 300;
    const perEndpointSourceBudget = Math.min(
      SYMBOL_SOURCE_MAX_CHARS,
      Math.max(256, Math.floor((MAX_OUTPUT_LENGTH - reservedChars) / Math.max(1, sourceNodes.length))),
    );
    const rendered: RenderedNodeSection[] = [];
    for (const node of sourceNodes) {
      rendered.push(await this.renderNodeSection(
        cg,
        node,
        true,
        includeRelations,
        forceOutline,
        perEndpointSourceBudget,
      ));
    }
    const missingDeclarationPointers = unique
      .filter((node) => node.isDeclaration === true)
      .filter((node) => !rendered.some((section) => section.text.includes(`(${formatDefinitionLocation(node)})`)));
    const modes = new Set(rendered.map((section) => section.contentMode));
    const sourceOnly = [...modes].every((mode) => mode === 'source' || mode === 'source_truncated');
    const contentMode: RenderedContentMode = sourceOnly
      ? modes.has('source_truncated') ? 'source_truncated' : 'source'
      : modes.size === 1
        ? rendered[0]?.contentMode ?? 'metadata'
        : 'mixed';
    if (unique.length <= 1) {
      return { text: rendered[0]?.text ?? '', contentMode };
    }
    const delivery = contentMode === 'source'
      ? compactDeclarationCount > 0
        ? `implementation source included; ${compactDeclarationCount} declaration endpoint${compactDeclarationCount === 1 ? '' : 's'} referenced compactly.`
        : 'all endpoint source included below.'
      : contentMode === 'source_truncated'
        ? compactDeclarationCount > 0
          ? `implementation source safely truncated; ${compactDeclarationCount} declaration endpoint${compactDeclarationCount === 1 ? '' : 's'} referenced compactly.`
          : 'all endpoints include source, safely truncated to the response budget where necessary.'
        : contentMode === 'outline'
          ? 'all endpoints are represented by structural outlines below.'
          : contentMode === 'metadata'
            ? 'indexed source was unavailable, so structural metadata is included below.'
            : 'a mixture of source, outline, and/or structural metadata is included below.';
    return {
      text: [
        `> One logical overload; ${delivery}`,
        '',
        rendered.map((section) => section.text).join('\n\n---\n\n'),
        ...(missingDeclarationPointers.length > 0
          ? [
            '',
            '### Declaration endpoints',
            ...missingDeclarationPointers.map((node) => `- ${this.formatCompactEndpointRef(cg, node)}`),
          ]
          : []),
      ].join('\n'),
      contentMode,
    };
  }

  /**
   * A wrong C++/Java owner is not a graph miss when the exact leaf symbol is
   * already indexed. Surface those structured candidates before considering a
   * repository scan; this turns `OldOwner::create` into a cheap correction.
   */
  private async renderQualifiedOwnerRecovery(
    cg: CodeGraph,
    queryText: string,
    query: string,
    kinds: NodeKind[] | undefined,
    pathHint: string | undefined,
    pathValue: string | undefined,
    lineHint: number | undefined,
    signature: string | undefined,
    limit: number,
    includeCode: boolean,
  ): Promise<string> {
    const normalized = query.replace(/\./g, '::');
    const parts = normalized.split('::').filter(Boolean);
    const leaf = parts.at(-1);
    if (!leaf || parts.length < 2) return '';

    let candidates = cg.getNodesByName(leaf).filter((node) => !kinds || kinds.includes(node.kind));
    if (candidates.length === 0) return '';
    const requestedOwner = parts.slice(0, -1).join('::').toLowerCase();
    const requestedOwnerText = parts.slice(0, -1).join('::');
    const requestedOwnerLeaf = parts.at(-2)!;
    const normalizeQualified = (value: string): string => value.replace(/\./g, '::').toLowerCase();
    const ownerNodes = this.findSymbolMatches(cg, requestedOwnerText).filter((node) => {
      if (!CONTAINER_NODE_KINDS.has(node.kind)) return false;
      const qualified = normalizeQualified(node.qualifiedName);
      return qualified === requestedOwner || (
        node.name.toLowerCase() === requestedOwnerLeaf.toLowerCase() &&
        qualified.endsWith(`::${requestedOwner}`)
      );
    });
    if (ownerNodes.length > 0) {
      const ownerLocations = ownerNodes.slice(0, 3)
        .map((node) => formatDefinitionLocation(node))
        .join(', ');
      const otherOwners = this.rankExactSymbolNodes(candidates)
        .filter((node) => normalizeQualified(node.qualifiedName)
          .split('::').slice(0, -1).join('::') !== requestedOwner)
        .slice(0, Math.min(limit, 5));
      const out = [
        `> Qualified owner mismatch: owner \`${requestedOwnerText}\` is indexed at ${ownerLocations}, but it has no direct member \`${leaf}\`.`,
        '> No unrelated leaf source was inlined.',
      ];
      if (otherOwners.length > 0) {
        out.push('', '### Same leaf on other owners (summary only)');
        for (const node of otherOwners) {
          const signatureText = node.signature?.replace(/\s+/g, ' ').trim() || displaySymbol(node);
          out.push(`- \`${signatureText}\` — ${formatDefinitionLocation(node)}`);
        }
      }
      out.push('', `Inspect \`${requestedOwnerText}\` with a filtered owner outline or search one listed qualified candidate explicitly.`);
      return out.join('\n');
    }
    const commonPrefix = (left: string, right: string): number => {
      let i = 0;
      while (i < left.length && i < right.length && left[i] === right[i]) i++;
      return i;
    };
    const pathScores = new Map<string, ReturnType<typeof scorePathSimilarity>>();
    const pathScoreFor = (filePath: string): ReturnType<typeof scorePathSimilarity> => {
      let score = pathScores.get(filePath);
      if (!score) {
        score = scorePathSimilarity(filePath, pathHint ?? '');
        pathScores.set(filePath, score);
      }
      return score;
    };
    candidates = [...candidates].sort((left, right) => {
      const pathOrder = pathHint
        ? comparePathSimilarityScores(pathScoreFor(left.filePath), pathScoreFor(right.filePath))
        : 0;
      if (pathOrder !== 0) return pathOrder;
      const owner = (node: Node) => node.qualifiedName.replace(/\./g, '::').split('::').slice(0, -1).join('::').toLowerCase();
      const score = (node: Node) => {
        const candidateOwner = owner(node);
        const lineScore = lineHint !== undefined && node.startLine <= lineHint && (node.endLine ?? node.startLine) >= lineHint ? 5_000 : 0;
        return lineScore + commonPrefix(requestedOwner, candidateOwner) * 10 - Math.abs(requestedOwner.length - candidateOwner.length);
      };
      return score(right) - score(left) || left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine;
    });

    const assertedPath = pathHint
      ? candidates.filter((node) => pathContainsHint(node.filePath, pathHint))
      : candidates;
    const assertedLine = lineHint !== undefined
      ? assertedPath.filter((node) => node.startLine <= lineHint && (node.endLine ?? node.startLine) >= lineHint)
      : assertedPath;
    let scoped = assertedLine.length > 0 ? assertedLine : assertedPath.length > 0 ? assertedPath : candidates;
    let signatureAssertionMiss = false;
    if (signature) {
      const signatureMatches = this.matchingNodesBySignature(scoped, signature);
      if (signatureMatches.length > 0) scoped = signatureMatches;
      else signatureAssertionMiss = true;
    }
    // relationshipOverloadGroups is intentionally exact but quadratic in the
    // selected set. A wrong owner on `reuse` can yield 1,000+ leaf candidates;
    // grouping all of them is both expensive and unnecessary. Surface ranked
    // structured candidates and ask for one narrowing assertion instead.
    const groupingSkipped = scoped.length > MCP_RELATIONSHIP_MAX_GROUPING_CANDIDATES;
    const legacyFallbackSkipped = !groupingSkipped &&
      this.relationshipFallbackExceedsBudget(scoped.length, candidates.length);
    const groups = groupingSkipped
      ? []
      : this.relationshipOverloadGroups(cg, scoped, candidates);
    const out: string[] = [
      `> Qualified owner mismatch: no exact symbol named \`${query}\`, but the exact leaf \`${leaf}\` has structured candidates. Raw-source fallback was skipped.`,
    ];
    if (pathHint && assertedPath.length === 0) out.push(`> Path hint \`${pathValue}\` matched none of those candidates; all structured candidates remain visible and are ranked by path similarity.`);
    if (lineHint !== undefined && assertedLine.length === 0) out.push(`> Line assertion ${lineHint} matched none of those candidates.`);
    if (signatureAssertionMiss) {
      out.push(`> Signature assertion \`${signature}\` was not used to guess a different overload.`);
    }
    if (groupingSkipped) {
      out.push(
        `> High-frequency leaf guard: ${scoped.length} candidates remain, above the ${MCP_RELATIONSHIP_MAX_GROUPING_CANDIDATES}-candidate overload-grouping cap. ` +
        'Only ranked structured candidates are shown; no repository text scan or all-pairs overload comparison was run.'
      );
    } else if (legacyFallbackSkipped) {
      out.push(
        `> High-frequency leaf guard: ${scoped.length} scoped candidates × ${candidates.length} same-leaf candidates exceeds the ` +
        `${MCP_RELATIONSHIP_MAX_FALLBACK_COMPARISONS}-comparison legacy pairing budget. ` +
        'Direct declaration/definition edges are still expanded; the all-candidates legacy fallback was skipped.'
      );
    }
    if (includeCode && !groupingSkipped && groups.length === 1) {
      const implementation = await this.renderImplementationGroup(cg, groups[0]!, false);
      out.push('', implementation.text);
    } else {
      const shown = this.rankExactSymbolNodes(scoped).slice(0, limit);
      out.push('', this.formatSearchResults(cg, shown.map((node) => ({ node, score: 1.0 }))));
      if (includeCode && (groupingSkipped || groups.length > 1)) {
        const remaining = groupingSkipped ? scoped.length : groups.length;
        out.push('', `> Source was not inlined because ${remaining} logical leaf candidate${remaining === 1 ? '' : 's'} remain. Copy one qualified name/signature or add path/line.`);
      }
    }
    out.push('', `> Correct \`${queryText}\` using one candidate above; do not Grep merely to verify the owner.`);
    return out.join('\n');
  }

  /**
   * Build the "trail" for a symbol: its direct callees (what it calls) and
   * callers (what calls it), each with file:start-end — so codegraph_node doubles as
   * the structural Grep→Read→expand primitive: a spot PLUS where to go next.
   * Capped to stay cheap. Walk the graph by calling codegraph_node on a trail
   * entry; no Read needed for covered hops. Empty edges on a non-leaf often mean
   * dynamic dispatch the static graph couldn't resolve — that absence is itself
   * a signal (read that one hop) rather than a dead end.
   */
  private formatTrail(cg: CodeGraph, node: Node): string {
    const TRAIL_CAP = 12;
    const fmt = (e: { node: Node; edge: Edge }) => {
      const base = `${e.node.name} (${formatDefinitionLocation(e.node)})`;
      const synth = synthEdgeNote(e.edge);
      return synth ? `${base} [${synth.compact}]` : base;
    };
    const collect = (edges: Array<{ node: Node; edge: Edge }>): Array<{ node: Node; edge: Edge }> => {
      const seen = new Set<string>([node.id]);
      const out: Array<{ node: Node; edge: Edge }> = [];
      for (const e of edges) {
        if (seen.has(e.node.id)) continue;
        seen.add(e.node.id);
        out.push(e);
      }
      return out;
    };
    const callees = collect(cg.getCallees(node.id));
    const callers = collect(cg.getCallers(node.id));
    const declDefSection = this.formatDeclDef(cg, node, true);
    if (callees.length === 0 && callers.length === 0) return declDefSection;
    const lines: string[] = ['', '### Trail — codegraph_node any of these to follow it (no Read needed)'];
    if (callees.length > 0) {
      lines.push(`**Calls →** ${callees.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callees.length > TRAIL_CAP ? `, +${callees.length - TRAIL_CAP} more` : ''}`);
    }
    if (callers.length > 0) {
      lines.push(`**Called by ←** ${callers.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callers.length > TRAIL_CAP ? `, +${callers.length - TRAIL_CAP} more` : ''}`);
    }
    return (declDefSection ? declDefSection + '\n' : '') + lines.join('\n');
  }

  /** One-line endpoint reference that preserves declaration-only qualifiers/defaults. */
  private formatCompactEndpointRef(cg: CodeGraph, node: Node): string {
    let label = node.signature?.replace(/\s+/g, ' ').trim() || node.name;
    if (node.isDeclaration === true) {
      const abs = validatePathWithinRoot(cg.getProjectRoot(), node.filePath);
      if (abs) {
        try {
          const lines = readFileSync(abs, 'utf-8').split('\n');
          const source = lines
            .slice(Math.max(0, node.startLine - 1), Math.max(node.startLine, node.endLine ?? node.startLine))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (source && source.length <= 500) label = source;
        } catch { /* retain the indexed signature */ }
      }
    }
    return `\`${label}\` (${formatDefinitionLocation(node)})`;
  }

  /**
   * Format the declaration/definition link for a C++ node. When a method's
   * .h declaration and .cpp definition are paired (cppDeclDefEdges
   * synthesizer), this surfaces the other end as a pointer. On a dead-end
   * declaration node (no callers/callees of its own), it also surfaces the
   * definition's real call trail so the agent isn't misled into thinking
   * the method is unused.
   */
  private formatDeclDef(cg: CodeGraph, node: Node, includeDefinitionTrail: boolean = true): string {
    const CAP = 6;
    const parameters = cppParameterKey(node);
    const sameOverload = (candidateId: string): boolean => {
      if (parameters === null) return true;
      const candidate = cg.getNode(candidateId);
      const candidateParameters = candidate ? cppParameterKey(candidate) : null;
      return Boolean(candidateParameters !== null && cppParameterKeysMatch(parameters, candidateParameters));
    };
    const out = cg.getOutgoingEdges(node.id)
      .filter((e) => e.kind === 'defines' && sameOverload(e.target));
    const inc = cg.getIncomingEdges(node.id)
      .filter((e) => e.kind === 'defines' && sameOverload(e.source));
    const fallbackDefinition = inc.length === 0 && node.isDeclaration
      ? this.indexedDefinitionForDeclaration(cg, node)
      : null;
    if (out.length === 0 && inc.length === 0 && !fallbackDefinition) {
      if (node.isDeclaration && parameters !== null) {
        return [
          '',
          '### Declaration / Definition',
          '**Definition:** No indexed definition found for this exact overload. Treat this as authoritative for the current index; do not use Grep or text search merely to verify absence.',
        ].join('\n');
      }
      return '';
    }

    const ref = (id: string): string => {
      const n = cg.getNode(id);
      return n ? this.formatCompactEndpointRef(cg, n) : id;
    };
    const trailFmt = (e: { node: Node; edge: Edge }): string => {
      const base = `${e.node.name} (${formatDefinitionLocation(e.node)})`;
      const synth = synthEdgeNote(e.edge);
      return synth ? `${base} [${synth.compact}]` : base;
    };

    const lines: string[] = ['', '### Declaration / Definition'];

    // Definition node → outgoing defines point at its declarations.
    if (out.length > 0) {
      const refs = out.slice(0, CAP).map((e) => ref(e.target)).join(', ');
      const more = out.length > CAP ? `, +${out.length - CAP} more` : '';
      const label = out.length === 1 ? '**Declaration:**' : '**Declarations:**';
      lines.push(`${label} ${refs}${more}`);
    }

    // Declaration node → incoming defines come from its definition(s). Surface
    // the first definition's real call trail to fix the dead-end trap.
    const definitionIds = inc.length > 0
      ? inc.map((edge) => edge.source)
      : fallbackDefinition ? [fallbackDefinition.id] : [];
    if (definitionIds.length > 0) {
      const refs = definitionIds.slice(0, CAP).map(ref).join(', ');
      const more = definitionIds.length > CAP ? `, +${definitionIds.length - CAP} more` : '';
      const label = definitionIds.length === 1 ? '**Definition:**' : '**Definitions:**';
      lines.push(`${label} ${refs}${more}`);

      const defId = definitionIds[0];
      if (defId && includeDefinitionTrail) {
        const defCallees = cg.getCallees(defId);
        const defCallers = cg.getCallers(defId);
        if (defCallees.length > 0) {
          const shown = defCallees.slice(0, CAP);
          lines.push(`**Definition calls →** ${shown.map(trailFmt).join(', ')}${defCallees.length > CAP ? `, +${defCallees.length - CAP} more` : ''}`);
        }
        if (defCallers.length > 0) {
          const shown = defCallers.slice(0, CAP);
          lines.push(`**Definition called by ←** ${shown.map(trailFmt).join(', ')}${defCallers.length > CAP ? `, +${defCallers.length - CAP} more` : ''}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Handle codegraph_status
   */
  private async handleStatus(
    args: Record<string, unknown>,
    catchUpAdmission: CatchUpAdmission | null = null,
  ): Promise<ToolResult> {
    let cg = this.getCodeGraph(args.projectPath as string | undefined);
    // Same trick as withStalenessNotice — when an explicit projectPath
    // resolves to the same project as the default session cg, prefer the
    // default so getPendingFiles() (only populated by the default's watcher)
    // is non-empty when there are pending edits.
    if (this.cg && cg !== this.cg) {
      try {
        if (resolvePath(this.cg.getProjectRoot()) === resolvePath(cg.getProjectRoot())) {
          cg = this.cg;
        }
      } catch { /* closed instance — leave as is */ }
    }
    const stats = cg.getStats();

    // Warn when this index actually belongs to a different git working tree
    // (e.g. the server resolved up from a nested worktree to the main checkout).
    // Queries then reflect that tree's branch, not the worktree being edited.
    // status shows the verbose, multi-line form; the read tools get the compact
    // one-liner via withWorktreeNotice. Both share the cached detection.
    const mismatch = this.worktreeMismatchFor(args.projectPath as string | undefined);

    const lines: string[] = [
      '## CodeGraph Status',
      '',
    ];
    if (catchUpAdmission) {
      lines.push(
        `> ${formatCatchUpNotice(catchUpAdmission, true).replace(/\n/g, '\n> ')}`,
        '',
      );
    }
    if (mismatch) {
      lines.push(`> ⚠ ${worktreeMismatchWarning(mismatch).replace(/\n/g, '\n> ')}`, '');
    }
    lines.push(
      `**Files indexed:** ${stats.fileCount}`,
      `**Total nodes:** ${stats.nodeCount}`,
      `**Total edges:** ${stats.edgeCount}`,
      `**Database size:** ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`,
    );

    // Surface the active SQLite backend.
    const backend = cg.getBackend();
    if (backend === 'node-sqlite') {
      lines.push(`**Backend:** node:sqlite (Node built-in) — full WAL + FTS5`);
    } else {
      lines.push(`**Backend:** sql.js (WASM fallback) — FTS5, no WAL — performance may be reduced`);
    }

    // Effective journal mode. 'wal' ⇒ concurrent reads never block on a writer;
    // anything else ⇒ they can ("database is locked"). node:sqlite supports WAL
    // everywhere, so a non-wal mode means the filesystem can't (network/
    // virtualized mounts, WSL2 /mnt). See issue #238.
    const journalMode = cg.getJournalMode();
    if (journalMode === 'wal') {
      lines.push(`**Journal mode:** wal (concurrent reads safe)`);
    } else {
      lines.push(
        `**Journal mode:** ⚠ ${journalMode || 'unknown'} — WAL not active, so reads ` +
        `can block on a concurrent write (WAL appears unsupported on this filesystem)`
      );
    }

    lines.push('', '### Nodes by Kind:');

    for (const [kind, count] of Object.entries(stats.nodesByKind)) {
      if ((count as number) > 0) {
        lines.push(`- ${kind}: ${count}`);
      }
    }

    lines.push('', '### Languages:');
    for (const [lang, count] of Object.entries(stats.filesByLanguage)) {
      if ((count as number) > 0) {
        lines.push(`- ${lang}: ${count}`);
      }
    }

    // Per-file freshness — the inverse of the auto-prepended staleness banner
    // (issue #403). Surfacing it inside `status` gives the agent a single
    // place to ask "is the index caught up?" rather than inferring from
    // banners on other tool calls.
    const pending = cg.getPendingFiles();
    if (pending.length > 0) {
      lines.push('', '### Pending sync:');
      const now = Date.now();
      for (const p of pending) {
        const ageMs = Math.max(0, now - p.lastSeenMs);
        const label = p.indexing ? 'indexing in progress' : 'pending sync';
        lines.push(`- ${p.path} (edited ${ageMs}ms ago, ${label})`);
      }
    }

    return this.textResult(lines.join('\n'));
  }

  /**
   * Handle codegraph_files - get project file structure from the index
   */
  private async handleFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const pathFilter = args.path as string | undefined;
    const pattern = args.pattern as string | undefined;
    const format = (args.format as 'tree' | 'flat' | 'grouped') || 'tree';
    const includeMetadata = args.includeMetadata !== false;
    const maxDepth = args.maxDepth != null ? clamp(args.maxDepth as number, 1, 20) : undefined;

    // Get all files from the index
    const allFiles = cg.getFiles();

    if (allFiles.length === 0) {
      return this.textResult('No files indexed. Run `codegraph index` first.');
    }

    // Filter by path prefix. Stored paths are project-relative POSIX (e.g.
    // "src/foo.ts"), but agents commonly pass project-root variants like "/",
    // ".", "./", "" or Windows-style "src\foo" — and prefixes with leading
    // "/", "./" or "\". Normalize all of those before matching so the agent
    // gets results instead of falling back to Read/Glob (see #426).
    const normalizedFilter = pathFilter
      ? canonicalFilePath(
          cg.getProjectRoot(),
          pathFilter
            .replace(/\\/g, '/')
            .replace(/^(?:\.?\/+)+/, '')
            .replace(/^\.$/, '')
            .replace(/\/+$/, ''),
        )
      : '';
    let files = normalizedFilter
      ? allFiles.filter(f => f.path === normalizedFilter || f.path.startsWith(normalizedFilter + '/'))
      : allFiles;

    // Filter by glob pattern
    if (pattern) {
      const regex = this.globToRegex(pattern);
      files = files.filter(f => regex.test(f.path));
    }

    if (files.length === 0) {
      return this.textResult(`No files found matching the criteria.`);
    }

    // Format output
    let output: string;
    switch (format) {
      case 'flat':
        output = this.formatFilesFlat(files, includeMetadata);
        break;
      case 'grouped':
        output = this.formatFilesGrouped(files, includeMetadata);
        break;
      case 'tree':
      default:
        output = this.formatFilesTree(files, includeMetadata, maxDepth);
        break;
    }

    return this.textResult(this.truncateOutput(output));
  }

  /**
   * Convert glob pattern to regex
   */
  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars except * and ?
      .replace(/\*\*/g, '{{GLOBSTAR}}')       // Temp placeholder for **
      .replace(/\*/g, '[^/]*')                // * matches anything except /
      .replace(/\?/g, '[^/]')                 // ? matches single char except /
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');    // ** matches anything including /
    return new RegExp(escaped);
  }

  /**
   * Format files as a flat list
   */
  private formatFilesFlat(files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
    const lines: string[] = [`## Files (${files.length})`, ''];

    for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
      if (includeMetadata) {
        lines.push(`- ${file.path} (${file.language}, ${file.nodeCount} symbols)`);
      } else {
        lines.push(`- ${file.path}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format files grouped by language
   */
  private formatFilesGrouped(files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
    const byLang = new Map<string, typeof files>();

    for (const file of files) {
      const existing = byLang.get(file.language) || [];
      existing.push(file);
      byLang.set(file.language, existing);
    }

    const lines: string[] = [`## Files by Language (${files.length} total)`, ''];

    // Sort languages by file count (descending)
    const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [lang, langFiles] of sortedLangs) {
      lines.push(`### ${lang} (${langFiles.length})`);
      for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
        if (includeMetadata) {
          lines.push(`- ${file.path} (${file.nodeCount} symbols)`);
        } else {
          lines.push(`- ${file.path}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format files as a tree structure
   */
  private formatFilesTree(
    files: { path: string; language: string; nodeCount: number }[],
    includeMetadata: boolean,
    maxDepth?: number
  ): string {
    // Build tree structure
    interface TreeNode {
      name: string;
      children: Map<string, TreeNode>;
      file?: { language: string; nodeCount: number };
    }

    const root: TreeNode = { name: '', children: new Map() };

    for (const file of files) {
      const parts = file.path.split('/');
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;

        if (!current.children.has(part)) {
          current.children.set(part, { name: part, children: new Map() });
        }
        current = current.children.get(part)!;

        // If this is the last part, it's a file
        if (i === parts.length - 1) {
          current.file = { language: file.language, nodeCount: file.nodeCount };
        }
      }
    }

    // Render tree
    const lines: string[] = [`## Project Structure (${files.length} files)`, ''];

    const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
      if (maxDepth !== undefined && depth > maxDepth) return;

      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      if (node.name) {
        let line = prefix + connector + node.name;
        if (node.file && includeMetadata) {
          line += ` (${node.file.language}, ${node.file.nodeCount} symbols)`;
        }
        lines.push(line);
      }

      const children = [...node.children.values()];
      // Sort: directories first, then files, both alphabetically
      children.sort((a, b) => {
        const aIsDir = a.children.size > 0 && !a.file;
        const bIsDir = b.children.size > 0 && !b.file;
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        const nextPrefix = node.name ? prefix + childPrefix : prefix;
        renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
      }
    };

    renderNode(root, '', true, 0);

    return lines.join('\n');
  }

  // =========================================================================
  // Symbol resolution helpers
  // =========================================================================

  /** Resolve a user-supplied indexed source path without reading arbitrary disk paths. */
  private resolveIndexedFile(
    cg: CodeGraph,
    fileArg: string,
  ): { file: ResolvedIndexedFile } | { result: string } {
    const normalize = (value: string) => value
      .replace(/\\/g, '/')
      .replace(/^(?:\.?\/+)+/, '')
      .replace(/\/+$/, '');
    const wanted = canonicalFilePath(cg.getProjectRoot(), normalize(fileArg)).toLowerCase();
    const files = cg.getFiles();
    if (files.length === 0) return { result: 'no files are indexed; run `codegraph index` first' };

    let resolved = files.find((file) => file.path.toLowerCase() === wanted);
    let candidates: typeof files = [];
    if (!resolved) {
      candidates = files.filter((file) => file.path.toLowerCase().endsWith('/' + wanted));
      if (candidates.length === 1) resolved = candidates[0];
    }
    if (!resolved && candidates.length === 0) {
      candidates = files.filter((file) => file.path.toLowerCase().includes(wanted));
      if (candidates.length === 1) resolved = candidates[0];
    }
    if (!resolved && candidates.length > 1) {
      return {
        result: `matches ${candidates.length} indexed files; pass a longer path (${candidates.slice(0, 8).map((file) => file.path).join(', ')})`,
      };
    }
    if (!resolved) {
      return { result: `no indexed source file matches "${fileArg}"` };
    }
    return { file: { path: resolved.path, language: resolved.language } };
  }

  /** Render merged current-source ranges with no repeated dependency metadata. */
  private renderContextFileRanges(
    cg: CodeGraph,
    file: ResolvedIndexedFile,
    ranges: ContextFileRange[],
  ): string {
    if (CONFIG_LEAF_LANGUAGES.has(file.language)) {
      return `## ${file.path}\n\n> Configuration/data values are withheld for safety.`;
    }
    const abs = validatePathWithinRoot(cg.getProjectRoot(), file.path);
    let content: string | null = null;
    if (abs) {
      try { content = readFileSync(abs, 'utf-8'); } catch { content = null; }
    }
    if (content === null) {
      return `## ${file.path}\n\n> Current source could not be read; the file may have moved since indexing.`;
    }

    const lines = content.split('\n');
    const ordered = ranges
      .filter((range) => range.start <= lines.length && range.end >= 1)
      .map((range) => ({
        start: Math.max(1, range.start),
        end: Math.min(lines.length, range.end),
        labels: [...new Set(range.labels)],
      }))
      .filter((range) => range.end >= range.start)
      .sort((left, right) => left.start - right.start || left.end - right.end);
    const merged: ContextFileRange[] = [];
    for (const range of ordered) {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end + 1) {
        previous.end = Math.max(previous.end, range.end);
        previous.labels = [...new Set([...previous.labels, ...range.labels])];
      } else {
        merged.push({ ...range, labels: [...range.labels] });
      }
    }

    if (merged.length === 0) {
      return `## ${file.path}\n\n> Requested indexed ranges are outside the current file; refresh the index or request a current exact boundary.`;
    }

    const summary = merged.map((range) => `${range.start}-${range.end}`).join(', ');
    const out = [`## ${file.path} — merged current-source ranges ${summary}`];
    for (const range of merged) {
      const labels = range.labels.length > 0 ? ` — ${range.labels.join('; ')}` : '';
      out.push(
        '',
        `### lines ${range.start}-${range.end}${labels}`,
        '',
        numberSourceLines(lines.slice(range.start - 1, range.end).join('\n'), range.start),
      );
    }
    return out.join('\n');
  }

  /**
   * Refuse a likely batch-Read before any source reaches the model context.
   * The compact preflight reports actual rendered-size estimates and exposes
   * exact symbols already indexed inside the requested windows, so the next
   * call can switch to symbol/member focus instead of paging or Read.
   */
  private renderContextPreflight(
    cg: CodeGraph,
    candidates: ContextSectionCandidate[],
    estimatedOutputChars: number,
    broadFileWindowBatch: boolean,
    fileWindowTargetCount: number,
    requestedWindowLines: number,
    corrections: string[],
    misses: string[],
  ): string {
    const out: string[] = [
      '# Context preflight — source not emitted',
      '',
      '> This request was stopped before rendering source, preventing a broad batch-Read or a partial response that omits trailing targets.',
    ];
    if (broadFileWindowBatch) {
      out.push(
        '',
        `- Broad file-window batch: ${fileWindowTargetCount} windows totaling ${requestedWindowLines} requested lines.`,
      );
    }
    if (estimatedOutputChars > MCP_CONTEXT_MAX_OUTPUT_CHARS) {
      out.push(`- Estimated rendered source: about ${estimatedOutputChars} characters, above the ${MCP_CONTEXT_MAX_OUTPUT_CHARS}-character batch budget.`);
    } else {
      out.push(`- Estimated rendered source: about ${estimatedOutputChars} characters.`);
    }

    out.push('', '## Section estimates');
    for (const candidate of candidates) {
      out.push(`- ${candidate.label}: about ${candidate.estimatedChars} characters`);
    }

    const fileCandidates = candidates.filter((candidate) => candidate.file && candidate.ranges?.length);
    if (fileCandidates.length > 0) {
      out.push('', '## Exact symbols inside the requested ranges');
      for (const candidate of fileCandidates) {
        const nodes = cg.getNodesInFile(candidate.file!.path)
          .filter((node) => node.kind !== 'file' && node.kind !== 'import' && node.kind !== 'export')
          .filter((node) => candidate.ranges!.some((range) =>
            node.startLine <= range.end && (node.endLine ?? node.startLine) >= range.start
          ))
          .sort((left, right) => {
            const containerOrder = Number(!CONTAINER_NODE_KINDS.has(left.kind)) - Number(!CONTAINER_NODE_KINDS.has(right.kind));
            if (containerOrder !== 0) return containerOrder;
            const declarationOrder = Number(left.isDeclaration === true) - Number(right.isDeclaration === true);
            if (declarationOrder !== 0) return declarationOrder;
            return left.startLine - right.startLine;
          });
        const seen = new Set<string>();
        const exact = nodes.filter((node) => {
          const key = `${node.qualifiedName}\u0000${node.kind}\u0000${node.startLine}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 12);
        if (exact.length === 0) {
          out.push(`- \`${candidate.file!.path}\`: no indexed symbols in these ranges; use one smaller exact region or a text anchor.`);
          continue;
        }
        out.push(
          `- \`${candidate.file!.path}\`: ` +
          exact.map((node) => `\`${displaySymbol(node)}\` (${node.kind}, :${node.startLine})`).join(', ') +
          (nodes.length > exact.length ? `, +${nodes.length - exact.length} more` : ''),
        );
      }
    }

    if (misses.length > 0) out.push('', '## Unresolved targets', ...misses);
    if (corrections.length > 0) out.push('', `> Automatically corrected before preflight: ${corrections.join('; ')}.`);
    out.push(
      '',
      '## Next call',
      '- Prefer one `codegraph_context` with exact `symbol` targets or `{ symbol: <container>, members: [...] }` selected from the names above.',
      '- For non-symbol boundaries, replace wide windows with `{ file, text, contextLines }` anchors.',
      '- If the raw regions are genuinely required, split them into smaller context batches using the section estimates above. Do not use Read or page through the files.',
    );
    return this.truncateOutput(out.join('\n'));
  }

  /** Return the nearest C++ access label without dumping the intervening class body. */
  private findCppAccessBoundaryLine(
    cg: CodeGraph,
    container: Node,
    memberStartLine: number,
  ): number | undefined {
    if (container.language !== 'cpp' && container.language !== 'c') return undefined;
    const abs = validatePathWithinRoot(cg.getProjectRoot(), container.filePath);
    if (!abs) return undefined;
    let lines: string[];
    try { lines = readFileSync(abs, 'utf-8').split('\n'); } catch { return undefined; }
    const start = Math.max(1, container.startLine);
    const end = Math.min(lines.length, memberStartLine - 1);
    for (let line = end; line >= start; line--) {
      if (/^\s*(?:public|protected|private)\s*:\s*(?:\/\/.*)?$/.test(lines[line - 1] ?? '')) return line;
    }
    return undefined;
  }

  /**
   * Find a symbol by name, handling disambiguation when multiple matches exist.
   * Returns the best match and a note about alternatives if any.
   */
  /**
   * Find ALL definitions matching a name, ranked, so codegraph_node can return
   * every overload instead of guessing one (the wrong guess → a Read). Keepers
   * rank before generated stubs (.pb.go etc.); stable within a group preserves
   * FTS order. Returns [] when nothing matches; a qualified lookup that finds no
   * exact match returns [] rather than a misleading fuzzy file hit (#173); a
   * bare name with no exact match falls back to the single top fuzzy result.
   */
  private findSymbolMatches(cg: CodeGraph, symbol: string): Node[] {
    const isQualified = /[.\/]|::/.test(symbol);

    // For a bare name, enumerate EVERY exact-name definition via the direct index
    // (not FTS, which caps + ranks): tokio's `poll` has 50+ defs and the one the
    // caller wants (`Harness::poll` at harness.rs:153) ranks below any search cut,
    // so it could be neither rendered nor pinned by the file/line disambiguator —
    // and the agent Read it. With the full set, the multi-overload render + the
    // file/line filter can both reach it.
    if (!isQualified) {
      const exact = cg.getNodesBySymbolExact(symbol);
      if (exact.length > 0) {
        return this.rankExactSymbolNodes(exact);
      }
      const corrected = this.findCaseInsensitiveSymbolMatches(cg, symbol);
      if (corrected.length > 0) return corrected;
      // No exact match — use the single top fuzzy result (e.g. a file basename).
      const fuzzy = cg.searchNodes(symbol, { limit: 10 });
      return fuzzy[0] ? [fuzzy[0].node] : [];
    }

    const exact = this.rankExactSymbolNodes(cg.getNodesBySymbolExact(symbol));
    return exact.length > 0 ? exact : this.findCaseInsensitiveSymbolMatches(cg, symbol);
  }

  /**
   * Correct capitalization mistakes without turning a symbol lookup into a
   * broad scan. The FTS candidate set is bounded, then filtered back to an
   * exact case-insensitive leaf or qualified name.
   */
  private findCaseInsensitiveSymbolMatches(cg: CodeGraph, symbol: string): Node[] {
    const normalizeQualified = (value: string) => value.replace(/[.]/g, '::').toLowerCase();
    const wantedQualified = normalizeQualified(symbol);
    const parts = symbol.replace(/[.]/g, '::').split('::').filter(Boolean);
    const wantedLeaf = (parts.at(-1) ?? symbol).toLowerCase();
    const qualified = /[.\/]|::/.test(symbol);
    const candidates = cg.searchNodes(parts.at(-1) ?? symbol, { limit: 100 });
    const seen = new Set<string>();
    const matches: Node[] = [];
    for (const { node } of candidates) {
      const exact = qualified
        ? normalizeQualified(node.qualifiedName) === wantedQualified
        : node.name.toLowerCase() === wantedLeaf;
      if (!exact || seen.has(node.id)) continue;
      seen.add(node.id);
      matches.push(node);
    }
    return this.rankExactSymbolNodes(matches);
  }

  /**
   * A C++ class and its constructors share the same bare node name. For an
   * unpinned type lookup, return the container instead of presenting the class
   * and constructors as overload candidates. Explicit line/signature hints
   * retain the full set so callers can still request a constructor precisely.
   */
  private preferContainerMatches(
    matches: Node[],
    lineHint?: number,
    signatureHint?: string,
  ): Node[] {
    if (lineHint !== undefined || signatureHint) return matches;
    const containers = matches.filter((node) => CONTAINER_NODE_KINDS.has(node.kind));
    if (containers.length === 0) return matches;
    const normalizedQn = (value: string): string[] =>
      value.replace(/\./g, '::').split('::').filter(Boolean).map((part) => part.toLowerCase());
    const isConstructorOfContainer = (node: Node): boolean => {
      if (node.language !== 'cpp' || node.kind !== 'method') return false;
      const methodParts = normalizedQn(node.qualifiedName);
      if (methodParts.length < 2 || methodParts.at(-1) !== node.name.toLowerCase()) return false;
      const owner = methodParts.slice(0, -1);
      return containers.some((container) => {
        if (container.language !== 'cpp' || container.name !== node.name) return false;
        const containerParts = normalizedQn(container.qualifiedName);
        const shorter = owner.length <= containerParts.length ? owner : containerParts;
        const longer = owner.length <= containerParts.length ? containerParts : owner;
        return shorter.length > 0 && longer
          .slice(longer.length - shorter.length)
          .every((part, index) => part === shorter[index]);
      });
    };
    const withoutConstructors = matches.filter((node) => !isConstructorOfContainer(node));
    return withoutConstructors.length > 0 ? withoutConstructors : matches;
  }

  /**
   * Resolve one relationship-tool target without ever merging distinct
   * overloads or same-named symbols. A matching declaration and definition
   * are kept together because graph edges may attach to either endpoint.
   */
  private async resolveRelationshipTarget(
    cg: CodeGraph,
    args: Record<string, unknown>,
    tool: 'callers' | 'callees' | 'impact',
  ): Promise<RelationshipTargetResolution> {
    const symbolValue = this.validateString(args.symbol, 'symbol', 512);
    if (typeof symbolValue !== 'string') return { result: symbolValue };
    const symbolText = symbolValue.trim();
    if (!symbolText) return { result: this.errorResult('symbol must not be blank') };

    const parsedSymbol = parseCallableLookup(symbolText);
    const implicitSignature = parsedSymbol.signature;
    const symbol = parsedSymbol.symbol;
    const fileValue = this.validateOptionalPath(args.file, 'file');
    if (fileValue !== undefined && typeof fileValue !== 'string') return { result: fileValue };
    const file = fileValue?.trim() || undefined;
    if (args.file !== undefined && !file) {
      return { result: this.errorResult('file must not be blank') };
    }
    if (args.line !== undefined &&
        (typeof args.line !== 'number' || !Number.isInteger(args.line) || args.line < 1)) {
      return { result: this.errorResult('line must be a positive integer') };
    }
    const line = args.line as number | undefined;
    const signatureValue = args.signature === undefined
      ? implicitSignature
      : this.validateString(args.signature, 'signature', 1024);
    if (signatureValue !== undefined && typeof signatureValue !== 'string') {
      return { result: signatureValue };
    }
    const signature = signatureValue?.trim() || undefined;
    if (args.signature !== undefined && !signature) {
      return { result: this.errorResult('signature must not be blank') };
    }

    const lookup = this.findAllSymbols(cg, symbol);
    if (lookup.nodes.length === 0) {
      const needle = this.rawEvidenceNeedle(symbol);
      const evidence = needle
        ? await this.renderRawEvidence(cg, [{ label: symbolText, needle, path: file }])
        : '';
      return {
        result: this.textResult([`Symbol "${symbol}" not found in the codebase`, evidence].filter(Boolean).join('\n\n')),
      };
    }
    const allCandidates = lookup.nodes;
    const narrowed = this.narrowSymbolMatches(allCandidates, file, line);
    if (!narrowed.fileMatched || !narrowed.lineMatched) {
      const needle = this.rawEvidenceNeedle(symbol);
      const evidence = needle && file
        ? await this.renderRawEvidence(cg, [{ label: symbolText, needle, path: file }])
        : '';
      return {
        result: this.textResult([
          this.formatSymbolHintWarning(symbol, narrowed),
          '',
          `> No ${tool} traversal was run. Correct the file/line assertion; do not infer one overload's relationships from these candidates.`,
          evidence ? `\n${evidence}` : '',
        ].join('\n')),
      };
    }

    let selected = this.preferContainerMatches(narrowed.matches, line, signature);
    if (signature) {
      const signatureMatches = this.matchingNodesBySignature(selected, signature);
      if (signatureMatches.length === 0) {
        return {
          result: this.textResult([
            this.formatRelationshipSignatureMiss(tool, symbol, signature, selected),
            '> Raw-source fallback was skipped: exact structured symbol candidates already exist, so this is a signature assertion mismatch rather than a graph miss.',
          ].filter(Boolean).join('\n\n')),
        };
      }
      selected = signatureMatches;
    }

    const groups = this.relationshipOverloadGroups(cg, selected, allCandidates);
    if (groups.length !== 1) {
      return {
        result: this.textResult(this.formatRelationshipAmbiguity(tool, symbol, groups)),
      };
    }

    const nodes = groups[0]!;
    const primary = this.rankExactSymbolNodes(nodes)[0]!;
    const lookupNote = lookup.note.includes('No exact match') || lookup.note.includes('Case-insensitive')
      ? lookup.note.split('\n\n> **Note:** Found')[0]!
      : '';
    return {
      target: {
        symbol,
        signature: primary.signature?.replace(/\s+/g, ' ').trim() || signature,
        nodes,
        primary,
        lookupNote,
      },
    };
  }

  /** Group selected nodes by logical overload and include their paired endpoint. */
  private relationshipOverloadGroups(
    cg: CodeGraph,
    selected: Node[],
    allCandidates: Node[],
  ): Node[][] {
    const uniqueSelected = [...new Map(selected.map((node) => [node.id, node])).values()];
    if (uniqueSelected.length > MCP_RELATIONSHIP_MAX_GROUPING_CANDIDATES) {
      // A high-frequency bare symbol is already ambiguous. Returning stable
      // singleton groups preserves that fact without running synchronous
      // all-pairs work or declaration fallback lookups on the MCP event loop.
      return this.rankExactSymbolNodes(uniqueSelected).map((node) => [node]);
    }

    const legacyFallbackSkipped = this.relationshipFallbackExceedsBudget(
      uniqueSelected.length,
      allCandidates.length,
    );
    // When the legacy all-candidate pass is too broad, keep the cache scoped to
    // the selected nodes. Modern indexes still expand authoritative `defines`
    // edges below; an old edge-less index may omit a compact partner pointer,
    // but it cannot wedge the daemon.
    const cache = this.createRelationshipOverloadCache(
      legacyFallbackSkipped ? uniqueSelected : allCandidates,
    );
    const groups: Node[][] = [];
    for (const node of uniqueSelected) {
      const existing = groups.find((group) =>
        group.some((member) => this.sameRelationshipOverload(cg, member, node, cache))
      );
      if (existing) existing.push(node);
      else groups.push([node]);
    }

    if (!legacyFallbackSkipped) {
      // Compare candidates only with the selected anchors, not with endpoints
      // appended during this pass. This makes the comparison count exactly
      // bounded by selected.length × allCandidates.length.
      const anchors = groups.map((group) => [...group]);
      for (let index = 0; index < groups.length; index++) {
        const group = groups[index]!;
        const groupAnchors = anchors[index]!;
        const memberIds = new Set(group.map((member) => member.id));
        for (const candidate of allCandidates) {
          if (
            !memberIds.has(candidate.id) &&
            groupAnchors.some((member) => this.sameRelationshipOverload(cg, member, candidate, cache))
          ) {
            group.push(candidate);
            memberIds.add(candidate.id);
          }
        }
      }
    }
    return groups.map((group) => this.expandDeclarationDefinitionEndpoints(cg, group, cache));
  }

  private relationshipFallbackExceedsBudget(selectedCount: number, candidateCount: number): boolean {
    return selectedCount > 0 &&
      candidateCount > Math.floor(MCP_RELATIONSHIP_MAX_FALLBACK_COMPARISONS / selectedCount);
  }

  private createRelationshipOverloadCache(candidates: Node[]): RelationshipOverloadCache {
    const candidatesByName = new Map<string, Node[]>();
    for (const candidate of candidates) {
      const bucket = candidatesByName.get(candidate.name);
      if (bucket) bucket.push(candidate);
      else candidatesByName.set(candidate.name, [candidate]);
    }
    for (const [name, bucket] of candidatesByName) {
      const unique = [...new Map(bucket.map((node) => [node.id, node])).values()];
      candidatesByName.set(name, unique);
    }
    return {
      parameterKeys: new Map(),
      definitionsByDeclaration: new Map(),
      candidatesByName,
      definitionEdgeSources: new Map(),
    };
  }

  /** Expand a selected overload through authoritative or canonical decl/def pairing. */
  private expandDeclarationDefinitionEndpoints(
    cg: CodeGraph,
    selected: Node[],
    cache?: RelationshipOverloadCache,
  ): Node[] {
    const endpoints = new Map(selected.map((node) => [node.id, node]));
    const queue = [...selected];
    const add = (candidate: Node | null | undefined, source: Node): void => {
      if (!candidate || endpoints.has(candidate.id)) return;
      if (!this.sameRelationshipOverload(cg, source, candidate, cache)) return;
      endpoints.set(candidate.id, candidate);
      queue.push(candidate);
    };

    for (let index = 0; index < queue.length; index++) {
      const node = queue[index]!;
      if (node.isDeclaration === true) {
        add(this.indexedDefinitionForDeclaration(cg, node, cache), node);
      }
      for (const edge of [...cg.getIncomingEdges(node.id), ...cg.getOutgoingEdges(node.id)]) {
        if (edge.kind !== 'defines') continue;
        const otherId = edge.source === node.id ? edge.target : edge.source;
        add(cg.getNode(otherId), node);
      }
    }
    return this.rankExactSymbolNodes([...endpoints.values()]);
  }

  /**
   * Expand one precise callable through authoritative virtual-dispatch links.
   * C++ and nominal interface synthesis store these as heuristic `calls`
   * edges; native `overrides` edges are also accepted. Same-name + compatible
   * parameter checks keep overloaded methods out of the family.
   */
  private relationshipDispatchFamily(cg: CodeGraph, selected: Node[]): Node[] {
    const family = new Map(selected.map((node) => [node.id, node]));
    const queue = [...selected];
    const isDispatchEdge = (edge: Edge): boolean => edge.kind === 'overrides' || (
      edge.kind === 'calls' && edge.provenance === 'heuristic' &&
      (edge.metadata?.synthesizedBy === 'cpp-override' || edge.metadata?.synthesizedBy === 'interface-impl')
    );
    const compatible = (left: Node, right: Node): boolean => {
      if (left.name !== right.name) return false;
      const leftKey = cppParameterKey(left);
      const rightKey = cppParameterKey(right);
      if (leftKey !== null && rightKey !== null) return cppParameterKeysMatch(leftKey, rightKey);
      const normalize = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const leftSignature = normalize(left.signature);
      const rightSignature = normalize(right.signature);
      return !leftSignature || !rightSignature || leftSignature === rightSignature;
    };

    for (let index = 0; index < queue.length && family.size < 64; index++) {
      const node = queue[index]!;
      const edges = [...cg.getIncomingEdges(node.id), ...cg.getOutgoingEdges(node.id)];
      for (const edge of edges) {
        if (!isDispatchEdge(edge)) continue;
        const otherId = edge.source === node.id ? edge.target : edge.source;
        const other = cg.getNode(otherId);
        if (!other || family.has(other.id) || !compatible(node, other)) continue;
        family.set(other.id, other);
        queue.push(other);
        // A dispatch endpoint may itself be a C++ declaration. Pull its exact
        // definition/declaration partner into the same family before traversal.
        const allSameName = this.findSymbolMatches(cg, other.name);
        const group = this.relationshipOverloadGroups(cg, [other], allSameName)[0] ?? [other];
        for (const partner of group) {
          if (family.has(partner.id)) continue;
          family.set(partner.id, partner);
          queue.push(partner);
        }
      }
    }
    return this.rankExactSymbolNodes([...family.values()]);
  }

  /** True only for two indexed endpoints representing the same callable overload. */
  private sameRelationshipOverload(
    cg: CodeGraph,
    left: Node,
    right: Node,
    cache?: RelationshipOverloadCache,
  ): boolean {
    if (left.id === right.id) return true;
    if (left.name !== right.name) return false;
    // Two concrete definitions are distinct graph roots even when their text
    // signature is identical (same-named methods can live on different types,
    // and duplicate definitions should never be silently merged).
    if (left.isDeclaration !== true && right.isDeclaration !== true) return false;

    const leftParameters = this.relationshipParameterKey(left, cache);
    const rightParameters = this.relationshipParameterKey(right, cache);
    const bothCFamily = (left.language === 'c' || left.language === 'cpp') &&
      (right.language === 'c' || right.language === 'cpp');
    if (
      bothCFamily &&
      leftParameters !== null &&
      rightParameters !== null &&
      cppParameterKeysMatch(leftParameters, rightParameters)
    ) {
      if (
        left.qualifiedName === right.qualifiedName ||
        cppCallableOwnersMatch(left, right)
      ) return true;
    }

    // A valid synthesized declaration/definition edge is definitive. Check the
    // requested pair directly instead of resolving the declaration through a
    // fresh same-name query and sort for every comparison.
    const linkedDefinition = (declaration: Node, definition: Node): boolean => {
      if (definition.isDeclaration === true || leftParameters === null || rightParameters === null) return false;
      if (!cppParameterKeysMatch(leftParameters, rightParameters)) return false;
      let sources = cache?.definitionEdgeSources.get(declaration.id);
      if (!sources) {
        sources = new Set(
          cg.getIncomingEdges(declaration.id)
            .filter((edge) => edge.kind === 'defines')
            .map((edge) => edge.source),
        );
        cache?.definitionEdgeSources.set(declaration.id, sources);
      }
      return sources.has(definition.id);
    };
    if (left.isDeclaration && linkedDefinition(left, right)) return true;
    if (right.isDeclaration && linkedDefinition(right, left)) return true;
    return false;
  }

  private relationshipParameterKey(node: Node, cache?: RelationshipOverloadCache): string | null {
    if (!cache) return cppParameterKey(node);
    if (!cache.parameterKeys.has(node.id)) {
      cache.parameterKeys.set(node.id, cppParameterKey(node));
    }
    return cache.parameterKeys.get(node.id) ?? null;
  }

  private formatRelationshipTarget(target: ResolvedRelationshipTarget): string {
    const signature = target.signature || target.symbol;
    return `${signature} [${target.primary.filePath}:${target.primary.startLine}]`;
  }

  private formatRelationshipAmbiguity(
    tool: 'callers' | 'callees' | 'impact',
    symbol: string,
    groups: Node[][],
  ): string {
    const lines = [
      `## Ambiguous relationship target: ${symbol}`,
      '',
      `Found ${groups.length} distinct overload/symbol candidates. No ${tool} traversal was run; results were not aggregated.`,
      '',
      '### Exact candidates',
    ];
    for (const group of groups.slice(0, 12)) {
      const node = this.rankExactSymbolNodes(group)[0]!;
      const signature = node.signature?.replace(/\s+/g, ' ').trim() || displaySymbol(node);
      lines.push(`- \`${signature}\` — ${node.kind}, ${node.filePath}:${node.startLine}`);
    }
    if (groups.length > 12) lines.push(`- … +${groups.length - 12} more candidates`);
    lines.push(
      '',
      `Retry \`codegraph_${tool}\` with one candidate's \`file\` plus \`line\`, or copy its \`signature\`.`,
      `Example: { symbol: ${JSON.stringify(symbol)}, file: ${JSON.stringify(groups[0]![0]!.filePath)}, line: ${groups[0]![0]!.startLine} }`,
      'Do not infer any individual overload\'s relationships from an aggregate of these candidates.',
    );
    return lines.join('\n');
  }

  private formatRelationshipSignatureMiss(
    tool: 'callers' | 'callees' | 'impact',
    symbol: string,
    signature: string,
    candidates: Node[],
  ): string {
    const lines = [
      `## Signature hint did not match: ${signature}`,
      '',
      `No ${tool} traversal was run for \`${symbol}\`. Exact candidates in the selected file/line scope:`,
    ];
    for (const node of candidates.slice(0, 12)) {
      const candidateSignature = node.signature?.replace(/\s+/g, ' ').trim() || displaySymbol(node);
      lines.push(`- \`${candidateSignature}\` — ${node.filePath}:${node.startLine}`);
    }
    if (candidates.length > 12) lines.push(`- … +${candidates.length - 12} more candidates`);
    lines.push('', 'Copy one candidate signature exactly or use its file and definition line.');
    return lines.join('\n');
  }

  /** Result of applying optional file/line assertions to same-name symbols. */
  private narrowSymbolMatches(
    matches: Node[],
    fileHint?: string,
    lineHint?: number,
  ): { matches: Node[]; fileMatched: boolean; lineMatched: boolean; hintedCandidates: Node[] } {
    if (!fileHint && lineHint === undefined) {
      return { matches, fileMatched: true, lineMatched: true, hintedCandidates: matches };
    }
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    let narrowed = matches;
    let fileMatched = !fileHint;
    if (fileHint) {
      const fh = norm(fileHint);
      const byFile = narrowed.filter((n) => norm(n.filePath).endsWith(fh) || norm(n.filePath).includes(fh));
      fileMatched = byFile.length > 0;
      if (fileMatched) narrowed = byFile;
    }
    const hintedCandidates = narrowed;
    // A line number is meaningful only after an optional file assertion has
    // succeeded. Applying it across every file after a bad file hint could
    // accidentally collapse to an unrelated same-named function whose range
    // happens to contain that number.
    let lineMatched = lineHint === undefined || !fileMatched;
    if (lineHint !== undefined && fileMatched) {
      const containing = narrowed.filter((n) =>
        n.startLine <= lineHint && (n.endLine ?? n.startLine) >= lineHint
      );
      lineMatched = containing.length > 0;
      if (lineMatched) narrowed = containing;
    }
    return {
      matches: narrowed.length > 0 ? narrowed : matches,
      fileMatched,
      lineMatched,
      hintedCandidates,
    };
  }

  /** Make an invalid file/line assertion visible instead of silently guessing. */
  private formatSymbolHintWarning(
    symbol: string,
    result: { fileMatched: boolean; lineMatched: boolean; hintedCandidates: Node[] },
  ): string {
    if (result.fileMatched && result.lineMatched) return '';
    const reason = !result.fileMatched
      ? 'the file hint matched no exact symbol candidate'
      : 'the line hint is outside every matching symbol body';
    const candidates = result.hintedCandidates.slice(0, 8).map((node) => {
      const signature = node.signature?.replace(/\s+/g, ' ').trim() || displaySymbol(node);
      return `- \`${signature}\` — ${formatDefinitionLocation(node)}`;
    });
    const more = result.hintedCandidates.length > 8
      ? [`- … +${result.hintedCandidates.length - 8} more candidates`]
      : [];
    return [
      `> ⚠️ The file/line hint for \`${symbol}\` was not applied: ${reason}. No nearest overload was selected.`,
      '> Exact candidates:',
      ...candidates,
      ...more,
      '> Copy the intended candidate signature into `signature` (batch context) or use its exact file/definition line.',
    ].join('\n');
  }

  /**
   * A precise node result still names sibling overloads compactly. This lets a
   * caller notice a declaration-only or differently-typed overload without a
   * second codegraph_search call, while keeping their bodies out of the answer.
   */
  private formatOtherOverloadSummary(cg: CodeGraph, symbol: string, selected: Node): string {
    if (!selected.signature || !selected.signature.includes('(')) return '';
    const sameCallableFamily = (node: Node): boolean => {
      if (node.id === selected.id || node.name !== selected.name) return false;
      if (node.language === 'cpp' && selected.language === 'cpp') {
        return cppCallableOwnersMatch(node, selected);
      }
      // Do not describe same-named functions in unrelated modules/classes as
      // "overloads" (for example stage_detect::run vs stage_apply::run).
      return node.filePath === selected.filePath &&
        node.qualifiedName === selected.qualifiedName;
    };
    const others = this.findSymbolMatches(cg, symbol).filter(sameCallableFamily);
    if (others.length === 0) return '';
    const selectedKey = cppParameterKey(selected);
    const relevant = others.filter((node) => {
      const key = cppParameterKey(node);
      return key === null || selectedKey === null || !cppParameterKeysMatch(key, selectedKey);
    });
    if (relevant.length === 0) return '';
    const shown = relevant.slice(0, 6).map((node) => {
      const signature = node.signature?.replace(/\s+/g, ' ').trim() || displaySymbol(node);
      const role = this.indexedDefinitionRole(cg, node);
      return `- \`${signature}\` — ${role}, ${formatDefinitionLocation(node)}`;
    });
    if (relevant.length > 6) shown.push(`- … +${relevant.length - 6} more overloads`);
    return ['### Other overloads (summary only)', ...shown].join('\n');
  }

  /** Narrow same-name overloads by indexed signature while keeping a bad hint non-destructive. */
  private narrowMatchesBySignature(matches: Node[], signatureHint?: string): Node[] {
    if (matches.length <= 1 || !signatureHint) return matches;
    const narrowed = this.matchingNodesBySignature(matches, signatureHint);
    return narrowed.length > 0 ? narrowed : matches;
  }

  /** Strict signature matcher used when a relationship target must not guess. */
  private matchingNodesBySignature(matches: Node[], signatureHint: string): Node[] {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const stripReturnType = (value: string) => {
      const paren = value.indexOf('(');
      if (paren < 0) return value;
      const prefix = value.slice(0, paren).trim();
      const callable = prefix.split(/\s+/).at(-1) ?? prefix;
      return callable + value.slice(paren);
    };
    const wanted = stripReturnType(normalize(signatureHint));
    const exact = matches.filter((node) => normalize(node.signature ?? '') === wanted);
    if (exact.length > 0) return exact;
    const callableExact = matches.filter((node) => stripReturnType(normalize(node.signature ?? '')) === wanted);
    if (callableExact.length > 0) return callableExact;
    const canonicalCpp = matches.filter((node) => {
      if (node.language !== 'cpp') return false;
      const wantedKey = cppParameterKey({ name: node.name, signature: signatureHint });
      const nodeKey = cppParameterKey(node);
      return wantedKey !== null && nodeKey !== null && cppParameterKeysMatch(wantedKey, nodeKey);
    });
    if (canonicalCpp.length > 0) return canonicalCpp;
    const containing = matches.filter((node) => stripReturnType(normalize(node.signature ?? '')).includes(wanted));
    return containing;
  }

  /**
   * Resolve whether a callable declaration has an indexed definition for the
   * same overload. Parameter keys prevent a stale cross-overload `defines`
   * edge from making a declaration-only overload look implemented.
   */
  private indexedDefinitionForDeclaration(
    cg: CodeGraph,
    declaration: Node,
    cache?: RelationshipOverloadCache,
  ): Node | null {
    if (!declaration.isDeclaration) return null;
    if (cache?.definitionsByDeclaration.has(declaration.id)) {
      return cache.definitionsByDeclaration.get(declaration.id) ?? null;
    }
    const declarationParameters = this.relationshipParameterKey(declaration, cache);
    if (declarationParameters === null) {
      cache?.definitionsByDeclaration.set(declaration.id, null);
      return null;
    }

    const sameOverload = (candidate: Node): boolean => {
      if (candidate.isDeclaration === true) return false;
      const candidateParameters = this.relationshipParameterKey(candidate, cache);
      return candidateParameters !== null &&
        cppParameterKeysMatch(candidateParameters, declarationParameters);
    };

    for (const edge of cg.getIncomingEdges(declaration.id)) {
      if (edge.kind !== 'defines') continue;
      const candidate = cg.getNode(edge.source);
      if (candidate && sameOverload(candidate)) {
        cache?.definitionsByDeclaration.set(declaration.id, candidate);
        return candidate;
      }
    }

    // Be robust to an older index that contains both nodes but is missing the
    // synthesized edge. Compare the immediate callable owner so same-signature
    // methods on unrelated classes do not get paired.
    const candidates = cache?.candidatesByName.get(declaration.name) ??
      cg.getNodesByName(declaration.name);
    const matchingDefinitions = candidates.filter((candidate) =>
      sameOverload(candidate) &&
      cppCallableOwnersMatch(candidate, declaration)
    );
    const definition = matchingDefinitions.length > 0
      ? this.rankExactSymbolNodes(matchingDefinitions)[0] ?? null
      : null;
    cache?.definitionsByDeclaration.set(declaration.id, definition);
    return definition;
  }

  /** Compact role text shared by node/context overload summaries. */
  private indexedDefinitionRole(cg: CodeGraph, node: Node): string {
    if (!node.isDeclaration) return 'definition';
    return this.indexedDefinitionForDeclaration(cg, node)
      ? 'declaration'
      : 'declaration — no indexed definition found for this exact overload';
  }

  /**
   * Render every distinct overload for one context target. A definition's
   * linked C/C++ declaration is collapsed because the definition section
   * already points at it; unpaired declarations remain visible (they may be a
   * genuinely declaration-only overload, as in the OceanBase regression).
   */
  private async renderContextOverloads(
    cg: CodeGraph,
    symbol: string,
    matches: Node[],
    includeRelations: boolean,
  ): Promise<string> {
    const linkedDeclarations = new Set<string>();
    const matchesById = new Map(matches.map((node) => [node.id, node]));
    for (const node of matches) {
      if (node.isDeclaration) continue;
      const definitionParameters = cppParameterKey(node);
      for (const edge of cg.getOutgoingEdges(node.id)) {
        if (edge.kind !== 'defines' || definitionParameters === null) continue;
        const declaration = matchesById.get(edge.target);
        const declarationParameters = declaration ? cppParameterKey(declaration) : null;
        if (
          declaration?.isDeclaration &&
          declarationParameters !== null &&
          cppParameterKeysMatch(declarationParameters, definitionParameters)
        ) {
          linkedDeclarations.add(edge.target);
        }
      }
    }
    // Older indexes may have both endpoints but lack the synthesized edge.
    // Apply the same owner + canonical-parameter fallback used by node/search
    // so batch context does not render one overload twice.
    for (const declaration of matches) {
      if (!declaration.isDeclaration || linkedDeclarations.has(declaration.id)) continue;
      const definition = this.indexedDefinitionForDeclaration(cg, declaration);
      if (definition && matchesById.has(definition.id)) {
        linkedDeclarations.add(declaration.id);
      }
    }
    const distinct = matches.filter((node) => !linkedDeclarations.has(node.id));
    const candidates = distinct.length > 0 ? distinct : matches;
    const out: string[] = [
      `## ${symbol} — ${candidates.length} distinct overload candidate${candidates.length === 1 ? '' : 's'}`,
    ];
    if (linkedDeclarations.size > 0) {
      out.push(`_${linkedDeclarations.size} paired declaration${linkedDeclarations.size === 1 ? '' : 's'} collapsed into the definition pointer._`);
    }
    out.push('', '### Candidates');
    for (const node of candidates) {
      const signature = node.signature?.replace(/\s+/g, ' ').trim() || displaySymbol(node);
      const role = this.indexedDefinitionRole(cg, node);
      out.push(`- \`${signature}\` — ${role}, ${formatDefinitionLocation(node)}`);
    }
    out.push('', '### Source');

    const rendered: string[] = [];
    let used = out.join('\n').length;
    const bodyBudget = MCP_CONTEXT_MAX_CHARS_PER_TARGET - 600;
    const omitted: Node[] = [];
    for (const node of candidates) {
      const section = await this.renderNodeSection(cg, node, true, includeRelations);
      if (rendered.length === 0 || used + section.text.length <= bodyBudget) {
        rendered.push(section.text);
        used += section.text.length;
      } else {
        omitted.push(node);
      }
    }
    out.push(rendered.join('\n\n---\n\n'));
    if (omitted.length > 0) {
      out.push('', '### Bodies omitted by the per-target budget');
      for (const node of omitted) {
        out.push(`- \`${node.signature ?? displaySymbol(node)}\` — ${formatDefinitionLocation(node)}`);
      }
      out.push('Use the listed signature as the target `signature` hint only if that body is required.');
    }
    return out.join('\n');
  }

  /**
   * Find ALL symbols matching a name. Relationship tools use this candidate set
   * for exact overload disambiguation; they never aggregate distinct groups.
   *
   * Bare names go through the direct exact-name index (`getNodesByName`) — not FTS,
   * which caps + ranks — so a heavily-overloaded name or a name that is a prefix of
   * another symbol's name resolves correctly. When no exact match exists, the single
   * top fuzzy result is returned with a `⚠️ No exact match` warning note so the caller
   * knows the returned neighborhood belongs to a closest match, not the queried name.
   * Qualified names use the uncapped exact-symbol path; a qualified lookup
   * with no exact match returns empty (no silent fuzzy fallback, per #173).
   */
  private findAllSymbols(cg: CodeGraph, symbol: string): { nodes: Node[]; note: string } {
    const isQualified = /[.\/]|::/.test(symbol);

    // Bare name: enumerate EVERY exact-name definition via the direct index
    // (not FTS, which caps + ranks). Mirrors `findSymbolMatches` — a heavily
    // overloaded name (>50 FTS hits) or a name that is a prefix of another
    // symbol's name must not silently fall back to the first FTS prefix hit.
    if (!isQualified) {
      let exact = cg.getNodesBySymbolExact(symbol);
      let correctionNote = '';
      if (exact.length === 0) {
        exact = this.findCaseInsensitiveSymbolMatches(cg, symbol);
        if (exact.length > 0) correctionNote = `\n\n> Case-insensitive exact-name correction applied for "${symbol}".`;
      }
      if (exact.length > 0) {
        const ranked = this.rankExactSymbolNodes(exact);
        if (ranked.length === 1) {
          return { nodes: [ranked[0]!], note: correctionNote };
        }
        const locations = ranked.map(r =>
          `${r.kind} at ${r.filePath}:${r.startLine}`
        );
        const note = `${correctionNote}\n\n> **Note:** Found ${ranked.length} exact symbols named "${symbol}": ${locations.join(', ')}`;
        return { nodes: ranked, note };
      }
      // No exact match — fall back to the single top fuzzy result, with a
      // warning so callers/callees/impact do not silently return the wrong
      // symbol's neighborhood when the queried name is a prefix of a real one.
      const fuzzy = cg.searchNodes(symbol, { limit: 10 });
      if (fuzzy.length === 0) return { nodes: [], note: '' };
      const node = fuzzy[0]!.node;
      const note = `\n\n> ⚠️ No exact match for "${symbol}". Showing closest match: ${node.name}`;
      return { nodes: [node], note };
    }

    let exactMatches = this.rankExactSymbolNodes(cg.getNodesBySymbolExact(symbol));
    let correctionNote = '';
    if (exactMatches.length === 0) {
      exactMatches = this.findCaseInsensitiveSymbolMatches(cg, symbol);
      if (exactMatches.length > 0) correctionNote = `\n\n> Case-insensitive exact-name correction applied for "${symbol}".`;
    }
    if (exactMatches.length === 0) return { nodes: [], note: '' };

    if (exactMatches.length === 1) {
      return { nodes: [exactMatches[0]!], note: correctionNote };
    }

    // Same generated-file down-rank as findSymbol — keeps callers/callees
    // /impact aggregation aligned (a query against "Send" returns the
    // hand-written implementations before the protobuf scaffold).
    const ranked = exactMatches;

    const locations = ranked.map(r =>
      `${r.kind} at ${r.filePath}:${r.startLine}`
    );
    const note = `${correctionNote}\n\n> **Note:** Found ${ranked.length} exact symbols named "${symbol}": ${locations.join(', ')}`;
    return { nodes: ranked, note };
  }

  /**
   * Truncate output if it exceeds the maximum length
   */
  private truncateOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_LENGTH) return text;
    const truncated = text.slice(0, MAX_OUTPUT_LENGTH);
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = lastNewline > MAX_OUTPUT_LENGTH * 0.8 ? lastNewline : MAX_OUTPUT_LENGTH;
    return truncated.slice(0, cutPoint) + '\n\n... (output truncated)';
  }

  /** Truncate at a line boundary without applying the global 15K budget. */
  private truncateAtLine(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const cut = text.slice(0, maxChars);
    const lastNewline = cut.lastIndexOf('\n');
    return cut.slice(0, lastNewline > maxChars * 0.7 ? lastNewline : maxChars);
  }

  // =========================================================================
  // Formatting helpers (compact by default to reduce context usage)
  // =========================================================================

  /**
   * Stable re-order of FTS-returned candidates: generated files (.pb.go,
   * _grpc.pb.go, …) sink; within each group definitions rank before
   * declarations (prototypes) so the agent sees the implementation body
   * before the header signature. Preserves FTS/BM25 order within a group.
   */
  private rankSearchResults(results: SearchResult[], pathHint?: string): SearchResult[] {
    const originalOrder = new Map(results.map((result, index) => [result.node.id, index]));
    return [...results].sort((a, b) => {
      if (pathHint) {
        const relevanceOrder = b.score - a.score;
        if (relevanceOrder !== 0) return relevanceOrder;
        const pathOrder = comparePathSimilarity(a.node.filePath, b.node.filePath, pathHint);
        if (pathOrder !== 0) return pathOrder;
      }
      const aGen = isGeneratedFile(a.node.filePath) ? 1 : 0;
      const bGen = isGeneratedFile(b.node.filePath) ? 1 : 0;
      if (aGen !== bGen) return aGen - bGen;
      const aDecl = a.node.isDeclaration === true ? 1 : 0;
      const bDecl = b.node.isDeclaration === true ? 1 : 0;
      return aDecl - bDecl ||
        (originalOrder.get(a.node.id) ?? 0) - (originalOrder.get(b.node.id) ?? 0);
    });
  }

  /** Search-only path ranking; never changes declaration/definition primary selection. */
  private rankSearchCandidatesByPath(nodes: Node[], pathHint?: string): Node[] {
    const baseline = this.rankExactSymbolNodes(nodes);
    if (!pathHint) return baseline;
    const baselineOrder = new Map(baseline.map((node, index) => [node.id, index]));
    const pathScores = new Map<string, ReturnType<typeof scorePathSimilarity>>();
    const scoreFor = (filePath: string): ReturnType<typeof scorePathSimilarity> => {
      let score = pathScores.get(filePath);
      if (!score) {
        score = scorePathSimilarity(filePath, pathHint);
        pathScores.set(filePath, score);
      }
      return score;
    };
    return [...baseline].sort((left, right) =>
      comparePathSimilarityScores(scoreFor(left.filePath), scoreFor(right.filePath)) ||
      (baselineOrder.get(left.id) ?? 0) - (baselineOrder.get(right.id) ?? 0));
  }

  /** Stable exact-symbol ranking shared by search/node/callers helpers. */
  private rankExactSymbolNodes(nodes: Node[]): Node[] {
    const generatedByPath = new Map<string, boolean>();
    const generated = (filePath: string): boolean => {
      if (!generatedByPath.has(filePath)) {
        generatedByPath.set(filePath, isGeneratedFile(filePath));
      }
      return generatedByPath.get(filePath) ?? false;
    };
    return [...nodes].sort((a, b) => {
      const declarationOrder = Number(a.isDeclaration === true) - Number(b.isDeclaration === true);
      if (declarationOrder !== 0) return declarationOrder;
      const generatedOrder = Number(generated(a.filePath)) - Number(generated(b.filePath));
      if (generatedOrder !== 0) return generatedOrder;
      const qualifiedOrder = a.qualifiedName.localeCompare(b.qualifiedName);
      if (qualifiedOrder !== 0) return qualifiedOrder;
      const kindOrder = a.kind.localeCompare(b.kind);
      if (kindOrder !== 0) return kindOrder;
      const pathOrder = a.filePath.localeCompare(b.filePath);
      if (pathOrder !== 0) return pathOrder;
      return a.startLine - b.startLine;
    });
  }

  private formatSearchResults(cg: CodeGraph, results: SearchResult[]): string {
    const lines: string[] = [`## Search Results (${results.length} found)`, ''];
    let declarationOnlyCount = 0;
    const overloadCaches = new Map<string, RelationshipOverloadCache>();
    const overloadCacheFor = (node: Node): RelationshipOverloadCache => {
      let cache = overloadCaches.get(node.name);
      if (!cache) {
        cache = this.createRelationshipOverloadCache(cg.getNodesByName(node.name));
        overloadCaches.set(node.name, cache);
      }
      return cache;
    };

    for (const result of results) {
      const { node } = result;
      const location = node.startLine ? `:${node.startLine}` : '';
      // Compact format: one line per result with key info.
      // Tag prototypes so the agent knows to follow the `defines` edge to
      // the definition for the real body/callees rather than dead-ending.
      const overloadCache = node.isDeclaration === true ? overloadCacheFor(node) : undefined;
      const callableKey = this.relationshipParameterKey(node, overloadCache);
      const declarationOnly = node.isDeclaration === true &&
        callableKey !== null &&
        this.indexedDefinitionForDeclaration(cg, node, overloadCache) === null;
      if (declarationOnly) declarationOnlyCount++;
      const declTag = node.isDeclaration === true
        ? declarationOnly
          ? ' [declaration — no indexed definition found for this exact overload]'
          : ' [declaration]'
        : '';
      lines.push(`### ${node.name} (${node.kind})${declTag}`);
      if (node.qualifiedName && node.qualifiedName !== node.name) {
        lines.push(`Qualified: \`${node.qualifiedName}\``);
      }
      lines.push(`${node.filePath}${location}`);
      if (node.signature) lines.push(`\`${node.signature}\``);
      lines.push('');
    }

    if (declarationOnlyCount > 0) {
      lines.push(
        `> ${declarationOnlyCount} exact overload declaration${declarationOnlyCount === 1 ? ' has' : 's have'} no indexed definition. ` +
        'Treat that as authoritative for the current index; do not use Grep or text search merely to verify absence.',
      );
    }

    return lines.join('\n');
  }

  private formatRelationshipList(
    entries: RelatedSymbolRelationships[],
    title: string,
    definitionLabel: 'caller' | 'definition',
    sitesFirst: boolean,
  ): string {
    const lines: string[] = [`## ${title} (${entries.length} found)`, ''];

    for (const entry of entries) {
      const formattedSites = formatRelationshipSites(
        entry.sites,
        MCP_RELATIONSHIP_SITE_LIMIT_PER_NODE,
      );
      const definition = `${definitionLabel}: ${formatDefinitionLocation(entry.node)}`;
      const details = sitesFirst
        ? [...formattedSites.lines, definition]
        : [definition, ...formattedSites.lines];
      lines.push(`- ${entry.node.name} (${entry.node.kind})`);
      for (const detail of details) lines.push(`  - ${detail}`);
      if (formattedSites.omitted > 0) {
        lines.push(`  - … +${formattedSites.omitted} more relationship sites`);
      }
    }

    return lines.join('\n');
  }

  private formatImpact(symbol: string, impact: Subgraph): string {
    const nodeCount = impact.nodes.size;

    // Compact format: just list affected symbols grouped by file
    const lines: string[] = [
      `## Impact: "${symbol}" affects ${nodeCount} symbols`,
      '',
    ];

    // Group by file
    const byFile = new Map<string, Node[]>();
    for (const node of impact.nodes.values()) {
      const existing = byFile.get(node.filePath) || [];
      existing.push(node);
      byFile.set(node.filePath, existing);
    }

    for (const [file, nodes] of byFile) {
      lines.push(`**${file}:**`);
      // Compact: inline list
      const nodeList = nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
      lines.push(nodeList);
      lines.push('');
    }

    return lines.join('\n');
  }

  /** Return stable, source-ordered children for explicit named-container outlines. */
  private containerChildren(cg: CodeGraph, node: Node): Node[] {
    return cg.getChildren(node.id)
      .filter(c => c.kind !== 'import' && c.kind !== 'export')
      .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
  }

  /** Build a compact outline only for an explicit named-container outline request. */
  private buildContainerOutlineFromChildren(children: Node[]): string {
    if (children.length === 0) return '';

    const visible = children.slice(0, MCP_NODE_CONTAINER_OUTLINE_SYMBOLS);
    const lines = [`**Members (${children.length}; showing ${visible.length}):**`, ''];
    for (const c of visible) {
      const loc = `:${formatSourceRange(c.startLine, c.endLine)}`;
      const sig = c.signature ? ` — \`${c.signature}\`` : '';
      lines.push(`- ${c.name} (${c.kind})${loc}${sig}`);
    }
    if (children.length > visible.length) {
      lines.push(
        `- … +${children.length - visible.length} more members omitted`,
        '',
        '> Large container outline capped. Use ONE `codegraph_node(targets=[{ symbol, file, members: [...] }])` implementation bundle for up to 32 already-known members; do not request a broader file outline or Read the class file.',
      );
    }
    return lines.join('\n');
  }

  private formatNodeDetails(
    node: Node,
    code: string | null,
    outline?: string | null,
    sourceCharBudget: number = SYMBOL_SOURCE_MAX_CHARS,
  ): FormattedNodeDetails {
    const lines: string[] = [
      `## ${node.name} (${node.kind})`,
      '',
      `**Location:** ${formatDefinitionLocation(node)}`,
    ];

    if (node.signature) {
      lines.push(`**Signature:** \`${node.signature}\``);
    }

    // Only include docstring if it's short and useful
    if (node.docstring && node.docstring.length < 200) {
      lines.push('', node.docstring);
    }

    let sourceTruncated = false;
    if (outline) {
      const exactSourceTarget = `{ file: ${JSON.stringify(node.filePath)}, symbols: [${JSON.stringify(displaySymbol(node))}] }`;
      lines.push('', outline, '',
        `> Structural outline only. For this container's exact declaration source, use ONE ` +
        `\`codegraph_node(targets=[${exactSourceTarget}])\` implementation bundle; ` +
        'for selected implementations use `{ symbol, file, members: [...] }`, which also returns matching C++ out-of-line definitions. Do not Read the file.');
    } else if (code) {
      // Line-numbered (cat -n style, like codegraph_explore and Read) so the
      // agent can cite/edit exact lines without re-Reading the file for them.
      const bounded = boundNumberedSource(code, node.startLine || 1, sourceCharBudget);
      sourceTruncated = bounded.truncated;
      lines.push('', '```' + node.language, bounded.text, '```');
      if (bounded.truncated) {
        lines.push('',
          `> Source truncated at line ${bounded.shownEndLine} to fit the ${sourceCharBudget.toLocaleString('en-US')}-character symbol budget; ` +
          `the indexed symbol continues through line ${node.endLine ?? node.startLine}.`);
      }
    }

    return { text: lines.join('\n'), sourceTruncated };
  }

  /** Convert an exact/qualified lookup into the identifier a raw scan can verify. */
  private rawEvidenceNeedle(symbolOrSignature: string): string | undefined {
    const symbol = parseCallableLookup(symbolOrSignature.trim()).symbol;
    const leaf = symbol.replace(/\./g, '::').split('::').filter(Boolean).at(-1)?.replace(/^~/, '') ?? '';
    return /^[A-Za-z_$][\w$]*$/.test(leaf) && leaf.length >= 3 ? leaf : undefined;
  }

  private async renderRawEvidence(cg: CodeGraph, specs: RawEvidenceSpec[]): Promise<string> {
    const unique = new Map<string, RawEvidenceSpec>();
    for (const spec of specs) {
      // A global raw scan for `run`, `get`, etc. is expensive and proves little.
      // Exact-file/path misses remain safe, while global scans require a
      // distinctive code-shaped identifier.
      if (!spec.path && !isDistinctiveIdentifier(spec.needle)) continue;
      const key = `${spec.needle}\u0000${spec.path?.replace(/\\/g, '/').toLowerCase() ?? ''}`;
      const existing = unique.get(key);
      if (!existing || (existing.purpose !== 'declaration_only' && spec.purpose === 'declaration_only')) {
        unique.set(key, spec);
      }
    }
    if (unique.size === 0) return '';
    return this.truncateAtLine(
      formatRawSourceEvidence(await scanRawSourceEvidence(
        cg,
        [...unique.values()],
        undefined,
        { signal: this.executionSignal.getStore() },
      )),
      6_000,
    );
  }

  /** Batch search collects misses so the bundled ripgrep scan runs once. */
  private async renderSearchRawEvidence(
    cg: CodeGraph,
    specs: RawEvidenceSpec[],
    deferred?: RawEvidenceSpec[],
  ): Promise<string> {
    if (deferred) {
      deferred.push(...specs);
      return '';
    }
    return await this.renderRawEvidence(cg, specs);
  }

  private textResult(text: string): ToolResult {
    return {
      content: [{ type: 'text', text }],
    };
  }

  private errorResult(message: string): ToolResult {
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}
