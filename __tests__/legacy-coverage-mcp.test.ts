import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import type { QueryBuilder } from '../src/db/queries';
import { ToolHandler } from '../src/mcp/tools';

let directory: string;
let cg: CodeGraph;
let handler: ToolHandler;
const queries = () => (cg as unknown as { queries: QueryBuilder }).queries;

async function text(tool: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await handler.execute(tool, args);
  expect(result.isError).toBeFalsy();
  return result.content.map(item => item.text).join('\n');
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-legacy-coverage-mcp-'));
  fs.writeFileSync(path.join(directory, 'api.h'), 'int target(int value);\nint declaration_only(int value);\n');
  fs.writeFileSync(path.join(directory, 'api.c'), '#include "api.h"\nint target(int value) { return value; }\n');
  fs.writeFileSync(path.join(directory, 'caller.c'), '#include "api.h"\nint caller(void) { return target(1); }\n');
  cg = CodeGraph.initSync(directory);
  expect((await cg.indexAll()).complete).toBe(true);
  // Unit simulation of old metadata; real historical databases are tested separately.
  queries().applyMetadataChanges({
    indexed_with_version: '1.1.1', indexed_with_extraction_version: '34',
    index_completeness: 'complete', index_diagnostics: '[]',
    index_synthesis_completed_version: null, index_synthesis_verification_started: null,
  });
  cg.close(); cg = await CodeGraph.open(directory);
  // Mirror MCP startup: a no-op sync publishes readiness for the opened graph.
  expect((await cg.sync()).complete).not.toBe(false);
  handler = new ToolHandler(cg);
});

afterEach(() => {
  handler?.closeAll(); cg?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('MCP legacy coverage messaging (simulated old metadata)', () => {
  it('serves symbols and relationships with a nonblocking coverage notice', async () => {
    expect(cg.getIndexDataReadiness()).toMatchObject({ symbolsReady: true, relationshipsReady: true });
    for (const [tool, args] of [
      ['search', { query: 'target' }], ['callers', { symbol: 'target' }], ['files', {}],
    ] as const) {
      const output = await text(tool, args);
      expect(output).toContain('Legacy index is usable; synthesis coverage is unverified');
      expect(output).toContain('Run `codegraph index`');
      expect(output).not.toMatch(/refresh is unfinished|refresh was incomplete|relationship data is incomplete/);
    }
    expect(await text('callers', { symbol: 'target' })).toContain('caller');
  });

  it('shows legacy coverage in status without calling the index unfinished', async () => {
    const output = await text('status');
    expect(output).toContain('**Coverage:** legacy index usable; synthesis coverage unverified');
    expect(output).toContain('Run `codegraph index`');
    expect(output).not.toMatch(/not ready|unfinished|\*\*Refresh:\*\* incomplete/);
  });

  it('does not certify missing definitions or call relationships', async () => {
    for (const tool of ['search', 'node']) {
      const output = await text(tool, tool === 'search'
        ? { query: 'declaration_only' }
        : { symbol: 'declaration_only', includeRelations: true });
      expect(output).toContain('absence has not been established');
      expect(output).not.toContain('Treat this as authoritative');
      expect(output).not.toContain('Treat that as authoritative');
      expect(output).not.toContain('relationships are not ready');
    }
    for (const tool of ['callers', 'callees']) {
      const output = await text(tool, { symbol: 'declaration_only' });
      expect(output).toContain('this is not a completed absence check');
    }
  });

  it('clears the notice after an explicit full verification', async () => {
    expect((await cg.indexAll()).complete).toBe(true);
    expect(await text('search', { query: 'target' })).not.toContain('Legacy index');
    expect(await text('status')).not.toContain('synthesis coverage unverified');
  });

  it('retains an actual incomplete warning rather than treating it as legacy availability', async () => {
    queries().applyMetadataChanges({
      index_completeness: 'incomplete', index_synthesis_pending: 'complete',
      index_diagnostics: JSON.stringify([{
        severity: 'error', code: 'synthesis_failed', message: 'A real synthesis failure.',
      }]),
    });
    const output = await text('callers', { symbol: 'target' });
    expect(output).toContain('Index refresh is unfinished');
    expect(output).not.toContain('Legacy index is usable');
  });
});
