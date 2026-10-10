export type SignalOrigin = 'prose' | 'code' | 'draft' | 'pseudocode';
export interface LocateSignal {
  text: string;
  kind: 'symbol' | 'literal' | 'path';
  mentions: Array<{ line: number; origin: SignalOrigin; excluded: boolean }>;
}
export interface LocateDocument {
  signals: LocateSignal[];
  snippets: Array<{ line: number; origin: SignalOrigin; lines: string[] }>;
  truncated: boolean;
}
export interface LocateEvidence {
  kind: 'definition' | 'graph' | 'snippet' | 'literal' | 'source_anchor' | 'path';
  clue: string;
  documentLine: number;
  sourceLine: number;
  detail?: string;
  documentText?: string;
  sourceFile?: string;
  fromSymbol?: string;
  toSymbol?: string;
  relationKind?: string;
  provenance?: string;
}
export interface LocateCandidate {
  symbol: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  confidence: 'high' | 'medium';
  role: 'direct' | 'related';
  signature?: string;
  evidence: LocateEvidence[];
  source: string;
  tokens: number;
  truncated: boolean;
}
export interface LocateResult {
  experimental: true;
  projectPath: string;
  backend: 'index+source';
  partial: boolean;
  stopReasons: string[];
  candidates: LocateCandidate[];
  files: Array<{ filePath: string; symbols: string[] }>;
  clues: Array<{
    text: string;
    documentLine: number;
    origin: SignalOrigin;
    status: 'verified' | 'source_match' | 'index_match' | 'index_miss' | 'unverified' | 'out_of_scope';
    filePath?: string;
    sourceLine?: number;
  }>;
  notes: string[];
  stats: { elapsedMs: number; searchedClues: number; examinedNodes: number; graphEdges: number; readFiles: number };
  budget: { tokenizer: string; maxTokens: number; maxTokensPerClue: number; outputTokens: number; omittedCandidates: number; omittedClues: number };
}
export interface LocateOptions {
  timeoutMs?: number;
  maxCandidates?: number;
  maxTokens?: number;
  maxTokensPerClue?: number;
  outputFormat?: 'json' | 'text';
  verbose?: boolean;
  signal?: AbortSignal;
}
export interface LocateTask {
  projectPath: string;
  document: LocateDocument;
  timeoutMs: number;
  maxCandidates: number;
  maxTokens: number;
  maxTokensPerClue: number;
}
export function emptyLocateResult(task: LocateTask): LocateResult {
  return {
    experimental: true, projectPath: task.projectPath, backend: 'index+source', partial: false,
    stopReasons: [], candidates: [], files: [],
    clues: task.document.signals.map(signal => ({ text: signal.text, documentLine: signal.mentions[0]!.line, origin: signal.mentions[0]!.origin, status: 'unverified' })),
    notes: [], stats: { elapsedMs: 0, searchedClues: 0, examinedNodes: 0, graphEdges: 0, readFiles: 0 },
    budget: { tokenizer: 'o200k_base', maxTokens: task.maxTokens, maxTokensPerClue: task.maxTokensPerClue, outputTokens: 0, omittedCandidates: 0, omittedClues: 0 },
  };
}
