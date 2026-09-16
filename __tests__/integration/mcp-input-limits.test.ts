/**
 * MCP tool input-size limits
 *
 * Regression coverage for the DoS vector: MCP clients can ship
 * unbounded payloads (`query`, `task`, `symbol`, `projectPath`,
 * `path`, `pattern`). Before the cap, a 100MB string would hit
 * the FTS5 layer and pin the server. These tests assert that the
 * tool layer rejects oversize inputs early.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/index';
import { ToolHandler } from '../../src/mcp/tools';

describe('MCP input size limits', () => {
  let tempDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;
  const EXPLORE_ENV = 'CODEGRAPH_ENABLE_EXPLORE';
  let exploreOriginal: string | undefined;

  beforeEach(async () => {
    exploreOriginal = process.env[EXPLORE_ENV];
    process.env[EXPLORE_ENV] = '1';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-limits-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'a.ts'),
      `export function alpha(): number { return 1; }\n`
    );
    cg = await CodeGraph.init(tempDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (exploreOriginal === undefined) delete process.env[EXPLORE_ENV];
    else process.env[EXPLORE_ENV] = exploreOriginal;
    if (cg) cg.destroy();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('accepts a normal-sized query', async () => {
    const result = await handler.execute('search', { query: 'alpha' });
    expect(result.isError).toBeFalsy();
  });

  it('rejects an oversize query on codegraph_wx_search', async () => {
    const huge = 'a'.repeat(20_000);
    const result = await handler.execute('search', { query: huge });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/maximum length/i);
  });

  it('rejects an oversize query on codegraph_wx_explore', async () => {
    const huge = 'b'.repeat(50_000);
    const result = await handler.execute('explore', { query: huge });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/maximum length/i);
  });

  it('rejects an oversize symbol on codegraph_wx_callers', async () => {
    const huge = 'c'.repeat(15_000);
    const result = await handler.execute('callers', { symbol: huge });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/maximum length/i);
  });

  it('rejects an oversize symbol on codegraph_wx_impact', async () => {
    const huge = 'd'.repeat(11_000);
    const result = await handler.execute('impact', { symbol: huge });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/maximum length/i);
  });

  it('rejects an oversize projectPath', async () => {
    const hugePath = '/tmp/' + 'x'.repeat(5_000);
    const result = await handler.execute('search', {
      query: 'alpha',
      projectPath: hugePath,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/projectPath/);
  });

  it('rejects an oversize path filter on codegraph_wx_files', async () => {
    const hugePath = 'src/' + 'y'.repeat(5_000);
    const result = await handler.execute('files', { path: hugePath });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/path/);
  });

  it('rejects an oversize glob pattern on codegraph_wx_files', async () => {
    const hugePattern = '*'.repeat(5_000);
    const result = await handler.execute('files', { pattern: hugePattern });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/pattern/);
  });

  it('rejects a non-string projectPath', async () => {
    const result = await handler.execute('search', {
      query: 'alpha',
      projectPath: 12345 as unknown as string,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/projectPath/);
  });
});
