import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ExtractionTimings, GraphStats } from '../types';
import type { SqliteBackend, SqliteDatabase } from '../db/sqlite-adapter';

export const INIT_PROFILE_SCHEMA_VERSION = 1;

export type InitProfilePhase =
  | 'mutexWait'
  | 'preflight'
  | 'scan'
  | 'frameworkDetection'
  | 'macroScan'
  | 'workerSetup'
  | 'workerReady'
  | 'fileMetadata'
  | 'fileRead'
  | 'fileReadService'
  | 'parseWall'
  | 'bundleBuild'
  | 'walBackpressure'
  | 'writerMessageSend'
  | 'writerWindowWait'
  | 'storeAdmission'
  | 'writerDrain'
  | 'extraction'
  | 'parseIndexRebuild'
  | 'ftsRebuild'
  | 'walFold'
  | 'walDrain'
  | 'postExtract'
  | 'referenceResolution'
  | 'synthesis'
  | 'chainedResolution'
  | 'maintenance'
  | 'finalization'
  | 'restoreDatabaseMode'
  | 'graphFingerprint';

export interface InitProfileInput {
  sourceFilesDiscovered: number;
  sourceFilesRead: number;
  sourceBytes: number;
  filesByLanguage: Record<string, number>;
  bytesByLanguage: Record<string, number>;
  fileSizeBytes: {
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  macroFilesScanned: number;
  macroBytesScanned: number;
  /** Files and bytes that reached the macro regex/declaration scanner. */
  macroFilesParsed: number;
  macroBytesParsed: number;
}

export interface InitProfileResolution {
  totalReferences: number;
  resolvedReferences: number;
  unresolvedReferences: number;
  parallelBatches: number;
  sequentialBatches: number;
  cacheWarmMs?: number;
  resolverPoolReadyMs?: number;
  /** Sum of warm-up time reported by parallel resolver admissions. */
  parallelResolverCacheWarmMs?: number;
  cppImportCacheHits: number;
  cppImportCacheMisses: number;
  byMethod: Record<string, number>;
}

export interface InitProfileSynthesisPass {
  name: string;
  durationMs: number;
  edgesAdded: number;
  status: 'completed' | 'failed' | 'skipped';
  reason?: string;
}

export interface InitProfileWriter {
  bundlesSent: number;
  messagesSent: number;
  sourceBytes: number;
  nodesSent: number;
  edgesSent: number;
  unresolvedRefsSent: number;
  maxOutstandingBundles: number;
  walBackpressureCount: number;
  windowWaitCount: number;
  windowWaitMs: number;
  transactions: number;
  transactionMs: number;
  rowAggregationMs: number;
  duplicateNodeRowsElided: number;
  nodeWriteMs: number;
  edgeWriteMs: number;
  unresolvedRefWriteMs: number;
  fileWriteMs: number;
  filesStored: number;
  nodesStored: number;
  edgesStored: number;
  unresolvedRefsStored: number;
}

export interface InitProfileDurationDistribution {
  count: number;
  totalMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface InitProfileParseFileSample {
  filePath: string;
  language: string;
  sizeBytes: number;
  turnaroundMs: number;
  extractorDurationMs?: number;
  success: boolean;
}

export interface InitProfileExtractionScheduling {
  batches: number;
  filesObserved: number;
  filesFailed: number;
  batchWallMs: InitProfileDurationDistribution;
  fileTurnaroundMs: InitProfileDurationDistribution;
  extractorDurationMs: InitProfileDurationDistribution;
  /**
   * Sum, across each fixed batch, of max(file turnaround) - file turnaround.
   * This estimates how long completed file results sat behind batch stragglers.
   */
  barrierSlackMs: number;
  poolStateSamples: number;
  maxQueueDepth: number;
  maxInflightWorkers: number;
  maxIdleWorkers: number;
  maxPendingWorkers: number;
  maxLiveWorkers: number;
  windowStateSamples?: number;
  maxWindowTasks?: number;
  maxWindowCompletedTasks?: number;
  maxWindowSourceBytes?: number;
  maxWindowResultRows?: number;
  slowestFiles: InitProfileParseFileSample[];
}

export interface InitProfile {
  schemaVersion: typeof INIT_PROFILE_SCHEMA_VERSION;
  startedAt: string;
  finishedAt: string;
  projectRoot: string;
  environment: {
    codegraphVersion: string;
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
    osRelease: string;
    cpuCount: number;
    totalMemoryBytes: number;
    sqliteBackend: SqliteBackend;
    initialJournalMode: string;
  };
  configuration: {
    freshDatabase?: boolean;
    fastInit?: boolean;
    walDeferred?: boolean;
    parseIndexesDeferred?: boolean;
    bulkFts?: boolean;
    storeBatching?: boolean;
    storeNodeDedupe?: boolean;
    storeRowBatchMax?: number;
    streamingExtraction?: boolean;
    streamingTaskLimit?: number;
    streamingSourceByteLimit?: number;
    streamingResultRowLimit?: number;
    macroCandidatePrefilter?: boolean;
    batchedEdgePromotion?: boolean;
    parseWorkers?: number;
    resolverWorkers?: number;
    environmentOverrides: Record<string, string>;
  };
  timings: {
    indexingMs: number;
    profileOverheadMs: number;
    phases: Partial<Record<InitProfilePhase, number>>;
    extractor: ExtractionTimings;
  };
  input: InitProfileInput;
  extractionScheduling?: InitProfileExtractionScheduling;
  writer?: InitProfileWriter;
  resolution?: InitProfileResolution;
  synthesis: {
    admission?: {
      run: boolean;
      requiredHeadroomBytes: number;
      reason?: string;
    };
    passes: InitProfileSynthesisPass[];
  };
  output: {
    success: boolean;
    complete?: boolean;
    filesIndexed: number;
    filesSkipped: number;
    filesErrored: number;
    nodesCreated: number;
    edgesCreated: number;
    pendingReferences: number;
    databaseSizeBytes: number;
    graph?: GraphStats;
    graphFingerprint?: string;
    diagnostics: number;
  };
  resources: {
    cpuUserMs: number;
    cpuSystemMs: number;
    rssStartBytes: number;
    rssEndBytes: number;
    processMaxRssBytes: number;
    heapUsedEndBytes: number;
  };
}

export interface InitProfileResultSummary {
  success: boolean;
  complete?: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  pendingReferences: number;
  databaseSizeBytes: number;
  graph?: GraphStats;
  graphFingerprint?: string;
  diagnostics: number;
}

const PROFILE_ENV_KEYS = [
  'CODEGRAPH_PARSE_WORKERS',
  'CODEGRAPH_RESOLVE_WORKERS',
  'CODEGRAPH_PARALLEL_RESOLVE_MIN',
  'CODEGRAPH_RESOLVER_CACHE_SIZE',
  'CODEGRAPH_PARSE_TIMEOUT_MS',
  'CODEGRAPH_RESOLVE_TASK_TIMEOUT_MS',
  'CODEGRAPH_WAL_VALVE_MB',
  'CODEGRAPH_DEDUP_SYMLINKS',
  'CODEGRAPH_FORCE_PARSE',
  'CODEGRAPH_NO_FAST_INIT',
  'CODEGRAPH_NO_WAL_DEFER',
  'CODEGRAPH_NO_BATCH_WRITES',
  'CODEGRAPH_NO_STORE_BATCHING',
  'CODEGRAPH_NO_STORE_NODE_DEDUPE',
  'CODEGRAPH_NO_NATIVE_STORE_ROW_BATCH',
  'CODEGRAPH_NO_STREAMING_EXTRACTION',
  'CODEGRAPH_NO_MACRO_CANDIDATE_PREFILTER',
  'CODEGRAPH_NO_BULK_FTS',
  'CODEGRAPH_NO_PARSE_INDEX_DEFER',
  'CODEGRAPH_NO_RESOLVE_INDEX_DEFER',
  'CODEGRAPH_NO_PARALLEL_RESOLVE',
  'CODEGRAPH_NO_RESOLVE_EQUIVALENCE_CACHE',
  'CODEGRAPH_NO_BATCHED_EDGE_PROMOTION',
  'CODEGRAPH_NO_STORE_WORKER',
  'CODEGRAPH_FORCE_WASM',
  'CODEGRAPH_NO_SYNTHESIS',
] as const;

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index] ?? 0;
}

