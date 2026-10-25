/**
 * Head/focus policy informed by upstream CodeGraph v1.6.2, commit
 * 6560052a6f856855d3f71eee838fd66ccfa4285d (src/mcp/tools.ts).
 * Local implementation uses exact caller-rendered source costs and never lets
 * a minimum line count exceed the envelope; focus regions share the reserve.
 */

export interface ExploreWindowInput {
  /** Full file lines. Line numbers and returned ranges are one based. */
  lines: readonly string[];
  start: number;
  end: number;
  maxChars: number;
  focusLines?: readonly number[];
  lineNumbers: boolean;
  /** Exact text joining disjoint ranges, including any surrounding newlines. */
  gap?: string;
}

export interface ExploreWindow {
  ranges: Array<{ start: number; end: number }>;
  complete: boolean;
}

type Range = ExploreWindow['ranges'][number];

/**
 * Whole lines only: first try the full body, then a head plus equally funded
 * focus windows. No minimum-window floor may overdraw the caller's envelope.
 * Names and source language do not participate in this source selection.
 */
export function selectExploreWindow(input: ExploreWindowInput): ExploreWindow {
  const empty: ExploreWindow = { ranges: [], complete: false };
  if (!Number.isInteger(input.start) || !Number.isInteger(input.end) || input.start < 1
      || input.end < input.start || input.end > input.lines.length
      || !Number.isFinite(input.maxChars) || input.maxChars < 0) return empty;
  const budget = Math.floor(input.maxChars);
  const gap = input.gap ?? '\n\n... (gap) ...\n\n';
  const { start, end } = input;
  const prefix = [0];
  for (let line = start; line <= end; line++) {
    const text = input.lines[line - 1]!;
    prefix.push(prefix[prefix.length - 1]! + text.length + (input.lineNumbers ? String(line).length + 1 : 0) + 1);
  }
  const cost = (range: Range): number => prefix[range.end - start + 1]! - prefix[range.start - start]! - 1;
  const merge = (ranges: readonly Range[]): Range[] => {
    const sorted = ranges.map(range => ({ ...range })).sort((a, b) => a.start - b.start || a.end - b.end);
    const result: Range[] = [];
    for (const range of sorted) {
      const previous = result[result.length - 1];
      if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
      else result.push(range);
    }
    return result;
  };
  const renderedCost = (ranges: readonly Range[]): number => ranges.reduce((sum, range) => sum + cost(range), 0)
    + Math.max(0, ranges.length - 1) * gap.length;
  const head = (room: number): Range[] => {
    let last = start - 1;
    while (last < end && cost({ start, end: last + 1 }) <= room) last++;
    return last >= start ? [{ start, end: last }] : [];
  };
  if (cost({ start, end }) <= budget) return { ranges: [{ start, end }], complete: true };
  const focus = [...new Set(input.focusLines ?? [])]
    .filter(line => Number.isInteger(line) && line >= start && line <= end).sort((a, b) => a - b);
  let ranges = head(budget);
  const covered = (line: number): boolean => ranges.some(range => line >= range.start && line <= range.end);
  if (focus.every(covered)) return { ranges, complete: false };
  ranges = head(Math.floor(budget * 0.6));
  const pending = focus.filter(line => !covered(line));
  const headEnd = ranges.length ? ranges[0]!.end : start - 1;
  // Split disjoint center territories at midpoints. This prevents two adjacent
  // focuses from charging duplicate source or claiming each other's reserve.
  const windows = pending.map((line, index) => ({
    line,
    lo: index > 0 ? Math.floor((pending[index - 1]! + line) / 2) + 1 : Math.max(start, headEnd + 1),
    hi: index + 1 < pending.length ? Math.floor((line + pending[index + 1]!) / 2) : end,
    range: undefined as Range | undefined,
  }));
  const centered = (line: number, lo: number, hi: number, room: number): Range | undefined => {
    if (cost({ start: line, end: line }) > room) return undefined;
    let left = line;
    let right = line;
    while (left > lo || right < hi) {
      const canLeft = left > lo && cost({ start: left - 1, end: right }) <= room;
      const canRight = right < hi && cost({ start: left, end: right + 1 }) <= room;
      if (!canLeft && !canRight) break;
      if (canLeft && (!canRight || line - left <= right - line)) left--;
      else right++;
    }
    return { start: left, end: right };
  };
  // Each pass gives every still-expandable focus the SAME additional allowance.
  // Short/end-of-body windows return unused room for another fair pass.
  for (let pass = 0; pass <= windows.length; pass++) {
    const active = windows.filter(window => !window.range || window.range.start > window.lo || window.range.end < window.hi);
    if (!active.length) break;
    const room = budget - renderedCost(ranges);
    const reserveGaps = active.filter(window => !window.range).length * gap.length;
    const extra = Math.floor(Math.max(0, room - reserveGaps) / active.length);
    if (extra <= 0) break;
    let changed = false;
    for (const window of active) {
      const allowance = (window.range ? cost(window.range) : 0) + extra;
      const next = centered(window.line, window.lo, window.hi, allowance);
      if (!next || (window.range && next.start === window.range.start && next.end === window.range.end)) continue;
      const proposed = merge([...head(Math.floor(budget * 0.6)),
        ...windows.filter(item => item !== window && item.range).map(item => item.range!), next]);
      // Joining an adjacent range replaces the gap with a newline, which can
      // cost MORE when a caller uses an empty/short gap. Always price the union.
      if (renderedCost(proposed) > budget) continue;
      window.range = next;
      ranges = proposed;
      changed = true;
    }
    if (!changed) break;
  }
  return { ranges, complete: ranges.length === 1 && ranges[0]!.start === start && ranges[0]!.end === end };
}
