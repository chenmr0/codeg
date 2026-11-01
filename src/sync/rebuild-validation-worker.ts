/** Heavy read-only planning/validation runs off the MCP event loop. */
import { parentPort, workerData } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import { acquireGenerationLease, acquireCurrentGenerationLease, resolveGeneration, type GenerationLease } from './generation-store';
import { DatabaseConnection, DatabaseOpenError } from '../db';
import { PortableCoordinator, type PortableLease } from './portable/protocol';
import { QueryBuilder } from '../db/queries';
import { adaptiveRuntimeKey, readAdaptiveHistory, createAdaptivePlan, chooseAdaptiveStrategy,
  validateAdaptiveSnapshot, canSkipScopedAdaptivePlan, adaptiveSampleFromFiles, recordAdaptiveSample, adaptiveConfigFingerprint, type AdaptiveCostHistory, type AdaptiveEligibility, type AdaptiveSnapshot } from './adaptive-plan';
import { validateRebuiltDatabase } from './rebuild-controller';
import { isSourceOwned, inspectLegacySourceProvenance } from './source-ownership';

export type AdaptiveReadJob =
  | { type: 'validate-initial'; root: string; databasePath: string }
  | { type: 'record-full'; root: string; databasePath: string; durationMs: number }
  | { type: 'evaluate'; root: string; databasePath: string; eligibility: AdaptiveEligibility; paths?: string[]; portable?: boolean; fullHash?: boolean }
  | { type: 'validate'; root: string; databasePath: string; sourceDatabasePath: string; snapshot: AdaptiveSnapshot; runtimeKey: string };


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
        configFingerprint: adaptiveConfigFingerprint(job.root, after) }), true);
      return true;
    } finally { reader.close(); }
  }
  if (job.type === 'evaluate') {
    const reader = openLeasedReadOnly(job.databasePath, job.portable);
    const connection = reader.connection;
    try {
      const db = connection.getDb();
      const owned = isSourceOwned(db);
      const legacy = owned ? { eligible: false, reason: 'already-owned' } : inspectLegacySourceProvenance(db);
      const provenanceBlocked = !owned && !legacy.eligible ? `unverified-legacy-or-custom-index:${legacy.reason}` : undefined;
      // Catch-up still needs a complete content inventory, even if its source
      // lost rebuild eligibility. Computing a plan must not grant ownership.
      if (provenanceBlocked && !job.fullHash) return { decision: { strategy: 'incremental', reason: provenanceBlocked } };
      const runtimeKey = adaptiveRuntimeKey(job.root, connection.getBackend());
      const queries = new QueryBuilder(db);
      const tracked = queries.getAllFiles();
      const indexedConfig = queries.getMetadata('adaptive:index-config-v1');
      const eligibility = { ...job.eligibility, ...(indexedConfig ? { configFingerprint: indexedConfig } : {}),
        ...(provenanceBlocked ? { blockedReason: provenanceBlocked } : {}),
        upgradeRequired: job.eligibility.upgradeRequired || legacy.eligible || (owned && indexedConfig === null) };
      let history: AdaptiveCostHistory = { version: 1, samples: [] };
      if (job.portable) {
        // The DB is the portable authority. Do not accidentally revive an old
        // directory's JSON history after a public database was replaced.
        const raw = queries.getMetadata('adaptive:cost-history-v1');
        try {
          if (raw && raw.length <= 256 * 1024) {
            const parsed = JSON.parse(raw) as AdaptiveCostHistory;
            if (parsed?.version === 1 && Array.isArray(parsed.samples)) {
              // A copied DB may carry another machine's measurements. Ignore
              // them rather than triggering a rebuild because its host changed.
              history = { version: 1, samples: parsed.samples.slice(-96).filter(sample =>
                sample && typeof sample === 'object' && sample.runtimeKey === runtimeKey) };
            }
          }
        } catch { /* Corrupt cost hints cannot invalidate an otherwise valid index. */ }
      } else history = readAdaptiveHistory(job.root);
      if (!job.fullHash && job.paths?.length && indexedConfig && !eligibility.upgradeRequired && !eligibility.configurationChanged) {
        const paths = [...new Set(job.paths)];
        const prior = new Map(tracked.map(file => [file.path, file]));
        const safe = paths.every(relative => {
          const absolute = path.resolve(job.root, relative);
          if (!absolute.startsWith(path.resolve(job.root) + path.sep) || path.isAbsolute(relative)) return false;
          try { return fs.realpathSync(absolute) === absolute && fs.statSync(absolute).isFile(); }
          catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' && prior.has(relative); }
        });
        const currentConfig = adaptiveConfigFingerprint(job.root, [...tracked, ...paths.map(path => ({ path }))]);
        if (safe && currentConfig === indexedConfig && canSkipScopedAdaptivePlan({ pathsCount: paths.length,
          affectedOldNodes: paths.reduce((total, relative) => total + (prior.get(relative)?.nodeCount ?? 0), 0),
          totalOldNodes: tracked.reduce((total, file) => total + file.nodeCount, 0),
        }, history, runtimeKey, currentConfig, eligibility)) {
          return { decision: { strategy: 'incremental', reason: 'scoped-small-change' } };
        }
      }
      const plan = await createAdaptivePlan(job.root, tracked, { runtimeKey, fullHash: job.fullHash });
      const decision = chooseAdaptiveStrategy(plan, history, eligibility);
      const configurationChanged = eligibility.configurationChanged === true ||
        (indexedConfig !== undefined && indexedConfig !== null && indexedConfig !== plan.snapshot.configFingerprint);
      return { plan, decision, legacy: legacy.eligible, configurationChanged };
    } finally { reader.close(); }
  }
  if (adaptiveRuntimeKey(job.root, 'node-sqlite') !== job.runtimeKey) return false;
  const candidate = openLeasedReadOnly(job.databasePath);
  try { if (!validateRebuiltDatabase(job.databasePath, job.snapshot)) return false; }
  finally { candidate.close(); }
  const source = openLeasedReadOnly(job.sourceDatabasePath);
  try {
    if (!isSourceOwned(source.connection.getDb()) && !inspectLegacySourceProvenance(source.connection.getDb()).eligible) return false;
  } finally { source.close(); }
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