function durationDistribution(
  samples: readonly number[],
): InitProfileDurationDistribution {
  const sorted = samples
    .map((value) => Math.max(0, value))
    .sort((a, b) => a - b);
  return {
    count: sorted.length,
    totalMs: roundMs(sorted.reduce((sum, value) => sum + value, 0)),
    minMs: roundMs(sorted[0] ?? 0),
    p50Ms: roundMs(percentile(sorted, 0.5)),
    p95Ms: roundMs(percentile(sorted, 0.95)),
    p99Ms: roundMs(percentile(sorted, 0.99)),
    maxMs: roundMs(sorted[sorted.length - 1] ?? 0),
  };
}

function selectedEnvironmentOverrides(): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of PROFILE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

/**
 * Mutable collector used only when profiling is explicitly requested.
 * Keeping it out of the default path avoids graph-sized diagnostic allocations.
 */
export class InitProfileRecorder {
  private readonly startedAtMs = Date.now();
  private readonly startedAtMonotonic = performance.now();
  private readonly cpuStart = process.cpuUsage();
  private readonly rssStart = process.memoryUsage().rss;
  private indexingFinishedAtMonotonic: number | null = null;
  private readonly phases: Partial<Record<InitProfilePhase, number>> = {};
  private readonly extractorTimings: ExtractionTimings = {};
  private sourceFilesDiscovered = 0;
  private sourceFilesRead = 0;
  private sourceBytes = 0;
  private readonly sourceSizes: number[] = [];
  private readonly filesByLanguage: Record<string, number> = {};
  private readonly bytesByLanguage: Record<string, number> = {};
  private macroFilesScanned = 0;
  private macroBytesScanned = 0;
  private macroFilesParsed = 0;
  private macroBytesParsed = 0;
  private resolution?: InitProfileResolution;
  private writer?: InitProfileWriter;
  private readonly parseBatchWallSamples: number[] = [];
  private readonly parseFileTurnaroundSamples: number[] = [];
  private readonly extractorDurationSamples: number[] = [];
  private parseFilesFailed = 0;
  private parseBarrierSlackMs = 0;
  private parsePoolStateSamples = 0;
  private maxParseQueueDepth = 0;
  private maxParseInflightWorkers = 0;
  private maxParseIdleWorkers = 0;
  private maxParsePendingWorkers = 0;
  private maxParseLiveWorkers = 0;
  private parseWindowStateSamples = 0;
  private maxParseWindowTasks = 0;
  private maxParseWindowCompletedTasks = 0;
  private maxParseWindowSourceBytes = 0;
  private maxParseWindowResultRows = 0;
  private readonly slowestParseFiles: InitProfileParseFileSample[] = [];
  private readonly synthesisPasses: InitProfileSynthesisPass[] = [];
  private synthesisAdmission?: InitProfile['synthesis']['admission'];
  private readonly configuration: InitProfile['configuration'];

