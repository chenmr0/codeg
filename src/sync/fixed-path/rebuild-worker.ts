import { withFixedPathOpen } from './open-context';
import { isSourceOwned, inspectLegacySourceProvenance } from '../source-ownership';
/** One process owns the candidate builder and durable publisher lease. */
import { statSync } from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CodeGraph } from '../../index';
import { DatabaseConnection, DatabaseOpenError } from '../../db';
import { beginOperation, publish } from './protocol';
import { validateAdaptiveSnapshot, adaptiveRuntimeKey, type AdaptivePlan } from '../adaptive-plan';
import { validateRebuiltDatabase } from '../rebuild-controller';
import type { SyncResult } from '../../extraction';

async function main(plan: AdaptivePlan, expectedRevision: number): Promise<void> {
  const [project, dataDirectory] = process.argv.slice(2);
  if (!project || !dataDirectory || !process.send) throw new Error('Fixed-path publisher requires IPC parent');
  const op = beginOperation({ project, dataDirectory });
  const started = performance.now();
  let consumed = false, builderClosed = true;
  try {
    if (op.record.baselineRevision !== expectedRevision) throw new Error('Database changed after planning; rebuild cancelled before construction');
    const graph = await CodeGraph.createFixedPathCandidate(project, op.record.candidate);
    let built;
    try { built = await graph.indexAll({ onProgress: progress => process.connected && process.send?.({ type: 'progress', progress }) }); }
    finally {
      try { await graph.whenIdle(); graph.close(); }
      catch (error) { builderClosed = false; throw error; }
    }
    if (!built.success || built.complete !== true) throw new Error('Fixed-path candidate index is incomplete');
    const buildMs = performance.now() - started;
    consumed = true;
    const publication = await publish(op, {
      buildMs,
      validate(file: string) { if (!validateRebuiltDatabase(file, plan.snapshot)) throw new Error('Candidate failed full index validation'); },
      async validateSource() {
        // Publisher owns the writer fence here; retain a separate real native
        // connection lease while rechecking provenance before any replacement.
        const current = withFixedPathOpen(op.p.active, () => DatabaseConnection.openReadOnly(op.p.active));
        try { if (!isSourceOwned(current.getDb()) && !inspectLegacySourceProvenance(current.getDb()).eligible) throw new Error('Active source ownership changed; publication refused'); }
        finally { current.close(); }
        if (adaptiveRuntimeKey(project, 'node-sqlite') !== plan.runtimeKey) throw new Error('Rebuild runtime fingerprint changed; old database retained');
        if (!await validateAdaptiveSnapshot(project, plan.snapshot)) {
          throw new Error('Source changed during build; old database retained');
        }
      },
      finalSourceFence() {
        for (const item of plan.snapshot.files) {
          const info = statSync(path.join(project, item.path));
          if (info.size !== item.size || info.mtimeMs !== item.mtimeMs || info.ctimeMs !== item.ctimeMs || info.ino !== item.ino) {
            throw new Error('Source changed after verification; old database retained');
          }
        }
      },
    });
    if (publication.status !== 'published') throw new Error(publication.error ?? 'Fixed-path publication cancelled');
    const durationMs = performance.now() - started + plan.planningMs;
    const result: SyncResult = {
      adaptive: { strategy: 'rebuild', reason: 'fixed-path-published', generation: publication.operation,
        planningMs: plan.planningMs, buildMs, validationAndPublishMs: durationMs - buildMs - plan.planningMs,
        publication: Object.fromEntries(Object.entries(publication.metrics).filter((entry): entry is [string, number] => typeof entry[1] === 'number')) },
      complete: true, filesChecked: plan.totalFiles + plan.removed.length,
      filesAdded: plan.added.length, filesModified: plan.modified.length, filesRemoved: plan.removed.length,
      filesErrored: 0, nodesUpdated: built.nodesCreated, durationMs,
      changedFilePaths: [...plan.added, ...plan.modified], errors: built.errors,
    };
    await new Promise<void>((resolve, reject) => process.send?.({ type: 'result', result, publication }, error => error ? reject(error) : resolve()));
  } catch (error) {
    // A failed native close is not proof that the builder has exited. Retain
    // owner + candidate evidence until this process exits; later recovery owns cleanup.
    if (!consumed && builderClosed && !(error instanceof DatabaseOpenError)) {
      consumed = true; await publish(op, { validate() { throw error; } });
    }
    throw error;
  }
}
const parentDisconnected = (): never => process.exit(1);
process.once('disconnect', parentDisconnected);
process.once('message', (message: { plan: AdaptivePlan; expectedRevision: number; parentExecArgv: string[] }) => {
  // Fingerprint the invoking supported runtime, not test-harness worker flags.
  process.execArgv = message.parentExecArgv;
  void main(message.plan, message.expectedRevision).catch(error => {
    process.exitCode = 1;
    process.send?.({ type: 'error', error: error instanceof Error ? error.stack : String(error) });
  }).finally(() => { process.removeListener('disconnect', parentDisconnected); if (process.connected) process.disconnect(); });
});
