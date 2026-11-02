import { describe, expect, it } from 'vitest';
import { allocateExploreFiles, type ExploreAllocationCandidate } from '../src/mcp/explore-allocation';

const file = (path: string, patch: Partial<ExploreAllocationCandidate> = {}): ExploreAllocationCandidate => ({
  path, score: 1, worth: 1, spine: false, demandChars: 10000, ...patch,
});
const values = (result: ReturnType<typeof allocateExploreFiles>): number[] => [...result.allowances.values()];
const sane = (result: ReturnType<typeof allocateExploreFiles>): void => {
  expect(values(result).every(value => Number.isSafeInteger(value) && value >= 0)).toBe(true);
  expect(values(result).reduce((sum, value) => sum + value, 0)).toBe(result.reserved);
  expect(result.reserved).toBeLessThanOrEqual(result.pool);
};

describe('explore file allocation under one real output envelope', () => {
  it('reserves useful evidence before assigning weighted remainder', () => {
    const result = allocateExploreFiles([file('entry', { spine: true }), file('worker'), file('contract')], 6000, 3);
    sane(result);
    expect(result.reserved).toBe(6000);
    expect(result.allowances.get('entry')).toBeGreaterThan(result.allowances.get('worker')!);
    expect(result.allowances.get('worker')).toBeGreaterThanOrEqual(700);
    expect(result.allowances.get('worker')).toBe(result.allowances.get('contract'));
  });
  it('returns unused demand to other admitted files instead of stranding their capacity', () => {
    const result = allocateExploreFiles([file('tiny', { demandChars: 120 }), file('large', { named: true })], 6000, 2);
    expect([...result.allowances]).toEqual([['tiny', 120], ['large', 5880]]);
    expect(result.reserved).toBe(6000);
    sane(result);
  });
  it('applies a 70 percent valve only to unprotected files', () => {
    expect(allocateExploreFiles([file('survey')], 10000, 1).allowances.get('survey')).toBe(7000);
    for (const key of ['named', 'pinned', 'protected', 'spine'] as const) {
      expect(allocateExploreFiles([file('target', { [key]: true })], 10000, 1).allowances.get('target')).toBe(10000);
    }
  });
  it('cliffs weak ordinary evidence before maxFiles and never cliffs protected targets', () => {
    const result = allocateExploreFiles([
      file('entry', { score: 10 }), file('noise', { score: 0.1 }),
      file('named', { score: 0, named: true }), file('pinned', { score: 0, pinned: true }),
      file('protected', { score: 0, protected: true }), file('spine', { score: 0, spine: true }), file('extra'),
    ], 9000, 5);
    expect([...result.allowances.keys()]).toEqual(['entry', 'named', 'pinned', 'protected', 'spine']);
    expect(result.rejected).toEqual(['noise', 'extra']);
    sane(result);
  });
  it('funds pure source anchors even when lexical evidence is zero', () => {
    const result = allocateExploreFiles([file('source', { pinned: true, score: 0 }), file('other', { score: 0 })], 5000, 2);
    expect(result.allowances.get('source')).toBe(4300);
    expect(result.allowances.get('other')).toBe(700);
    sane(result);
  });
  it('caps the relative cliff so a high-score named anchor cannot discard useful source neighbors', () => {
    const result = allocateExploreFiles([
      file('named-anchor', { score: 10000, named: true }),
      file('neighbor-at-floor', { score: 10 }),
      file('neighbor-above-floor', { score: 12 }),
      file('weak-match', { score: 1 }),
      file('protected-zero', { score: 0, protected: true }),
    ], 10000, 5);
    expect([...result.allowances.keys()]).toEqual(['named-anchor', 'neighbor-at-floor', 'neighbor-above-floor', 'protected-zero']);
    expect(result.rejected).toEqual(['weak-match']);
    expect(result.allowances.get('neighbor-at-floor')).toBeGreaterThanOrEqual(700);
    expect(result.allowances.get('neighbor-above-floor')).toBeGreaterThanOrEqual(700);
    sane(result);
  });
  it('admits proven graph neighbors regardless of file size without promoting their weight or 70 percent cap', () => {
    const result = allocateExploreFiles([
      file('query-anchor', { score: 10000, named: true }),
      file('large-linked-body', { score: 9, graphEvidence: true }),
      file('small-linked-body', { score: 9, graphEvidence: true, demandChars: 500 }),
      file('weak-unlinked-body', { score: 9 }),
    ], 10000, 4);
    expect([...result.allowances.keys()]).toEqual(['query-anchor', 'large-linked-body', 'small-linked-body']);
    expect(result.rejected).toEqual(['weak-unlinked-body']);
    expect(result.allowances.get('large-linked-body')).toBeGreaterThanOrEqual(700);
    expect(result.allowances.get('large-linked-body')).toBeLessThan(1000);
    expect(result.allowances.get('small-linked-body')).toBe(500);
    expect(allocateExploreFiles([file('only-linked', { graphEvidence: true })], 10000, 1).allowances.get('only-linked')).toBe(7000);
    sane(result);
  });
  it('has deterministic equal fallback for all-zero scores and integer remainder', () => {
    const candidates = ['a', 'b', 'c'].map(path => file(path, { score: 0 }));
    const result = allocateExploreFiles(candidates, 3001, 3);
    expect(values(result)).toEqual([1001, 1000, 1000]);
    expect(allocateExploreFiles(candidates, 3001, 3)).toEqual(result);
    sane(result);
  });
  it('shares an unaffordable minimum without exceeding the envelope', () => {
    const candidates = ['a', 'b', 'c'].map(path => file(path, { protected: true, minimumChars: 1200 }));
    const result = allocateExploreFiles(candidates, 1001, 3);
    expect(values(result)).toEqual([334, 334, 333]);
    sane(result);
  });
  it('uses actual section demand rather than subtracting another fixed overhead', () => {
    const result = allocateExploreFiles([file('a', { demandChars: 331 }), file('b', { demandChars: 669 })], 1000, 2);
    expect(values(result)).toEqual([331, 669]);
    expect(result.reserved).toBe(1000);
  });
  it('handles duplicate paths, invalid limits and non-finite numbers deterministically', () => {
    const candidates = [file('a', { score: NaN }), file('a'), file('b', { score: Infinity }), file('c', { demandChars: NaN })];
    const result = allocateExploreFiles(candidates, 2000.9, 2.9);
    expect([...result.allowances.keys()]).toEqual(['a', 'b']);
    expect(result.pool).toBe(2000);
    expect(result.rejected).toEqual(['c']);
    sane(result);
    expect(allocateExploreFiles(candidates, Infinity, 2).reserved).toBe(0);
    expect(allocateExploreFiles(candidates, 1000, NaN).allowances.size).toBe(0);
    expect(allocateExploreFiles([], 1000, 2).reserved).toBe(0);
  });
  it('does not overflow the sum of very large but finite scores', () => {
    const result = allocateExploreFiles([file('a', { score: 1e308 }), file('b', { score: 1e308 })], 10001, 2);
    expect(values(result)).toEqual([5001, 5000]);
    sane(result);
  });
  it('keeps allocation invariant under symbol and path renaming', () => {
    const candidates = [file('old/main.cpp', { spine: true }), file('old/helper.cpp', { demandChars: 900 }), file('old/types.h')];
    const renamed = candidates.map((candidate, index) => ({ ...candidate, path: `new/file-${index}.rs` }));
    expect(values(allocateExploreFiles(candidates, 7100, 3))).toEqual(values(allocateExploreFiles(renamed, 7100, 3)));
  });
  it('conserves budgets, demand and file limits across heterogeneous deterministic cases', () => {
    let seed = 713;
    const next = (limit: number): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % limit; };
    for (let iteration = 0; iteration < 250; iteration++) {
      const candidates = Array.from({ length: 1 + next(15) }, (_, index) => file(`unit-${index}`, {
        score: next(250) / 10, worth: next(150) / 100, demandChars: next(10000), minimumChars: next(2000),
        named: next(5) === 0, pinned: next(9) === 0, spine: next(4) === 0,
      }));
      const pool = next(24001);
      const maxFiles = next(13);
      const result = allocateExploreFiles(candidates, pool, maxFiles);
      sane(result);
      expect(result.allowances.size).toBeLessThanOrEqual(maxFiles);
      for (const candidate of candidates) {
        expect(result.allowances.get(candidate.path) ?? 0).toBeLessThanOrEqual(candidate.demandChars);
      }
      expect(result).toEqual(allocateExploreFiles(candidates, pool, maxFiles));
    }
  });
});
