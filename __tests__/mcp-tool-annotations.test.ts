import { afterEach, describe, expect, it, vi } from 'vitest';
import type CodeGraph from '../src/index';
import { getStaticTools, getExploreBudget, ToolHandler, tools } from '../src/mcp/tools';

import { QueryBuilder } from '../src/db/queries';
import type { SqliteDatabase } from '../src/db/sqlite-adapter';

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
    const cg = { getFileCount: () => fileCount } as unknown as CodeGraph;
    const list = new ToolHandler(cg).getTools();
    expect(list.length).toBeGreaterThan(0);
    expect(list.find(tool => tool.name === 'explore')?.description).toContain('Budget:');
    expect(list.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
  });
  it.each([0, 499, 500, 4999, 5000, 14999, 15000, 24999, 25000])('uses file-only counts without changing tiny gating or budget at %i files', fileCount => {
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', ''); vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
    const getStats = vi.fn(() => { throw new Error('full graph aggregation forbidden'); });
    const getFileCount = vi.fn(() => fileCount), cg = { getStats, getFileCount } as unknown as CodeGraph;
    const list = new ToolHandler(cg).getTools();
    expect(getStats).not.toHaveBeenCalled(); expect(getFileCount).toHaveBeenCalledOnce();
    expect(list.map(tool => tool.name).sort()).toEqual((fileCount < 500 ? ['context', 'explore', 'node', 'search'] : tools.map(tool => tool.name)).sort());
    expect(list.find(tool => tool.name === 'explore')?.description).toContain(`Budget: make at most ${getExploreBudget(fileCount)} calls for this project (${fileCount.toLocaleString()} files indexed).`);
  });
  it('file count prepares only a files aggregate, never node/edge statistics', () => {
    const prepare = vi.fn(() => ({ get: () => ({ count: 17 }) }));
    const queries = new QueryBuilder({ prepare } as unknown as SqliteDatabase);
    expect(queries.getFileCount()).toBe(17); expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith('SELECT COUNT(*) AS count FROM files');
  });

});
