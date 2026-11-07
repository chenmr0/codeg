import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { getExploreOutputBudget } from '../src/upstream-explore/mcp/budget-policy';

describe('explore input and evidence contract', () => {
  let dir: string, cg: CodeGraph, handler: ToolHandler;
  beforeAll(async () => {
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-contract-'));
    fs.writeFileSync(path.join(dir, 'engine.cpp'), 'namespace demo {\nint calculate(int value) {\n  return value + 11;\n}\nint apply(int value) {\n  return calculate(value);\n}\n}\n');
    fs.writeFileSync(path.join(dir, 'client.ts'), 'export function receive(value: number) {\n  return value * 7;\n}\n');
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.cpp', '**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => { cg?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  it.each([
    'calculate apply', 'calculate\tapply\nreceive', 'demo::calculate demo::apply',
    'engine.cpp calculate', 'calculate, apply; receive',
    'How does apply call calculate?', '检查 calculate 与 apply 的调用关系',
  ])('passes valid explore input to retrieval: %s', async query => {
    const result = await handler.execute('explore', { query, maxFiles: 12 });
    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]?.text).toContain('return value + 11;');
    expect(result.content?.[0]?.text).not.toContain('不支持自然语言');
  });

  it('returns real bodies for a cross-file symbol bag', async () => {
    const result = await handler.execute('explore', { query: 'calculate receive', maxFiles: 12 });
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('return value + 11;');
    expect(text).toContain('return value * 7;');
  });

  it.each([undefined, 12, '', 'x'.repeat(10001)])('retains basic input validation: %s', async query => {
    const spy = vi.spyOn(cg, 'findRelevantContext');
    const result = await handler.execute('explore', { query });
    expect(result.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps whitespace-only input non-selective without returning unrelated source', async () => {
    // The pinned upstream contract accepts a nonempty string, then yields an
    // empty search. Do not preserve the retired handler's trim-and-reject rule.
    const result = await handler.execute('explore', { query: '   ' });
    const text = result.content?.[0]?.text ?? '';
    expect(result.isError).not.toBe(true);
    expect(text).toContain('No relevant code found');
    expect(text).not.toContain('return value + 11;');
    expect(text).not.toContain('return value * 7;');
    expect(text).not.toContain('```');
  });

  it('does not change single-symbol search validation', async () => {
    const result = await handler.execute('search', { query: 'calculate apply' });
    expect(result.content?.[0]?.text).toContain('不是单个符号名');
  });

  it('does not impose a call quota and keeps repeated production answers inside the tier budget', async () => {
    // No session is supplied: repeat the actual dispatch, not a retired response
    // formatter. Advisory wording is not a quota and must never reject calls.
    const budget = getExploreOutputBudget(cg.getStats().fileCount);
    for (let call = 0; call < 6; call++) {
      const result = await handler.execute('explore', { query: 'calculate receive', maxFiles: 12 });
      expect(result.isError).not.toBe(true);
      const text = result.content?.[0]?.text ?? '';
      expect(text).toContain('return value + 11;');
      expect(text).toContain('return value * 7;');
      expect(text.length).toBeLessThanOrEqual(budget.maxOutputChars);
      expect((text.match(/^```/gm)?.length ?? 0) % 2).toBe(0);
    }
  });
});
