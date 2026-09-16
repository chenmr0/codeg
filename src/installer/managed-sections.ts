/** Exact marker pairs are installer-owned, including edits inside them. */
export type MarkerPair = readonly [start: string, end: string];

export const INSTRUCTION_MARKERS: readonly MarkerPair[] = [
  ['<!-- CODEGRAPH_START -->', '<!-- CODEGRAPH_END -->'],
  ['<!-- CODEGRAPH_WX_START -->', '<!-- CODEGRAPH_WX_END -->'],
];

export const GIT_HOOK_MARKERS: readonly MarkerPair[] = [
  ['# >>> codegraph sync hook >>>', '# <<< codegraph sync hook <<<'],
  ['# >>> codegraph-wx sync hook >>>', '# <<< codegraph-wx sync hook <<<'],
];

/** Validate the entire file before replacing anything. Outside bytes stay intact. */
export function resetManagedSections(
  content: string,
  pairs: readonly MarkerPair[],
  replacement = '',
  file = 'instructions',
): { content: string; count: number } {
  const tokens = pairs.flatMap(([start, end], pair) => [
    { marker: start, pair, start: true }, { marker: end, pair, start: false },
  ]);
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  let opened: { position: number; pair: number } | undefined;
  while (cursor < content.length) {
    const next = tokens.map(token => ({ ...token, position: content.indexOf(token.marker, cursor) }))
      .filter(token => token.position >= 0).sort((a, b) => a.position - b.position)[0];
    if (!next) break;
    if (next.start) {
      if (opened) throw new Error(`${file}: nested CodeGraph markers; repair the marker pairs and retry.`);
      opened = { position: next.position, pair: next.pair };
    } else {
      if (!opened || opened.pair !== next.pair) {
        throw new Error(`${file}: unmatched CodeGraph end marker; repair the marker pairs and retry.`);
      }
      ranges.push([opened.position, next.position + next.marker.length]);
      opened = undefined;
    }
    cursor = next.position + next.marker.length;
  }
  if (opened) throw new Error(`${file}: missing CodeGraph end marker; repair the marker pairs and retry.`);

  if (!ranges.length) {
    const separator = !content || content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    return { content: replacement ? content + separator + replacement + '\n' : content, count: 0 };
  }
  let result = '';
  cursor = 0;
  ranges.forEach(([start, end], index) => {
    result += content.slice(cursor, start) + (index === 0 ? replacement : '');
    cursor = end;
  });
  return { content: result + content.slice(cursor), count: ranges.length };
}
