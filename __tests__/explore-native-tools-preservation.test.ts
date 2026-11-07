/** Public MCP regression: Explore migration must not replace batch/raw-source tools. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';
let root: string, graph: CodeGraph, handler: ToolHandler;
beforeEach(async () => {
  vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
  vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
  vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,node,context,search,text_search');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-preserve-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'flow.cpp'), [
    'int helper(int value) { return value + 731; }',
    'int first() { return helper(1); }',
    'int second() { return first(); }',
    '// RAW_ONLY_MIGRATION_MARKER is intentionally not an AST declaration.',
  ].join('\n') + '\n');
  graph = CodeGraph.initSync(root); await graph.indexAll(); handler = new ToolHandler(graph);
});
afterEach(async () => {
  handler?.closeAll(); if (handler) await handler.whenIdle();
  if (graph) { await graph.whenIdle(); graph.close(); await graph.whenIdle(); }
  vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
});
async function output(tool: string, args: Record<string, unknown>) {
  const result = await handler.execute(tool, args);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.content.map(part => part.text ?? '').join('\n');
}
it.each(['node', 'context'])('preserves native %s multi-target bodies after an Explore call', async tool => {
  expect(await output('explore', { query: 'helper first second', maxFiles: 2 })).toContain('return value + 731;');
  const result = await output(tool, { targets: [
    { symbol: 'first', file: 'src/flow.cpp' }, { symbol: 'second', file: 'src/flow.cpp' },
  ] });
  expect(result).toContain('return helper(1)'); expect(result).toContain('return first()');
  expect(result).toMatch(/merged file ranges|batch mode/i);
});
it('preserves internal raw-source fallback for a missing indexed symbol', async () => {
  expect(graph.getNodesByName('RAW_ONLY_MIGRATION_MARKER')).toHaveLength(0);
  const result = await output('search', { query: 'RAW_ONLY_MIGRATION_MARKER' });
  expect(result).toContain('RAW_MATCHES'); expect(result).toContain('src/flow.cpp');
  expect(result).toContain('RAW_ONLY_MIGRATION_MARKER'); expect(result).not.toContain('CONFIRMED_ABSENT');
});
it('preserves bounded multi-literal search without changing Explore state', async () => {
  const result = await output('text_search', {
    queries: ['return helper(1)', 'return first()'], path: 'src', contextLines: 0,
  });
  expect(result).toContain('return helper(1)'); expect(result).toContain('return first()');
  expect(result).toContain('src/flow.cpp');
  expect(await output('explore', { query: 'helper', maxFiles: 2 })).toContain('return value + 731;');
});