  constructor(
    private readonly environment: InitProfile['environment'],
    private readonly projectRoot: string,
  ) {
    this.configuration = {
      environmentOverrides: selectedEnvironmentOverrides(),
    };
  }

  recordPhase(name: InitProfilePhase, durationMs: number): void {
    this.phases[name] = roundMs(
      (this.phases[name] ?? 0) + Math.max(0, durationMs),
    );
  }

  recordConfiguration(
    values: Omit<Partial<InitProfile['configuration']>, 'environmentOverrides'>,
  ): void {
    Object.assign(this.configuration, values);
  }

  recordSourceManifest(fileCount: number): void {
    this.sourceFilesDiscovered = fileCount;
  }

  recordSourceFile(language: string, sizeBytes: number): void {
    const size = Math.max(0, sizeBytes);
    this.sourceFilesRead++;
    this.sourceBytes += size;
    this.sourceSizes.push(size);
    this.filesByLanguage[language] = (this.filesByLanguage[language] ?? 0) + 1;
    this.bytesByLanguage[language] = (this.bytesByLanguage[language] ?? 0) + size;
  }

  recordMacroFile(sizeBytes: number): void {
    this.macroFilesScanned++;
    this.macroBytesScanned += Math.max(0, sizeBytes);
  }

  recordMacroFileParsed(sizeBytes: number): void {
    this.macroFilesParsed++;
    this.macroBytesParsed += Math.max(0, sizeBytes);
  }

