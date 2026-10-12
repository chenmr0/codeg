import { describe, expect, it } from 'vitest';
import { SyncDiagnosticsSummary } from '../src/sync/diagnostics-summary';

function fields(d: SyncDiagnosticsSummary): Record<string, number> {
  return Object.fromEntries(d.lines('success')[6]!.slice('[sync-summary] refs '.length)
    .split(' ').filter(Boolean).map(field => {
      const [key, value] = field.split('='); return [key, Number(value)];
    }));
}

describe('existing reference yield observations', () => {
  it('uses mutually exclusive raw-duration buckets with inclusive upper bounds', () => {
    const d = new SyncDiagnosticsSummary();
    for (const ms of [0, 0.49, 1, 1.001, 10, 10.001, 50, 50.001, 250, 250.001]) {
      d.recordReferenceYield('changedRefs', ms);
    }
    const f = fields(d);
    expect(f.changedRefsYieldCount).toBe(10);
    expect(f.changedRefsYieldLe1Count).toBe(3);
    expect(f.changedRefsYieldGt1Le10Count).toBe(2);
    expect(f.changedRefsYieldGt10Le50Count).toBe(2);
    expect(f.changedRefsYieldGt50Le250Count).toBe(2);
    expect(f.changedRefsYieldGt250Count).toBe(1);
    expect(f.changedRefsYieldMaxMs).toBe(250);
    expect(f.changedRefsYieldMs).toBe(622);
    expect(d.lines('success')).toHaveLength(8);
  });
  it('rejects invalid measurements and keeps scopes and runs independent', () => {
    const d = new SyncDiagnosticsSummary();
    for (const ms of [-1, NaN, Infinity]) d.recordReferenceYield('failedRetry', ms);
    expect(fields(d)).toEqual({});
    d.recordReferenceYield('failedRetry', 11);
    d.recordReferenceYield('changedRefs', 9);
    expect(fields(d)).toMatchObject({ failedRetryYieldCount: 1, failedRetryYieldMaxMs: 11,
      changedRefsYieldCount: 1, changedRefsYieldMaxMs: 9 });
    expect(fields(new SyncDiagnosticsSummary())).toEqual({});
  });
  it('max and last preserve numeric-only semantics without summing snapshots', () => {
    const d = new SyncDiagnosticsSummary();
    d.max('refs', 'changedRefsYieldMaxMs', 20);
    d.max('refs', 'changedRefsYieldMaxMs', 5);
    d.last('refs', 'changedRefsYieldCount', 4);
    d.last('refs', 'changedRefsYieldCount', 2);
    d.max('refs', '/private/path', 20);
    d.last('refs', 'invalid', NaN);
    expect(fields(d)).toEqual({ changedRefsYieldCount: 2, changedRefsYieldMaxMs: 20 });
  });
});
