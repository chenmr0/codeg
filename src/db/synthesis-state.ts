/** Durable obligation created when replacement rewiring resurrects references.
 * Existence, including an unknown value, requires conservative full synthesis.
 * Base-reference resolution alone must never acknowledge this obligation.
 */
export const REWIRE_SYNTHESIS_PENDING = 'index_rewire_synthesis_pending';
