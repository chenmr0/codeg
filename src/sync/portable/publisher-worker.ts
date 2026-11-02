/** Publisher and builder share one process and one OS writer lease. */
import { CodeGraph } from "../../index";
import { statSync } from "node:fs";
import { hasRebuildDiskSpace } from "../generation-store";
import { PortableCoordinator, PortableBusyError, type PortableLease } from "./protocol";
// Native lock handles must outlive main(), including asynchronous error IPC.
const processLeases = new Set<PortableLease>();
import { runAdaptiveReadWorker } from "../rebuild-controller";
import type {
  AdaptivePlan,
  AdaptiveDecision,
  AdaptiveFallbackPolicy,
} from "../adaptive-plan";
import type { SyncResult } from "../../extraction";
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function main(
  fallback: Partial<AdaptiveFallbackPolicy> | undefined,
): Promise<void> {
  const [root, dataDir] = process.argv.slice(2);
  if (!root || !dataDir || !process.send)
    throw new Error("Publisher requires root, data directory and IPC");
  const coordinator = new PortableCoordinator(dataDir);
  let writer;
  const deadline = performance.now() + 30 * 60 * 1000;
  while (!writer) {
    try {
      writer = coordinator.acquireWriter();
      processLeases.add(writer);
    } catch (error) {
      if (
        !(error instanceof PortableBusyError) ||
        performance.now() >= deadline
      )
        throw error;
      await delay(20);
    }
  }
  let candidate;
  const started = performance.now();
  try {
    coordinator.recover();
    const read = coordinator.acquireReader();
    let evaluation: { plan?: AdaptivePlan; decision: AdaptiveDecision };
    let history: string | null = null;
    const current = CodeGraph.openPortableRaw(root, coordinator.active, true);
    try {
      history = current.getPortableCostHistory();
      evaluation = await runAdaptiveReadWorker({
        type: "evaluate",
        root,
        databasePath: coordinator.active,
        portable: true,
        eligibility: { fallback, upgradeRequired: current.isIndexStale() },
      } as any);
    } finally {
      current.close();
      await current.whenIdle();
      read.release();
    }
    const plan = evaluation.plan;
    if (!plan || evaluation.decision.strategy !== "rebuild")
      throw new Error("Source changed before rebuild admission; retry sync");
    // Admission must be rechecked by the writer-owning publisher, not only
    // by the parent. Unknown capacity is not permission to build a large DB.
    const requiredBytes = Math.ceil(Math.max(
      statSync(coordinator.active).size * 4,
      plan.totalBytes * 16,
      256 * 1024 * 1024,
    ));
    if (!hasRebuildDiskSpace(dataDir, requiredBytes))
      throw new Error("insufficient-or-unknown-free-disk");
    candidate = coordinator.beginCandidate();
    const graph = await CodeGraph.createPortableCandidate(root, candidate.path);
    let built;
    try {
      built = await graph.indexAll({
        onProgress: (progress) => {
          if (process.connected) process.send?.({ type: "progress", progress });
        },
      });
      if (!built.success || built.complete !== true)
        throw new Error("Candidate indexing incomplete; old database retained");
      if (history) graph.setPortableCostHistory(history);
      graph.setPortableCatchup(candidate.id);
    } finally {
      graph.close();
      await graph.whenIdle();
    }
    const buildMs = performance.now() - started;
    const valid = await runAdaptiveReadWorker<boolean>({
      type: "validate",
      root,
      databasePath: candidate.path,
      sourceDatabasePath: coordinator.active,
      snapshot: plan.snapshot,
      runtimeKey: plan.runtimeKey,
    });
    if (!valid)
      throw new Error(
        "Source or configuration changed during candidate construction; old database retained",
      );
    const publication = await coordinator.publish(candidate);
    const result: SyncResult = {
      complete: true,
      filesChecked: plan.totalFiles + plan.removed.length,
      filesAdded: plan.added.length,
      filesModified: plan.modified.length,
      filesRemoved: plan.removed.length,
      filesErrored: 0,
      nodesUpdated: built.nodesCreated,
      durationMs: performance.now() - started,
      changedFilePaths: [...plan.added, ...plan.modified],
      errors: built.errors,
      adaptive: {
        strategy: "rebuild",
        reason: evaluation.decision.reason,
        pauseMs: publication.pauseMs,
        generation: candidate.id,
        planningMs: plan.planningMs,
        buildMs,
        validationAndPublishMs: performance.now() - started - buildMs,
      },
    };
    await new Promise<void>((resolve, reject) =>
      process.send?.({ type: "result", result }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  } catch (error) {
    if (candidate) {
      try {
        coordinator.abortCandidate(candidate);
      } catch {
        /* recovery retains uncertain publication */
      }
    }
    throw error;
  } finally {
    // The child owns the writer lease for its entire lifetime. Retain it until
    // process exit, including native-close failure paths; OS teardown closes
    // every database handle before another publisher may acquire the lock.
    // processLeases remains strongly reachable until the explicit process.exit.
  }
}
const parentDisconnected = () => process.exit(1);
process.once("disconnect", parentDisconnected);
process.once(
  "message",
  (message: {
    fallback?: Partial<AdaptiveFallbackPolicy>;
    parentExecArgv: string[];
  }) => {
    process.execArgv = message.parentExecArgv;
    void main(message.fallback)
      .catch(async (error) => {
        process.exitCode = 1;
        await new Promise<void>((resolve) => {
          if (!process.connected) return resolve();
          process.send?.(
            {
              type: "error",
              error: error instanceof Error ? error.stack : String(error),
            },
            () => resolve(),
          );
        });
      })
      .finally(() => {
        process.removeListener("disconnect", parentDisconnected);
        if (process.connected) process.disconnect();
        process.exit(process.exitCode ?? 0);
      });
  },
);
