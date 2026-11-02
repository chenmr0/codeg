/**
 * Allocation policy informed by upstream CodeGraph v1.6.2, commit
 * 6560052a6f856855d3f71eee838fd66ccfa4285d (src/mcp/tools.ts).
 * Local implementation prices complete sections, bounds actual source demand,
 * and reclaims saturated shares by water filling under a hard total envelope.
 */

/** Ranked files competing for the source portion of an explore response. */
export interface ExploreAllocationCandidate {
  path: string;
  score: number;
  worth: number;
  spine: boolean;
  named?: boolean;
  pinned?: boolean;
  protected?: boolean;
  /** Proven graph adjacency; preserves admission without promoting a query target. */
  graphEvidence?: boolean;
  /** Cost of the complete section, including its header and fences. */
  demandChars: number;
  /** Optional useful first unit, in the same complete-section cost model. */
  minimumChars?: number;
}

export interface ExploreAllocation {
  allowances: Map<string, number>;
  rejected: string[];
  pool: number;
  reserved: number;
}

const boundedInt = (value: number): number => Number.isFinite(value)
  ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;
const protectedFile = (candidate: ExploreAllocationCandidate): boolean =>
  !!(candidate.spine || candidate.named || candidate.pinned || candidate.protected);

/**
 * Reserve first, then divide the remainder by evidence weight. Unlike a single
 * proportional split, bounded water filling gives unused demand back to the
 * other files. The caller has already removed prefix/ledger costs from `pool`;
 * every allowance is an actual section budget, with no hidden fixed overhead.
 * Input order is final rank order and is also the deterministic tie breaker.
 */
export function allocateExploreFiles(
  candidates: readonly ExploreAllocationCandidate[], pool: number, maxFiles: number,
): ExploreAllocation {
  const capacity = boundedInt(pool);
  const limit = boundedInt(maxFiles);
  const allowances = new Map<string, number>();
  const rejected: string[] = [];
  const seen = new Set<string>();
  const unique = candidates.filter(candidate => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
  if (!capacity || !limit) {
    return { allowances, rejected: unique.map(candidate => candidate.path), pool: capacity, reserved: 0 };
  }
  const rawWeights = unique.map(candidate => {
    if (!boundedInt(candidate.demandChars)) return 0;
    const weight = Math.max(0, candidate.score) * Math.max(0, Math.min(1, candidate.worth))
      * (candidate.spine ? 2 : 1);
    return Number.isFinite(weight) ? weight : 0;
  });
  const top = rawWeights.reduce((highest, weight) => Math.max(highest, weight), 0);
  // Match upstream's absolute relevance floor: one exceptionally large anchor
  // score must not turn every useful ordinary source file into a weak match.
  const cliffAt = Math.min(10, top * 0.15);
  const rows = unique.map((candidate, index) => {
    // An explicit source target can have no lexical score (pure file/range
    // queries). It must still receive a useful share of its reserved section.
    const weight = candidate.pinned || candidate.protected
      ? Math.max(rawWeights[index]!, top, 1) : rawWeights[index]!;
    const demand = Math.min(capacity, boundedInt(candidate.demandChars));
    const cap = protectedFile(candidate) ? demand : Math.min(demand, Math.floor(capacity * 0.7));
    return { candidate, index, weight, cap,
      minimum: Math.min(cap, Math.max(700, boundedInt(candidate.minimumChars ?? 0))), value: 0 };
  });
  const admitted: typeof rows = [];
  for (const row of rows) {
    if (row.cap === 0 || (!protectedFile(row.candidate) && !row.candidate.graphEvidence
        && top > 0 && row.weight < cliffAt)
        || admitted.length >= limit) rejected.push(row.candidate.path);
    else admitted.push(row);
  }
  if (!admitted.length) return { allowances, rejected, pool: capacity, reserved: 0 };

  let remaining = capacity;
  /** Integer water fill; saturated files release their unused proportional share. */
  const fill = (ceiling: (row: typeof rows[number]) => number, weightOf: (row: typeof rows[number]) => number): void => {
    while (remaining > 0) {
      const active = admitted.filter(row => row.value < ceiling(row));
      if (!active.length) break;
      const largest = active.reduce((value, row) => Math.max(value, weightOf(row)), 0);
      // Normalize before summing, avoiding overflow for finite but large scores.
      const weights = active.map(row => largest > 0 ? weightOf(row) / largest : 1);
      const total = weights.reduce((sum, value) => sum + value, 0);
      const round = remaining;
      const fractions: Array<{ row: typeof rows[number]; fraction: number }> = [];
      let granted = 0;
      for (let index = 0; index < active.length; index++) {
        const row = active[index]!;
        const exact = round * (weights[index]! / total);
        const share = Math.min(remaining, ceiling(row) - row.value, Math.floor(exact));
        row.value += share;
        remaining -= share;
        granted += share;
        if (row.value < ceiling(row)) fractions.push({ row, fraction: exact - Math.floor(exact) });
      }
      // Largest remainder removes rounding losses, always bounded by actual room.
      fractions.sort((a, b) => b.fraction - a.fraction || a.row.index - b.row.index);
      for (const { row } of fractions) {
        if (!remaining) break;
        row.value++;
        remaining--;
        granted++;
      }
      if (!granted) break;
    }
  };
  const minimumTotal = admitted.reduce((sum, row) => sum + row.minimum, 0);
  if (minimumTotal <= capacity) {
    for (const row of admitted) { row.value = row.minimum; remaining -= row.minimum; }
  } else {
    // Even protected targets cannot manufacture budget. A short envelope shares
    // the available floor proportionally rather than exceeding the hard cap.
    fill(row => row.minimum, row => row.minimum);
  }
  fill(row => row.cap, row => row.weight);
  for (const row of admitted) allowances.set(row.candidate.path, row.value);
  return { allowances, rejected, pool: capacity, reserved: capacity - remaining };
}