  recordExtractorTimings(timings: ExtractionTimings): void {
    Object.assign(this.extractorTimings, timings);
  }

  recordParseBatch(
    samples: readonly InitProfileParseFileSample[],
    wallMs: number,
  ): void {
    if (samples.length === 0) return;
    this.parseBatchWallSamples.push(Math.max(0, wallMs));

    let maxTurnaroundMs = 0;
    for (const sample of samples) {
      maxTurnaroundMs = Math.max(maxTurnaroundMs, sample.turnaroundMs);
    }
    this.parseBarrierSlackMs += samples.reduce(
      (sum, sample) => sum + maxTurnaroundMs - sample.turnaroundMs,
      0,
    );
    this.recordParseFiles(samples);
  }

  recordParseFiles(samples: readonly InitProfileParseFileSample[]): void {
    const normalizedSamples = samples.map((sample) => {
      const normalized: InitProfileParseFileSample = {
        ...sample,
        sizeBytes: Math.max(0, sample.sizeBytes),
        turnaroundMs: Math.max(0, sample.turnaroundMs),
        extractorDurationMs: sample.extractorDurationMs === undefined
          ? undefined
          : Math.max(0, sample.extractorDurationMs),
      };
      this.parseFileTurnaroundSamples.push(normalized.turnaroundMs);
      if (normalized.extractorDurationMs !== undefined) {
        this.extractorDurationSamples.push(normalized.extractorDurationMs);
      }
      if (!normalized.success) this.parseFilesFailed++;
      return normalized;
    });

    for (const sample of normalizedSamples) {
      this.slowestParseFiles.push(sample);
    }
    this.slowestParseFiles.sort(
      (a, b) =>
        b.turnaroundMs - a.turnaroundMs ||
        a.filePath.localeCompare(b.filePath),
    );
    if (this.slowestParseFiles.length > 20) {
      this.slowestParseFiles.length = 20;
    }
  }

  recordParseWindowState(state: {
    retainedTasks: number;
    completedTasks: number;
    retainedWeight: number;
    retainedResultWeight: number;
  }): void {
    this.parseWindowStateSamples++;
    this.maxParseWindowTasks = Math.max(
      this.maxParseWindowTasks,
      state.retainedTasks,
    );
    this.maxParseWindowCompletedTasks = Math.max(
      this.maxParseWindowCompletedTasks,
      state.completedTasks,
    );
    this.maxParseWindowSourceBytes = Math.max(
      this.maxParseWindowSourceBytes,
      state.retainedWeight,
    );
    this.maxParseWindowResultRows = Math.max(
      this.maxParseWindowResultRows,
      state.retainedResultWeight,
    );
  }

  recordParsePoolState(state: {
    queueDepth: number;
    inflightWorkers: number;
    idleWorkers: number;
    pendingWorkers: number;
    liveWorkers: number;
  }): void {
    this.parsePoolStateSamples++;
    this.maxParseQueueDepth = Math.max(
      this.maxParseQueueDepth,
      state.queueDepth,
    );
    this.maxParseInflightWorkers = Math.max(
      this.maxParseInflightWorkers,
      state.inflightWorkers,
    );
    this.maxParseIdleWorkers = Math.max(
      this.maxParseIdleWorkers,
      state.idleWorkers,
    );
    this.maxParsePendingWorkers = Math.max(
      this.maxParsePendingWorkers,
      state.pendingWorkers,
    );
    this.maxParseLiveWorkers = Math.max(
      this.maxParseLiveWorkers,
      state.liveWorkers,
    );
  }

  recordWriter(stats: InitProfileWriter): void {
    this.writer = {
      ...stats,
      windowWaitMs: roundMs(stats.windowWaitMs),
      transactionMs: roundMs(stats.transactionMs),
    };
  }

