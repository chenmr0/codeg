/**
 * Select a one-based inclusive line range without splitting the whole source.
 * Keep LF-only boundaries, CR characters and the trailing empty line exactly
 * as `content.split('\n').slice(startLine - 1, endLine).join('\n')` does.
 */
export function sliceLines(content: string, startLine?: number, endLine?: number): string | null {
  if (!startLine || !endLine) return null;
  // Preserve Array.slice coercion for unusual bounds; extracted line numbers
  // use the positive integer fast path below.
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
      startLine < 1 || endLine < 1) {
    return content.split('\n').slice(startLine - 1, endLine).join('\n');
  }
  if (endLine < startLine) return '';
  let start = 0;
  for (let line = 1; line < startLine; line++) {
    const newline = content.indexOf('\n', start);
    if (newline === -1) return '';
    start = newline + 1;
  }
  let end = start;
  for (let line = startLine; line <= endLine; line++) {
    const newline = content.indexOf('\n', end);
    if (newline === -1) return content.slice(start);
    if (line === endLine) return content.slice(start, newline);
    end = newline + 1;
  }
  return '';
}
