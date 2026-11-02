import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { capExploreResponse } from '../src/mcp/explore-response';

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

  it.each([undefined, 12, '', '   ', 'x'.repeat(10001)])('retains basic input validation: %s', async query => {
    const spy = vi.spyOn(cg, 'findRelevantContext');
    const result = await handler.execute('explore', { query });
    expect(result.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not change single-symbol search validation', async () => {
    const result = await handler.execute('search', { query: 'calculate apply' });
    expect(result.content?.[0]?.text).toContain('不是单个符号名');
  });

  it('never claims whole files were read or imposes a call quota, including large tiers', async () => {
    const stats = cg.getStats();
    vi.spyOn(cg, 'getStats').mockReturnValue({ ...stats, fileCount: 10000 });
    const result = await handler.execute('explore', { query: 'calculate receive', maxFiles: 12 });
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('Only shown source ranges');
    expect(text).not.toMatch(/Explore budget:|remaining calls|Synthesize once|already Read|do NOT|Complete source for|byte-for-byte identical/i);
    expect(text).toContain('return value + 11;');
  });
});

describe('explore response ceiling', () => {
  it('leaves an in-budget answer unchanged', () => {
    expect(capExploreResponse('a short answer', 25000)).toBe('a short answer');
  });
  it.each([19500, 25000])('includes its truthful notice and balanced fences within %i chars', ceiling => {
    const output = '### Source Code\n#### huge.cpp\n```cpp\n' + '1\tint x = 0;\n'.repeat(4000) + '```';
    const result = capExploreResponse(output, ceiling);
    expect(result.length).toBeLessThanOrEqual(ceiling);
    expect(result).toContain('Output truncated to budget. Only the shown source ranges');
    expect((result.match(/^```/gm)?.length ?? 0) % 2).toBe(0);
    expect(result).not.toMatch(/complete and verbatim|already Read|do NOT Read/);
  });
  it('drops a trailing file section instead of slicing its body when possible', () => {
    const first = '#### first.cpp\n```cpp\n' + '1\t// source\n'.repeat(1400) + '```';
    const result = capExploreResponse(first + '\n#### last.cpp\n```cpp\n' + '2\t// tail\n'.repeat(2000) + '```', 25000);
    expect(result).toContain(first);
    expect(result).not.toContain('last.cpp');
    expect(result.length).toBeLessThanOrEqual(25000);
  });
});
