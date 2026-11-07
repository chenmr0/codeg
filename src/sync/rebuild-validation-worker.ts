/** Heavy read-only planning/validation runs off the MCP event loop. */
import { parentPort, workerData } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import { acquireGenerationLease, acquireCurrentGenerationLease, resolveGeneration, type GenerationLease } from './generation-store';
import { DatabaseConnection, DatabaseOpenError } from '../db';
import { PortableCoordinator, type PortableLease } from './portable/protocol';
import { QueryBuilder } from '../db/queries';
import { adaptiveRuntimeKey, createAdaptivePlan, chooseStructuralStrategy, includeAdaptiveReindexWork, scopedCandidateCounts, hasCanonicalScope,
  canSkipScopedAdaptivePlan, type AdaptiveEligibility } from './adaptive-plan';
import type { ResolvedSyncPolicy } from './sync-policy';
import { validateRebuiltDatabase } from './rebuild-controller';
import { isSourceOwned, inspectLegacySourceProvenance } from './source-ownership';
import { EXTRACTION_VERSION } from '../extraction/extraction-version';
import { SEMANTIC_CONFIG_KEY, SEMANTIC_REINDEX_PENDING, requiresSemanticReindex, indexConfigFingerprints } from './index-policy';
import { PUBLICATION_MACROS, PUBLICATION_FRAMEWORKS } from './portable/metadata';
import { ExtractionOrchestrator } from '../extraction';
import { isMacroSource, MacroContextBuilder, macroContextFingerprint, scanMacroContribution } from '../extraction/macro-scan';

