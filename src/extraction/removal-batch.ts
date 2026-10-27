import type { RemovalCost } from '../db/queries';

/** Supplied by the active writer/valve, never reconstructed from environment. */
export interface RemovalBatchOptions {
  hardCapBytes: number;
  getWalSizeBytes: () => number;
}

export const REMOVAL_BATCH_LIMITS = Object.freeze({
  files: 16,
  nodes: 128,
  workRows: 512,
  payloadBytes: 128 * 1024,
  targetMs: 25,
});

/** Work admission bounds, not a byte estimate of SQLite's dirty/FTS pages. */
export function fitsRemovalBatch(cost: RemovalCost): boolean {
  return cost.nodes <= REMOVAL_BATCH_LIMITS.nodes &&
    cost.workRows <= REMOVAL_BATCH_LIMITS.workRows &&
    cost.payloadBytes <= REMOVAL_BATCH_LIMITS.payloadBytes;
}

export function addRemovalCost(left: RemovalCost, right: RemovalCost): RemovalCost {
  return { nodes: left.nodes + right.nodes, workRows: left.workRows + right.workRows,
    payloadBytes: left.payloadBytes + right.payloadBytes };
}

export function canBatchRemovals(options: RemovalBatchOptions | undefined,
  hasWriteBoundary: boolean, knownRemovals: number): options is RemovalBatchOptions {
  return hasWriteBoundary && knownRemovals > 1 && !!options &&
    Number.isFinite(options.hardCapBytes) && options.hardCapBytes >= 16 * 1024 * 1024;
}

export function removalWalThreshold(options: RemovalBatchOptions): number {
  return options.hardCapBytes - Math.min(64 * 1024 * 1024, options.hardCapBytes / 4);
}
