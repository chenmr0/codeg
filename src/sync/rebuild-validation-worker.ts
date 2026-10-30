import { Participant } from './fixed-path/protocol';
import { withFixedPathOpen } from './fixed-path/open-context';
/** Heavy read-only planning/validation runs off the MCP event loop. */
import { parentPort, workerData } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import { acquireGenerationLease, acquireCurrentGenerationLease, resolveGeneration, type GenerationLease } from './generation-store';
import { DatabaseConnection } from '../db';
import { QueryBuilder } from '../db/queries';
import { adaptiveRuntimeKey, readAdaptiveHistory, createAdaptivePlan, chooseAdaptiveStrategy,
  validateAdaptiveSnapshot, canSkipScopedAdaptivePlan, adaptiveSampleFromFiles, recordAdaptiveSample, adaptiveConfigFingerprint, type AdaptiveEligibility, type AdaptiveSnapshot } from './adaptive-plan';
import { validateRebuiltDatabase } from './rebuild-controller';
import { isSourceOwned, inspectLegacySourceProvenance } from './source-ownership';
import { readFixedPathCatchup } from './fixed-path/catchup';

export type AdaptiveReadJob =
  | { type: 'validate-initial'; root: string; databasePath: string }
  | { type: 'record-full'; root: string; databasePath: string; durationMs: number }
  | { type: 'evaluate'; root: string; databasePath: string; eligibility: AdaptiveEligibility; paths?: string[]; fullHash?: boolean }
  | { type: 'validate'; root: string; databasePath: string; sourceDatabasePath: string; snapshot: AdaptiveSnapshot; runtimeKey: string };


function openLeasedReadOnly(databasePath: string): { connection: DatabaseConnection; close(): void } {
  const directory = path.dirname(databasePath);
  if (path.basename(databasePath) === 'codegraph.db' && fs.existsSync(path.join(directory, '.runtime', 'layout.json'))) {
    const participant = new Participant({ project: path.dirname(directory), dataDirectory: directory },
      (file: string) => withFixedPathOpen(file, () => DatabaseConnection.openReadOnly(file)));
    try {
      const connection = participant.requestSync((handle: DatabaseConnection) => { participant.active++; return handle; }) as DatabaseConnection;
      let closed = false;
      return { connection, close() { if (closed) return; closed = true; participant.finish(); participant.close(); } };
    } catch (error) { participant.close(); throw error; }
  }
  let lease: GenerationLease | undefined;
  if (path.basename(path.dirname(directory)) === 'generations') {
    const dataDir = path.dirname(path.dirname(directory));
    if (resolveGeneration(dataDir).databasePath === databasePath) {
      lease = acquireCurrentGenerationLease(dataDir);
      if (lease.databasePath !== databasePath) { lease.release(); throw new Error('Generation changed before worker read'); }
    } else lease = acquireGenerationLease(dataDir, path.basename(directory));
  }
  let connection: DatabaseConnection;
  try { connection = DatabaseConnection.openReadOnly(databasePath); }
  catch (error) { lease?.release(); throw error; }
  return { connection, close: () => {
    try { connection.close(); } finally { if (!connection.isOpen()) lease?.release(); }
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
    const reader = openLeasedReadOnly(job.databasePath);
    const connection = reader.connection;
    try {
      const db = connection.getDb();
      const owned = isSourceOwned(db);
      const legacy = owned ? { eligible: false, reason: 'already-owned' } : inspectLegacySourceProvenance(db);
      const catchup = job.fullHash && readFixedPathCatchup(db) !== null;
      if (!owned && !legacy.eligible && !catchup) return { decision: { strategy: 'incremental', reason: `unverified-legacy-or-custom-index:${legacy.reason}` } };
      const runtimeKey = adaptiveRuntimeKey(job.root, connection.getBackend());
      const queries = new QueryBuilder(db);
      const tracked = queries.getAllFiles();
      const indexedConfig = queries.getMetadata('adaptive:index-config-v1');
      const eligibility = { ...job.eligibility, ...(indexedConfig ? { configFingerprint: indexedConfig } : {}),
        upgradeRequired: job.eligibility.upgradeRequired || legacy.eligible || (owned && indexedConfig === null) };
      const fixed = fs.existsSync(path.join(path.dirname(job.databasePath), '.runtime', 'layout.json'));
      const history = fixed ? { version: 1 as const, samples: [] } : readAdaptiveHistory(job.root);
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
      // An interrupted incremental write may invalidate ownership. The durable
      // obligation still requires a full scan, but NEVER authorizes replacement
      // or re-adoption of that graph as an automatically rebuildable source.
      const decision = !owned && !legacy.eligible
        ? { strategy: 'incremental' as const, reason: 'pending-fixed-path-catchup' }
        : chooseAdaptiveStrategy(plan, history, eligibility);
      return { plan, decision, legacy: legacy.eligible,
        configurationChanged: indexedConfig !== plan.snapshot.configFingerprint };
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
