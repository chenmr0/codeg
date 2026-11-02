import { describe, expect, it } from 'vitest';
import { selectExploreWindow, type ExploreWindowInput } from '../src/mcp/explore-windows';

const gap = '\n\n... (gap) ...\n\n';
const fixture = (count = 120): string[] => Array.from({ length: count }, (_, index) => `step_${String(index + 1).padStart(3, '0')}();`);
const render = (input: ExploreWindowInput, ranges: Array<{ start: number; end: number }>): string => ranges.map(range =>
  input.lines.slice(range.start - 1, range.end).map((line, index) => input.lineNumbers ? `${range.start + index}\t${line}` : line).join('\n'),
).join(input.gap ?? gap);
const covers = (ranges: Array<{ start: number; end: number }>, line: number): boolean => ranges.some(range => range.start <= line && range.end >= line);
const verify = (input: ExploreWindowInput): ReturnType<typeof selectExploreWindow> => {
  const result = selectExploreWindow(input);
  expect(render(input, result.ranges).length).toBeLessThanOrEqual(input.maxChars);
  for (const range of result.ranges) {
    expect(range.start).toBeGreaterThanOrEqual(input.start);
    expect(range.end).toBeLessThanOrEqual(input.end);
    expect(range.end).toBeGreaterThanOrEqual(range.start);
  }
  return result;
};

describe('explore complete bodies and budgeted focus windows', () => {
  it('returns a complete body exactly when every rendered character fits', () => {
    const lines = fixture(8);
    const input = { lines, start: 2, end: 7, maxChars: 1000, lineNumbers: true };
    const exact = render(input, [{ start: 2, end: 7 }]).length;
    expect(verify({ ...input, maxChars: exact })).toEqual({ ranges: [{ start: 2, end: 7 }], complete: true });
    expect(verify({ ...input, maxChars: exact - 1 }).complete).toBe(false);
  });
  it('preserves three distant focuses fairly instead of spending the reserve on the earliest', () => {
    const input = { lines: fixture(), start: 1, end: 120, maxChars: 850, focusLines: [60, 90, 118], lineNumbers: true, gap };
    const result = verify(input);
    expect(result.complete).toBe(false);
    expect(covers(result.ranges, 1)).toBe(true);
    for (const line of input.focusLines) expect(covers(result.ranges, line)).toBe(true);
    const lengths = input.focusLines.map(line => result.ranges.find(range => range.start <= line && range.end >= line)!)
      .map(range => range.end - range.start + 1);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
    expect(selectExploreWindow({ ...input, focusLines: [118, 60, 90, 60] })).toEqual(result);
  });
  it('retains an explicit tail focus without automatically protecting an unrequested tail', () => {
    const input = { lines: fixture(), start: 10, end: 119, maxChars: 500, lineNumbers: false };
    expect(covers(verify(input).ranges, 119)).toBe(false);
    const focused = verify({ ...input, focusLines: [119] });
    expect(covers(focused.ranges, 119)).toBe(true);
    expect(covers(focused.ranges, 10)).toBe(true);
  });
  it('deduplicates overlapping focuses and merges adjacent windows without double charging', () => {
    const result = verify({ lines: fixture(50), start: 1, end: 50, maxChars: 500, lineNumbers: true, focusLines: [29, 30, 31, 29, -1, 200] });
    for (const line of [29, 30, 31]) expect(covers(result.ranges, line)).toBe(true);
    for (let index = 1; index < result.ranges.length; index++) expect(result.ranges[index]!.start).toBeGreaterThan(result.ranges[index - 1]!.end + 1);
  });
  it('never buys a minimum number of lines by exceeding the hard budget', () => {
    const input = { lines: ['x'.repeat(800), 'short();', 'y'.repeat(700)], start: 1, end: 3, maxChars: 100, lineNumbers: true };
    expect(verify(input).ranges).toEqual([]);
    const focused = verify({ ...input, focusLines: [2] });
    expect(focused.ranges).toEqual([{ start: 2, end: 2 }]);
    expect(focused.complete).toBe(false);
  });
  it('accounts for CRLF remnants, variable digit counts, gap text and whole line boundaries', () => {
    const lines = fixture(112).map(line => `${line}\r`);
    for (const lineNumbers of [false, true]) {
      for (const customGap of ['', '\n', gap, '\n[omitted source]\n']) {
        const input = { lines, start: 95, end: 112, maxChars: 155, lineNumbers, gap: customGap, focusLines: [109, 112] };
        verify(input);
      }
    }
  });
  it('leaves the full head allowance when it already includes all focuses', () => {
    const input = { lines: fixture(), start: 1, end: 120, maxChars: 500, lineNumbers: true };
    expect(verify({ ...input, focusLines: [2, 3] })).toEqual(verify(input));
  });
  it('does not infer semantic landmarks from source spelling', () => {
    const lines = fixture();
    const renamed = lines.map(line => line.replace('step_', 'call_'));
    const input = { lines, start: 4, end: 116, maxChars: 510, lineNumbers: true, focusLines: [80, 110] };
    expect(verify(input)).toEqual(verify({ ...input, lines: renamed }));
  });
  it('rejects malformed spans instead of falsely claiming a clipped body complete', () => {
    const input = { lines: fixture(5), start: 1, end: 5, maxChars: 100, lineNumbers: true };
    for (const patch of [{ start: 0 }, { start: 2.5 }, { end: 6 }, { end: 0 }, { maxChars: Infinity }, { maxChars: -1 }]) {
      expect(selectExploreWindow({ ...input, ...patch })).toEqual({ ranges: [], complete: false });
    }
  });
  it('keeps real rendered cost bounded with varied long lines, span offsets and focus counts', () => {
    let seed = 913;
    const next = (limit: number): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % limit; };
    for (let iteration = 0; iteration < 250; iteration++) {
      const lines = Array.from({ length: 130 }, () => 'x'.repeat(next(150)));
      const start = 1 + next(30);
      const end = start + next(100);
      const input = { lines, start, end, maxChars: next(2400), lineNumbers: next(2) === 0,
        gap: ['','\n',gap][next(3)]!, focusLines: Array.from({ length: next(8) }, () => start + next(end - start + 1)) };
      const result = verify(input);
      if (result.complete) expect(result.ranges).toEqual([{ start, end }]);
    }
  });
});
