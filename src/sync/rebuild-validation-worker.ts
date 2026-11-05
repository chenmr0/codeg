/** Heavy read-only planning/validation runs off the MCP event loop. */
import { parentPort, workerData } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import { acquireGenerationLease, acquireCurrentGenerationLease, resolveGeneration, type GenerationLease } from './generation-store';
import { DatabaseConnection, DatabaseOpenError } from '../db';
import { PortableCoordinator, type PortableLease } from './portable/protocol';
import { QueryBuilder } from '../db/queries';
import { adaptiveRuntimeKey, readAdaptiveHistory, createAdaptivePlan, chooseAdaptiveStrategy, chooseStructuralStrategy, includeAdaptiveReindexWork, scopedCandidateCounts, hasCanonicalScope,
  validateAdaptiveSnapshot, canSkipScopedAdaptivePlan, adaptiveSampleFromFiles, recordAdaptiveSample, adaptiveConfigFingerprint, type AdaptiveCostHistory, type AdaptiveEligibility, type AdaptiveSnapshot } from './adaptive-plan';
import { validateRebuiltDatabase } from './rebuild-controller';
import { isSourceOwned, inspectLegacySourceProvenance } from './source-ownership';
import { EXTRACTION_VERSION } from '../extraction/extraction-version';
import { SEMANTIC_CONFIG_KEY, SEMANTIC_REINDEX_PENDING, semanticConfigFingerprint, requiresSemanticReindex, indexConfigFingerprints } from './index-policy';

export type AdaptiveReadJob =
  | { type: 'validate-initial'; root: string; databasePath: string }
  | { type: 'record-full'; root: string; databasePath: string; durationMs: number }
  | { type: 'evaluate'; root: string; databasePath: string; eligibility: AdaptiveEligibility; paths?: string[]; portable?: boolean; fullHash?: boolean; decisionOnly?: boolean }
  | { type: 'validate'; root: string; databasePath: string; sourceDatabasePath: string; snapshot: AdaptiveSnapshot; runtimeKey: string; portable?: boolean };


// Failed native close is not permission to publish over a live SQLite handle.
const failedReaderLeases = new Set<PortableLease | GenerationLease>();
function openLeasedReadOnly(databasePath: string, portable = false): { connection: DatabaseConnection; close(): void } {
  const directory = path.dirname(databasePath);
  let lease: PortableLease | GenerationLease | undefined;
  if (path.basename(databasePath) === 'codegraph.db' &&
      (portable || fs.existsSync(path.join(directory, '.runtime', 'portable')))) {
    lease = new PortableCoordinator(directory).acquireReader();
  } else if (path.basename(path.dirname(directory)) === 'generations') {
    const dataDir = path.dirname(path.dirname(directory));
    if (resolveGeneration(dataDir).databasePath === databasePath) {
      const current = acquireCurrentGenerationLease(dataDir);
      if (current.databasePath !== databasePath) { current.release(); throw new Error('Generation changed before worker read'); }
      lease = current;
    } else lease = acquireGenerationLease(dataDir, path.basename(directory));
  }
  let connection: DatabaseConnection;
  try { connection = DatabaseConnection.openReadOnly(databasePath); }
  catch (error) {
    if (error instanceof DatabaseOpenError) { if (lease) failedReaderLeases.add(lease); }
    else lease?.release();
    throw error;
  }
  return { connection, close: () => {
    try { connection.close(); }
    finally {
      if (!connection.isOpen()) lease?.release();
      else if (lease) failedReaderLeases.add(lease);
    }
  } };
}

