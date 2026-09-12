/** Plain-data contract shared by the MCP thread and raw-source workers. */
export interface RawEvidenceSpec {
  /** Original symbol/signature displayed with the evidence. */
  label: string;
  /** Identifier or literal to search in the current on-disk source. */
  needle: string;
  /** Optional case-insensitive indexed path substring. */
  path?: string;
  /** Identifier mode enforces code-identifier boundaries. */
  mode?: 'identifier' | 'literal';
  purpose?: 'generic' | 'declaration_only';
}

export interface RawEvidenceSnippet {
  file: string;
  line: number;
  text: string;
}

export interface RawEvidenceState {
  spec: RawEvidenceSpec;
  normalizedPath?: string;
  eligibleFiles: number;
  scannedFiles: number;
  scannedBytes: number;
  unreadableFiles: number;
  matchingLines: number;
  snippets: RawEvidenceSnippet[];
}

export interface RawEvidenceReport {
  states: RawEvidenceState[];
  totalScannedFiles: number;
  totalScannedBytes: number;
  budgetReached: boolean;
  timeBudgetReached: boolean;
  cancelled: boolean;
  omittedQueries: number;
  backend: 'ripgrep' | 'hybrid' | 'node';
  /** An unchanged, actively-watched source epoch reused the result. */
  cacheHit: boolean;
}

export interface RawEvidenceFile {
  path: string;
  size: number;
}

export interface RawEvidenceTask {
  projectRoot: string;
  files: RawEvidenceFile[];
  specs: RawEvidenceSpec[];
  omittedQueries: number;
  maxScannedBytes: number;
  /** Scan budget, starting in the worker; excludes queue/startup/delivery. */
  timeoutMs: number;
  backend?: string;
  rgPath?: string;
}

export interface RawEvidenceProgress {
  stage: 'inventory' | 'search';
  event: 'start' | 'end';
  pid?: number;
  elapsedMs?: number;
  status?: number | null;
}

export type RawEvidenceWorkerMessage =
  | { type: 'progress'; progress: RawEvidenceProgress }
  | { type: 'result'; report: RawEvidenceReport }
  | { type: 'error'; message: string };

export interface RawEvidenceWorkerData {
  task: RawEvidenceTask;
  /** [cancellation requested, active child PID]; no database is shared. */
  control: SharedArrayBuffer;
}

export function normalizedEvidencePath(value: string | undefined): string | undefined {
  return value?.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase() || undefined;
}

export function createRawEvidenceStates(task: RawEvidenceTask): RawEvidenceState[] {
  return task.specs.map((spec) => {
    const normalizedPath = normalizedEvidencePath(spec.path);
    return {
      spec,
      normalizedPath,
      eligibleFiles: task.files.filter((file) => !normalizedPath || file.path.replace(/\\/g, '/').toLowerCase().includes(normalizedPath)).length,
      scannedFiles: 0,
      scannedBytes: 0,
      unreadableFiles: 0,
      matchingLines: 0,
      snippets: [],
    };
  });
}

/** Queued/pre-aborted jobs never start a filesystem scan. */
export function cancelledRawEvidenceReport(task: RawEvidenceTask): RawEvidenceReport {
  return {
    states: createRawEvidenceStates(task),
    totalScannedFiles: 0, totalScannedBytes: 0,
    budgetReached: false, timeBudgetReached: false, cancelled: true,
    omittedQueries: task.omittedQueries, backend: 'node', cacheHit: false,
  };
}
