import { afterEach, describe, expect, it, vi } from 'vitest';
import type CodeGraph from '../src/index';
import { getStaticTools, ToolHandler, tools } from '../src/mcp/tools';

const queryNames = ['search', 'node', 'callers', 'callees', 'impact', 'files',
  'status', 'text_search', 'explore', 'context'];

describe('MCP read-only tool annotations', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(queryNames)('advertises %s as read-only on the wire', name => {
    const wireTools = JSON.parse(JSON.stringify(tools));
    expect(wireTools.find((tool: { name: string }) => tool.name === name)?.annotations)
      .toEqual({ readOnlyHint: true });
  });

  it('preserves hints in both allowlisted tools/list surfaces', () => {
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'search,context,explore');
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
    for (const list of [getStaticTools(), new ToolHandler(null).getTools()]) {
      expect(list.map(tool => tool.name).sort()).toEqual(['context', 'explore', 'search']);
      expect(list.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
    }
  });

  it.each([10, 1000])('preserves hints with dynamic descriptions and %i files', fileCount => {
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', '');
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
    const cg = { getStats: () => ({ fileCount }) } as unknown as CodeGraph;
    const list = new ToolHandler(cg).getTools();
    expect(list.length).toBeGreaterThan(0);
    expect(list.find(tool => tool.name === 'explore')?.description).toContain('Budget:');
    expect(list.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
  });
});
