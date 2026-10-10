import { Tiktoken, type TiktokenBPE } from 'js-tiktoken/lite';
import type { LocateCandidate, LocateResult } from './types';
import { candidateGuide, clueText, renderLocateGuide } from './guide';

let tokenizer: Tiktoken | undefined;
export function countLocateTokens(text: string): number {
  // Bundled local ranks: no network, model calls, or API credentials.
  tokenizer ??= new Tiktoken(require('js-tiktoken/ranks/o200k_base') as TiktokenBPE);
  return tokenizer.encode(text, [], []).length;
}

function render(result: LocateResult, format: 'json' | 'text', verbose: boolean): string {
  if (format === 'json') return JSON.stringify(result) + '\n';
  return renderLocateGuide(result, verbose);
}

function candidateTokens(candidate: LocateCandidate): number {
  for (let i = 0; i < 6; i++) {
    const n = Math.max(countLocateTokens(JSON.stringify(candidate)), countLocateTokens(candidateGuide(candidate)));
    if (n === candidate.tokens) return n;
    candidate.tokens = n;
  }
  return candidate.tokens;
}

function shrinkCandidate(candidate: LocateCandidate): boolean {
  candidate.truncated = true;
  const graphIndex = candidate.evidence.map(e => e.kind === 'graph').lastIndexOf(true);
  const quote = candidate.evidence.find(e => e.documentText);
  // Keep primary evidence and source ahead of redundant graph records and signatures.
  if (graphIndex >= 0 && candidate.evidence.length > 1) candidate.evidence.splice(graphIndex, 1);
  else if (candidate.signature) delete candidate.signature;
  else if (quote?.documentText) delete quote.documentText;
  else if (candidate.source) {
    const lines = candidate.source.split('\n');
    candidate.source = lines.length > 1 ? lines.slice(0, -1).join('\n') : '';
  } else if (candidate.evidence.length > 1) candidate.evidence.pop();
  else return false;
  return true;
}

/** Enforce limits on the exact output, including metadata, evidence, escaping and newline. */
export function boundLocateOutput(original: LocateResult, format: 'json' | 'text' = 'json', verbose = false): { result: LocateResult; output: string } {
  const result = structuredClone(original);
  const omitted = () => {
    result.partial = true;
    if (!result.stopReasons.includes('output_token_limit')) result.stopReasons.push('output_token_limit');
  };
  const candidates: LocateCandidate[] = [];
  for (const candidate of result.candidates) {
    const graphSeen = new Set<string>();
    candidate.evidence = candidate.evidence.filter(e => {
      if (e.kind !== 'graph' || !e.fromSymbol || !e.toSymbol) return true;
      const key = JSON.stringify([e.fromSymbol, e.toSymbol, e.relationKind, e.sourceFile, e.sourceLine, e.provenance]);
      if (graphSeen.has(key)) return false;
      graphSeen.add(key); return true;
    });
    while (candidateTokens(candidate) > result.budget.maxTokensPerClue && shrinkCandidate(candidate)) omitted();
    if (candidateTokens(candidate) <= result.budget.maxTokensPerClue) candidates.push(candidate);
    else { result.budget.omittedCandidates++; omitted(); }
  }
  result.candidates = candidates;
  result.clues = result.clues.filter(clue => {
    if (Math.max(countLocateTokens(JSON.stringify(clue)), countLocateTokens(clueText(clue))) <= result.budget.maxTokensPerClue) return true;
    result.budget.omittedClues++; omitted(); return false;
  });
  const syncFiles = () => {
    result.files = result.files.map(f => ({ ...f, symbols: f.symbols.filter(s => result.candidates.some(c => c.filePath === f.filePath && c.symbol === s)) })).filter(f => f.symbols.length);
  };
  syncFiles();
  const measure = () => {
    for (let i = 0; i < 6; i++) {
      const size = countLocateTokens(render(result, format, verbose));
      if (size === result.budget.outputTokens) break;
      result.budget.outputTokens = size;
    }
    return countLocateTokens(render(result, format, verbose));
  };
  while (measure() > result.budget.maxTokens) {
    omitted();
    // Drop redundant file summaries and verified input-clue listings before useful candidates.
    if (format === 'json' && result.files.length) result.files.pop();
    else if (format === 'json' && result.clues.some(c => c.status === 'verified' || c.status === 'index_match')) {
      result.clues.splice(result.clues.findIndex(c => c.status === 'verified' || c.status === 'index_match'), 1);
      result.budget.omittedClues++;
    } else if (result.clues.filter(c => c.status !== 'verified' && c.status !== 'index_match').length > 8) {
      const index = result.clues.map(c => c.status !== 'verified' && c.status !== 'index_match').lastIndexOf(true);
      result.clues.splice(index, 1); result.budget.omittedClues++;
    } else if (result.candidates.length > 1) { result.candidates.pop(); result.budget.omittedCandidates++; syncFiles(); }
    else if (result.clues.length) { result.clues.pop(); result.budget.omittedClues++; }
    else if (result.candidates[0] && shrinkCandidate(result.candidates[0])) candidateTokens(result.candidates[0]);
    else if (result.notes.length) result.notes.pop();
    else if (result.candidates.length) { result.candidates.pop(); result.budget.omittedCandidates++; syncFiles(); }
    else {
      // Even pathological project paths must not overrun a tiny requested budget.
      result.projectPath = '';
      result.stopReasons = ['output_token_limit'];
      if (measure() > result.budget.maxTokens) throw new Error('Token budget too small for the response envelope');
    }
  }
  return { result, output: render(result, format, verbose) };
}