async function execute(job: AdaptiveReadJob): Promise<unknown> {
  if (job.type === 'validate-initial') {
    const reader = openLeasedReadOnly(job.databasePath);
    try {
      const db = reader.connection.getDb();
      return db.pragma('quick_check', { simple: true }) === 'ok' &&
        db.prepare('PRAGMA foreign_key_check').all().length === 0;
    } finally { reader.close(); }
  }
  if (job.type === 'record-full') {
    const reader = openLeasedReadOnly(job.databasePath);
    const connection = reader.connection;
    try {
      if (!isSourceOwned(connection.getDb())) return false;
      const after = new QueryBuilder(connection.getDb()).getAllFiles();
      recordAdaptiveSample(job.root, adaptiveSampleFromFiles({ kind: 'full', before: [], after,
        durationMs: job.durationMs, runtimeKey: adaptiveRuntimeKey(job.root, 'node-sqlite'),
        configFingerprint: adaptiveConfigFingerprint(job.root, after),
        semanticConfigFingerprint: semanticConfigFingerprint(job.root, after) }), true);
      return true;
    } finally { reader.close(); }
  }
  if (job.type === 'evaluate') {
    const reader = openLeasedReadOnly(job.databasePath, job.portable);
    const connection = reader.connection;
    try {
      const db = connection.getDb();
      const legacy = !job.portable && !isSourceOwned(db) ? inspectLegacySourceProvenance(db) : undefined;
      const provenanceBlocked = legacy && !legacy.eligible ? `unverified-legacy-or-custom-index:${legacy.reason}` : undefined;
      // Catch-up still needs a complete content inventory, even if its source
      // lost rebuild eligibility. Computing a plan must not grant ownership.
      if (provenanceBlocked && !job.fullHash) return { decision: { strategy: 'incremental', reason: provenanceBlocked } };
      // Only the publisher carries a runtime fingerprint into final validation.
      const runtimeKey = job.portable && (job.decisionOnly || job.fullHash) ? '' : adaptiveRuntimeKey(job.root, connection.getBackend());
      const queries = new QueryBuilder(db);
      const tracked = queries.getAllFiles();
      const indexedConfig = queries.getMetadata('adaptive:index-config-v1');
      const indexedSemantic = queries.getMetadata(SEMANTIC_CONFIG_KEY);
      const semanticPending = queries.getMetadata(SEMANTIC_REINDEX_PENDING) !== null;
      const indexedVersion = queries.getMetadata('indexed_with_extraction_version');
      const upgradeRequired = job.eligibility.upgradeRequired === true ||
        (queries.getLastIndexedAt() !== null && (indexedVersion === null || !Number.isFinite(Number(indexedVersion)) || Number(indexedVersion) < EXTRACTION_VERSION));
      const eligibility = { ...job.eligibility, ...(indexedConfig ? { configFingerprint: indexedConfig } : {}),
        ...(provenanceBlocked ? { blockedReason: provenanceBlocked } : {}),
        upgradeRequired };
      let history: AdaptiveCostHistory = { version: 1, samples: [] };
      if (!job.portable) history = readAdaptiveHistory(job.root);
      if (!job.portable && !job.fullHash && job.paths?.length && indexedConfig && !eligibility.upgradeRequired && !eligibility.configurationChanged) {
        const paths = [...new Set(job.paths)];
        const prior = new Map(tracked.map(file => [file.path, file]));
        const { configFingerprint: currentConfig, semanticConfigFingerprint: currentSemantic } =
          indexConfigFingerprints(job.root, [...tracked, ...paths.map(path => ({ path }))]);
        if (currentConfig === indexedConfig &&
          !requiresSemanticReindex(indexedSemantic, currentSemantic, indexedConfig, currentConfig, upgradeRequired, semanticPending) &&
          canSkipScopedAdaptivePlan(scopedCandidateCounts(paths, prior), history, runtimeKey, currentConfig, eligibility) &&
          await hasCanonicalScope(job.root, paths, prior)) {
          return { decision: { strategy: 'incremental', reason: 'scoped-small-change' } };
        }
      }
      let plan = await createAdaptivePlan(job.root, tracked, { runtimeKey, fullHash: job.fullHash });
      const semantic = plan.snapshot.semanticConfigFingerprint!;
      if (requiresSemanticReindex(indexedSemantic, semantic, indexedConfig,
        plan.snapshot.configFingerprint, upgradeRequired, semanticPending)) {
        plan = includeAdaptiveReindexWork(plan, tracked, tracked.map(file => file.path));
        // Re-extraction is a different workload from historical content-only sync.
        // In particular, legacy broad fingerprints omit some semantic controls.
        history = { version: 1, samples: [] };
      }
      const decision = job.portable ? chooseStructuralStrategy(plan, eligibility) : chooseAdaptiveStrategy(plan, history, eligibility);
      if (job.decisionOnly) return { decision };
      const configurationChanged = eligibility.configurationChanged === true ||
        (indexedConfig !== undefined && indexedConfig !== null && indexedConfig !== plan.snapshot.configFingerprint);
      return { plan, decision, legacy: legacy?.eligible ?? false, configurationChanged };
    } finally { reader.close(); }
  }
  if (adaptiveRuntimeKey(job.root, 'node-sqlite') !== job.runtimeKey) return false;
  const candidate = openLeasedReadOnly(job.databasePath);
  try { if (!validateRebuiltDatabase(job.databasePath, job.snapshot, job.portable)) return false; }
  finally { candidate.close(); }
  if (!job.portable) {
    const source = openLeasedReadOnly(job.sourceDatabasePath);
    try {
      if (!isSourceOwned(source.connection.getDb()) && !inspectLegacySourceProvenance(source.connection.getDb()).eligible) return false;
    } finally { source.close(); }
  }
  return await validateAdaptiveSnapshot(job.root, job.snapshot) &&
    adaptiveRuntimeKey(job.root, 'node-sqlite') === job.runtimeKey;
}

if (!parentPort) throw new Error('Adaptive validation requires a worker parent');
// Fingerprint the invoking engine runtime, not worker-specific loader defaults.
process.execArgv = workerData.parentExecArgv;
void execute(workerData.job as AdaptiveReadJob).then(result => {
  parentPort!.postMessage({ result }); parentPort!.close();
}, error => {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  parentPort!.close();
});