export type AdaptiveReadJob =
  | { type: 'validate-initial'; root: string; databasePath: string }
  | { type: 'evaluate'; root: string; databasePath: string; eligibility: AdaptiveEligibility; policy?: ResolvedSyncPolicy; paths?: string[]; portable?: boolean; fullHash?: boolean; repairPending?: boolean; decisionOnly?: boolean }
  | { type: 'validate'; root: string; databasePath: string; sourceDatabasePath: string; runtimeKey: string; portable?: boolean };


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
      const queries = new QueryBuilder(db);
      const tracked = queries.getAllFiles();
      const indexedConfig = queries.getMetadata('adaptive:index-config-v1');
      const indexedSemantic = queries.getMetadata(SEMANTIC_CONFIG_KEY);
      const semanticPending = queries.getMetadata(SEMANTIC_REINDEX_PENDING) !== null;
      const indexedVersion = queries.getMetadata('indexed_with_extraction_version');
      const upgradeRequired = job.eligibility.upgradeRequired === true ||
        (tracked.length > 0 && (indexedVersion === null || !Number.isFinite(Number(indexedVersion)) || Number(indexedVersion) < EXTRACTION_VERSION));
      // Callers pass the immutable policy captured by the public sync entry.
      // A missing policy supports older internal jobs using their explicit eligibility.
      const eligibility = { ...job.eligibility,
        ...(job.policy ? { enabled: job.policy.enabled, fallback: job.policy.thresholds,
          rules: job.policy.rules, disabledReason: job.policy.disabledReason } : {}),
        ...(indexedConfig ? { configFingerprint: indexedConfig } : {}),
        ...(provenanceBlocked ? { blockedReason: provenanceBlocked } : {}),
        upgradeRequired };
      if (!job.portable && !job.fullHash && job.paths?.length && indexedConfig && !eligibility.upgradeRequired && !eligibility.configurationChanged) {
        const paths = [...new Set(job.paths)];
        const prior = new Map(tracked.map(file => [file.path, file]));
        const { configFingerprint: currentConfig, semanticConfigFingerprint: currentSemantic } =
          indexConfigFingerprints(job.root, [...tracked, ...paths.map(path => ({ path }))]);
        if (currentConfig === indexedConfig &&
          !requiresSemanticReindex(indexedSemantic, currentSemantic, indexedConfig, currentConfig, upgradeRequired, semanticPending) &&
          canSkipScopedAdaptivePlan(scopedCandidateCounts(paths, prior), eligibility) &&
          await hasCanonicalScope(job.root, paths, prior)) {
          return { decision: { strategy: 'incremental', reason: 'scoped-small-change' } };
        }
      }
      const indexedMacros = job.fullHash ? queries.getMetadata(PUBLICATION_MACROS) : null;
      const macroBuilder = indexedMacros === null ? null : new MacroContextBuilder();
      let plan = await createAdaptivePlan(job.root, tracked, { runtimeKey: '', fullHash: job.fullHash,
        observeContent: macroBuilder ? (relative, content) => {
          if (isMacroSource(relative) && /#\s*define\b/.test(content)) macroBuilder.add(scanMacroContribution(content));
        } : undefined,
      });
      const semantic = plan.snapshot.semanticConfigFingerprint;
      const reextract = requiresSemanticReindex(indexedSemantic, semantic, indexedConfig,
        plan.snapshot.configFingerprint, upgradeRequired, semanticPending);
      if (reextract) {
        plan = includeAdaptiveReindexWork(plan, tracked, tracked.map(file => file.path));
      }
      const decision = chooseStructuralStrategy(plan, eligibility);
      if (job.decisionOnly) return { decision };
      // Only a candidate publication needs an implementation/runtime identity.
      // Keep this validation cost out of incremental plans and catch-up scans.
      if (decision.strategy === 'rebuild' && !job.fullHash) {
        const started = performance.now();
        plan.runtimeKey = adaptiveRuntimeKey(job.root, connection.getBackend());
        plan.planningMs += performance.now() - started;
      }
      const configurationChanged = eligibility.configurationChanged === true ||
        (job.fullHash && reextract) ||
        ((job.fullHash || indexedConfig != null) && indexedConfig !== plan.snapshot.configFingerprint);
      const indexedFrameworks = job.fullHash ? queries.getMetadata(PUBLICATION_FRAMEWORKS) : null;
      let frameworks: { names: string[]; changed: boolean } | undefined;
      if (indexedFrameworks !== null) {
        const names = ExtractionOrchestrator.detectProjectFrameworks(job.root, plan.snapshot.files.map(file => file.path),
          (framework, error) => { throw new Error(`Verification of framework '${framework}' failed: ${error}`); });
        frameworks = { names, changed: JSON.stringify(names) !== indexedFrameworks };
      }
      if (macroBuilder) {
        const context = macroBuilder.finish();
        const fingerprint = macroContextFingerprint(context);
        const changed = fingerprint !== indexedMacros;
        if (changed || frameworks?.changed || configurationChanged || plan.changedFiles || job.repairPending) {
          // The writer uses the exact context checked against this inventory. A clean pass
          // returns no macro data across the worker boundary.
          return { plan, decision, configurationChanged, frameworks, macros: { context, fingerprint, changed } };
        }
      }
      return { plan, decision, legacy: legacy?.eligible ?? false, configurationChanged, frameworks };
    } finally { reader.close(); }
  }
  if (adaptiveRuntimeKey(job.root, 'node-sqlite') !== job.runtimeKey) return false;
  const candidate = openLeasedReadOnly(job.databasePath);
  const candidateId = path.basename(path.dirname(job.databasePath));
  try { if (!validateRebuiltDatabase(candidate.connection.getDb(), candidateId, job.portable)) return false; }
  finally { candidate.close(); }
  if (!job.portable) {
    const source = openLeasedReadOnly(job.sourceDatabasePath);
    try {
      if (!isSourceOwned(source.connection.getDb()) && !inspectLegacySourceProvenance(source.connection.getDb()).eligible) return false;
    } finally { source.close(); }
  }
  return adaptiveRuntimeKey(job.root, 'node-sqlite') === job.runtimeKey;
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
