import type CodeGraph from '../index';
import { loadTermMappings, getTermMappingSymbolMatches } from '../term-mappings';

export type MappingCheckStatus = 'FOUND' | 'MULTIPLE' | 'NOT_FOUND_IN_INDEX' | 'UNVERIFIED';
export interface MappingCheckResult {
  symbol: string;
  status: MappingCheckStatus;
  count: number;
  candidates: Array<{ id: string; name: string; qualifiedName?: string; kind: string; filePath: string; startLine: number }>;
  truncated: boolean;
}
export interface MappingsCheckReport {
  configPath: string;
  ruleCount: number;
  uniqueSymbolCount: number;
  results: MappingCheckResult[];
  errors: string[];
  warnings: string[];
  index: { status: 'complete' | 'incomplete' | 'unknown' | 'unavailable'; stale: boolean | null };
  source: { status: 'not_checked' | 'unchanged' | 'changed' | 'unverified'; added?: number; modified?: number; removed?: number };
  exitCode: 0 | 1 | 2;
}

type Graph = Pick<CodeGraph, 'getExploreQueryConnection' | 'getIndexCompleteness' | 'isIndexStale' | 'getChangedFiles'>;

/** Checks stored index evidence only. It never starts an indexer or repairs data. */
export function checkTermMappings(
  dataDir: string,
  graph?: Graph,
  options: { checkSource?: boolean; worktreeMismatch?: boolean; unavailableReason?: string } = {},
): MappingsCheckReport {
  const config = loadTermMappings(dataDir);
  const symbols = [...new Set(config.rules.flatMap(rule => rule.symbols))];
  const report: MappingsCheckReport = {
    configPath: config.path, ruleCount: config.rules.length, uniqueSymbolCount: symbols.length,
    results: [], errors: [...config.errors], warnings: [...config.warnings],
    index: { status: 'unavailable', stale: null },
    source: { status: 'not_checked' }, exitCode: 0,
  };
  if (!config.exists) report.errors.push('Term mappings configuration does not exist.');
  if (report.errors.length > 0) { report.exitCode = 2; return report; }
  if (!graph) {
    report.errors.push(options.unavailableReason ?? 'Index is unavailable; initialize the index before checking mappings.');
    report.results = symbols.map(symbol => ({ symbol, status: 'UNVERIFIED', count: 0, candidates: [], truncated: false }));
    report.exitCode = 2;
    return report;
  }

  let reliable = true;
  try {
    const coverage = graph.getIndexCompleteness();
    const stale = graph.isIndexStale();
    report.index = { status: coverage.status, stale };
    if (coverage.status !== 'complete' || stale || coverage.legacyUnverified) {
      reliable = false;
      report.warnings.push('Index coverage or extraction version is unverified; missing symbols cannot be confirmed.');
    }
    if (options.worktreeMismatch) {
      reliable = false;
      report.source.status = 'unverified';
      report.warnings.push('The selected index belongs to a different working tree.');
    } else if (options.checkSource) {
      const changes = graph.getChangedFiles();
      const added = changes.added.length;
      const modified = changes.modified.length;
      const removed = changes.removed.length;
      const changed = added + modified + removed > 0;
      report.source = { status: changed ? 'changed' : 'unchanged', added, modified, removed };
      if (changed) {
        reliable = false;
        report.warnings.push('Source changes are not reflected in the current index; synchronize before confirming missing symbols.');
      }
    }
    const matches = getTermMappingSymbolMatches(graph.getExploreQueryConnection(), symbols, 20);
    report.results = symbols.map(symbol => {
      const match = matches.get(symbol);
      const count = match?.count ?? 0;
      const candidates = match?.candidates ?? [];
      return {
        symbol, count, candidates, truncated: count > candidates.length,
        status: count > 1 ? 'MULTIPLE' : count === 1 ? 'FOUND' : reliable ? 'NOT_FOUND_IN_INDEX' : 'UNVERIFIED',
      };
    });
    report.exitCode = !reliable ? 2 : report.results.some(result => result.count === 0) ? 1 : 0;
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    report.results = symbols.map(symbol => ({ symbol, status: 'UNVERIFIED', count: 0, candidates: [], truncated: false }));
    report.exitCode = 2;
  }
  return report;
}

export function formatMappingsCheck(report: MappingsCheckReport): string {
  const lines = [
    `Term mappings: ${report.configPath}`,
    `Rules: ${report.ruleCount}; unique symbols: ${report.uniqueSymbolCount}`,
  ];
  for (const result of report.results) {
    lines.push(`${result.status.padEnd(19)} ${result.symbol}${result.count > 1 ? ` (${result.count} candidates; review same-name definitions/declarations)` : ''}`);
    for (const candidate of result.candidates) {
      lines.push(`  ${candidate.kind} ${candidate.qualifiedName || candidate.name}  ${candidate.filePath}:${candidate.startLine}`);
    }
    if (result.truncated) lines.push(`  Showing ${result.candidates.length} of ${result.count} candidates.`);
  }
  lines.push(`Index: ${report.index.status}; extraction stale: ${report.index.stale ?? 'unknown'}`);
  lines.push(`Source: ${report.source.status}${report.source.status === 'not_checked' ? ' (current index only; use --check-source to check changes)' : ''}`);
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  for (const error of report.errors) lines.push(`Error: ${error}`);
  if (report.results.some(result => result.count === 0)) {
    lines.push('A missing index entry does not prove that the source symbol was deleted.');
  }
  return lines.join('\n');
}
