import { describe, expect, it } from 'vitest';
import { ToolHandler } from '../src/upstream-explore/mcp/tools';
import type { Node, Subgraph } from '../src/upstream-explore/types';

// Consumer-only counterfactual: supply the calls that upstream's newer Razor
// inline-script extractor produces. Native extraction gaps remain visible in
// upstream-v162/explore-blast-radius.test.ts; this does not fake them there.
const node = (id: string, filePath: string, kind = 'function'): Node => ({
  id, name: id, qualifiedName: id, filePath, kind, language: 'javascript',
  startLine: 1, endLine: 1, startColumn: 0, endColumn: 1,
} as Node);
function render(callers: Node[]) {
  const root = node('helper', 'src/helper.js');
  const graph = { getCallers: (id: string) => id === root.id ? callers.map(node => ({ node })) : [] };
  const subgraph: Subgraph = { nodes: new Map([[root.id, root]]), edges: [], roots: [root.id] };
  return (new ToolHandler(graph as never) as any).buildBlastRadiusSection(graph, subgraph) as string;
}
describe('Explore view blast-radius consumer with graph-provided calls', () => {
  it('reserves a separate slot for views after four code callers', () => {
    const text = render([
      ...['a', 'b', 'c', 'd', 'e'].map(id => node(id, `src/${id}.js`)),
      node('Edit', 'Views/Edit.cshtml', 'component'), node('Index', 'Views/Index.cshtml', 'component'),
    ]);
    expect(text).toContain('+1 more; 2 views: `Views/Edit.cshtml`, `Views/Index.cshtml`');
  });
  it('reports a view when it is the only caller', () => {
    expect(render([node('Solo', 'Views/Solo.cshtml', 'component')]))
      .toContain('1 caller in 1 view: `Views/Solo.cshtml`');
  });
});
