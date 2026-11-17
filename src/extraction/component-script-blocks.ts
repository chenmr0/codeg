export interface ComponentScriptBlock {
  content: string;
  language: 'javascript' | 'typescript';
}

/** Preserve physical source positions before the parser assigns node IDs,
 * references and comment lines, including for the second script in a component. */
export function* componentScriptBlocks(source: string): Iterable<ComponentScriptBlock> {
  for (const match of source.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    const start = match.index! + match[0].indexOf('>') + 1;
    const line = source.slice(0, start).split('\n').length - 1;
    const column = start - (source.lastIndexOf('\n', start - 1) + 1);
    yield {
      content: '\n'.repeat(line) + ' '.repeat(column) + match[2]!,
      language: /lang\s*=\s*["'](ts|typescript)["']/.test(match[1] ?? '') ? 'typescript' : 'javascript',
    };
  }
}
