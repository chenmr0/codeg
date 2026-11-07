import type { CodeGraph, SyncOptions } from '../index';
import type { SyncResult } from '../extraction';
import type { AdaptivePlan } from './adaptive-plan';
import { runAdaptiveReadWorker } from './rebuild-controller';
import { resolvedSyncPolicy } from './sync-policy';
import type { ParserMacroContext } from '../extraction/macro-scan';

export const publicationContext = Symbol('publicationContext');
export interface VerifiedPublicationContext {
  macros?: { context: ParserMacroContext; fingerprint: string; changed: boolean };
  frameworks?: { names: string[]; changed: boolean };
}

/** The caller holds the writer lease for this published DB through verification and marker removal. */
export async function reconcilePublishedSource(graph: CodeGraph, options: SyncOptions,
  sync: (options: SyncOptions) => Promise<SyncResult>, published?: SyncResult): Promise<SyncResult> {
  let result = published;
  const started = performance.now();
  while (true) {
    options.signal?.throwIfAborted();
    const upgradeRequired = graph.isIndexStale();
    const repairPending = upgradeRequired || graph.getIndexCompleteness().status !== 'complete' || graph.hasPortableCatchupWork();
    const { plan, configurationChanged, macros, frameworks } = await runAdaptiveReadWorker<{
      plan: AdaptivePlan; configurationChanged: boolean;
    } & VerifiedPublicationContext>({
      type: 'evaluate', root: graph.getProjectRoot(), databasePath: graph.getDatabaseFilePath(),
      portable: graph.isPortableStorage(), fullHash: true, repairPending, policy: options[resolvedSyncPolicy],
      eligibility: { upgradeRequired },
    }, { signal: options.signal });
    options.signal?.throwIfAborted();
    if (!plan) throw new Error('Pending source reconciliation could not inspect the complete source inventory');
    if (plan.changedFiles === 0 && !configurationChanged && !macros?.changed && !frameworks?.changed && !repairPending) {
      graph.clearPortableCatchup();
      return result ?? { complete: true, filesChecked: plan.totalFiles, filesAdded: 0, filesModified: 0,
        filesRemoved: 0, nodesUpdated: 0, durationMs: performance.now() - started };
    }
    const pass = await sync({ ...options, adaptive: false, paths: undefined, forceReindexPaths: plan.modified,
      [publicationContext]: { macros, frameworks } });
    if (pass.complete !== true) throw new Error('Post-publication source reconciliation incomplete; pending marker retained');
    // Files may occur in both the initial plan and later passes. Report the last completed
    // pass while retaining the strategy that published this database.
    result = { ...pass, adaptive: published?.adaptive ?? pass.adaptive };
  }
}
