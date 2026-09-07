import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreDiagnostics, measureStore } from '../src/extraction/store-diagnostics';

describe('sync store attribution', () => {
  afterEach(() => vi.restoreAllMocks());
  it('passes through without timers when verbose is off', () => {
    const clock = vi.spyOn(performance, 'now');
    const operation = vi.fn(() => 42);
    expect(measureStore(undefined, 'nodesMs', operation)).toBe(42);
    expect(operation).toHaveBeenCalledTimes(1); expect(clock).not.toHaveBeenCalled();
  });
  it('accumulates timings, preserves errors and does not expose source data', () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time += 10);
    const detail = new StoreDiagnostics();
    expect(detail.measure('nodesMs', () => 3)).toBe(3);
    expect(() => detail.measure('nodesMs', () => { throw new Error('SQL failed'); })).toThrow('SQL failed');
    expect(detail.timings.nodesMs).toBe(20); expect(detail.failedPhase).toBe('nodesMs');
    expect(detail.format()).toContain('files=0 skipped=0 nodeRows=0');
    expect(detail.format()).toContain('nodesMs=20ms');
  });
});