  recordResolution(summary: InitProfileResolution): void {
    this.resolution = {
      ...summary,
      cacheWarmMs: summary.cacheWarmMs === undefined
        ? undefined
        : roundMs(summary.cacheWarmMs),
      resolverPoolReadyMs: summary.resolverPoolReadyMs === undefined
        ? undefined
        : roundMs(summary.resolverPoolReadyMs),
      parallelResolverCacheWarmMs: summary.parallelResolverCacheWarmMs === undefined
        ? undefined
        : roundMs(summary.parallelResolverCacheWarmMs),
      byMethod: { ...summary.byMethod },
    };
  }

  recordSynthesisAdmission(
    admission: NonNullable<InitProfile['synthesis']['admission']>,
  ): void {
    this.synthesisAdmission = { ...admission };
  }

  recordSynthesisPass(pass: InitProfileSynthesisPass): void {
    this.synthesisPasses.push({ ...pass, durationMs: roundMs(pass.durationMs) });
  }

  markIndexingFinished(): void {
    if (this.indexingFinishedAtMonotonic === null) {
      this.indexingFinishedAtMonotonic = performance.now();
    }
  }

  finish(summary: InitProfileResultSummary): InitProfile {
    this.markIndexingFinished();
    const finishedAtMs = Date.now();
    const finishedAtMonotonic = performance.now();
    const indexingEnd =
      this.indexingFinishedAtMonotonic ?? finishedAtMonotonic;
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage(this.cpuStart);
    const sizes = [...this.sourceSizes].sort((a, b) => a - b);

    return {
      schemaVersion: INIT_PROFILE_SCHEMA_VERSION,
      startedAt: new Date(this.startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      projectRoot: this.projectRoot,
      environment: { ...this.environment },
      configuration: {
        ...this.configuration,
        environmentOverrides: { ...this.configuration.environmentOverrides },
      },
      timings: {
        indexingMs: roundMs(indexingEnd - this.startedAtMonotonic),
        profileOverheadMs: roundMs(finishedAtMonotonic - indexingEnd),
        phases: { ...this.phases },
        extractor: { ...this.extractorTimings },
      },
      input: {
        sourceFilesDiscovered: this.sourceFilesDiscovered,
        sourceFilesRead: this.sourceFilesRead,
        sourceBytes: this.sourceBytes,
        filesByLanguage: { ...this.filesByLanguage },
        bytesByLanguage: { ...this.bytesByLanguage },
        fileSizeBytes: {
          min: sizes[0] ?? 0,
          p50: percentile(sizes, 0.5),
          p95: percentile(sizes, 0.95),
          p99: percentile(sizes, 0.99),
          max: sizes[sizes.length - 1] ?? 0,
        },
        macroFilesScanned: this.macroFilesScanned,
        macroBytesScanned: this.macroBytesScanned,
        macroFilesParsed: this.macroFilesParsed,
        macroBytesParsed: this.macroBytesParsed,
      },
      extractionScheduling:
        this.parseBatchWallSamples.length > 0 ||
        this.parsePoolStateSamples > 0 ||
        this.parseWindowStateSamples > 0
          ? {
              batches: this.parseBatchWallSamples.length,
              filesObserved: this.parseFileTurnaroundSamples.length,
              filesFailed: this.parseFilesFailed,
              batchWallMs: durationDistribution(this.parseBatchWallSamples),
              fileTurnaroundMs: durationDistribution(
                this.parseFileTurnaroundSamples,
              ),
              extractorDurationMs: durationDistribution(
                this.extractorDurationSamples,
              ),
              barrierSlackMs: roundMs(this.parseBarrierSlackMs),
              poolStateSamples: this.parsePoolStateSamples,
              maxQueueDepth: this.maxParseQueueDepth,
              maxInflightWorkers: this.maxParseInflightWorkers,
              maxIdleWorkers: this.maxParseIdleWorkers,
              maxPendingWorkers: this.maxParsePendingWorkers,
              maxLiveWorkers: this.maxParseLiveWorkers,
              windowStateSamples: this.parseWindowStateSamples || undefined,
              maxWindowTasks: this.parseWindowStateSamples
                ? this.maxParseWindowTasks
                : undefined,
              maxWindowCompletedTasks: this.parseWindowStateSamples
                ? this.maxParseWindowCompletedTasks
                : undefined,
              maxWindowSourceBytes: this.parseWindowStateSamples
                ? this.maxParseWindowSourceBytes
                : undefined,
              maxWindowResultRows: this.parseWindowStateSamples
                ? this.maxParseWindowResultRows
                : undefined,
              slowestFiles: this.slowestParseFiles.map((sample) => ({
                ...sample,
                turnaroundMs: roundMs(sample.turnaroundMs),
                extractorDurationMs:
                  sample.extractorDurationMs === undefined
                    ? undefined
                    : roundMs(sample.extractorDurationMs),
              })),
            }
          : undefined,
      writer: this.writer ? { ...this.writer } : undefined,
      resolution: this.resolution
        ? { ...this.resolution, byMethod: { ...this.resolution.byMethod } }
        : undefined,
      synthesis: {
        admission: this.synthesisAdmission
          ? { ...this.synthesisAdmission }
          : undefined,
        passes: this.synthesisPasses.map((pass) => ({ ...pass })),
      },
      output: { ...summary },
      resources: {
        cpuUserMs: roundMs(cpu.user / 1000),
        cpuSystemMs: roundMs(cpu.system / 1000),
        rssStartBytes: this.rssStart,
        rssEndBytes: memory.rss,
        // Node reports resourceUsage().maxRSS in KiB on supported platforms.
        processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
        heapUsedEndBytes: memory.heapUsed,
      },
    };
  }
}

export function createInitProfileRecorder(options: {
  codegraphVersion: string;
  projectRoot: string;
  sqliteBackend: SqliteBackend;
  journalMode: string;
}): InitProfileRecorder {
  const cpuCount =
    typeof os.availableParallelism === 'function'
      ? os.availableParallelism()
      : os.cpus().length;
  return new InitProfileRecorder(
    {
      codegraphVersion: options.codegraphVersion,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpuCount,
      totalMemoryBytes: os.totalmem(),
      sqliteBackend: options.sqliteBackend,
      initialJournalMode: options.journalMode,
    },
    path.resolve(options.projectRoot),
  );
}

const FINGERPRINT_QUERIES = [
  {
    table: 'nodes',
    sql: `SELECT id, kind, name, qualified_name, file_path, language,
      start_line, end_line, start_column, end_column, docstring, signature,
      visibility, is_exported, is_async, is_static, is_abstract,
      is_declaration, decorators, type_parameters, return_type
      FROM nodes ORDER BY id`,
  },
  {
    table: 'edges',
    sql: `SELECT source, target, kind, metadata, line, col, provenance
      FROM edges
      ORDER BY source, target, kind, IFNULL(line, -1), IFNULL(col, -1),
        IFNULL(provenance, ''), IFNULL(metadata, '')`,
  },
  {
    table: 'unresolved_refs',
    sql: `SELECT from_node_id, reference_name, reference_kind, line, col,
      candidates, file_path, language, status, name_tail
      FROM unresolved_refs
      ORDER BY from_node_id, reference_name, reference_kind, line, col,
        file_path, language, status, name_tail`,
  },
  {
    table: 'files',
    sql: `SELECT path, content_hash, language, size, node_count, errors
      FROM files ORDER BY path`,
  },
] as const;

/**
 * Hash semantic graph data in deterministic order. Volatile timestamps and
 * SQLite row ids are excluded so equivalent runs produce the same fingerprint.
 */
export function computeGraphFingerprint(db: SqliteDatabase): string {
  const hash = crypto.createHash('sha256');
  for (const query of FINGERPRINT_QUERIES) {
    hash.update(query.table);
    hash.update('\0');
    for (const row of db.prepare(query.sql).iterate()) {
      hash.update(JSON.stringify(row));
      hash.update('\n');
    }
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Write a profile through a sibling temporary file, then rename it into place.
 */
export function writeInitProfileAtomic(
  outputPath: string,
  profile: InitProfile,
): string {
  const resolved = path.resolve(outputPath);
  const directory = path.dirname(resolved);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  try {
    fs.writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
    });
    fs.renameSync(temporary, resolved);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the original write/rename failure.
    }
    throw error;
  }
  return resolved;
}
