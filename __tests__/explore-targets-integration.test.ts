import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('explicit targets and freshness through the actual explore tool', () => {
  let root: string, cg: CodeGraph, handler: ToolHandler;
  const implementation = '#include "worker.h"\nnamespace harbor {\nint LedgerWriter::commit() {\n  const int verified_implementation = 813;\n  return verified_implementation;\n}\n}\n';
  const module = 'export function neighbor() {\n  return "outside_requested_range";\n}\n// range_first\n// range_middle\n// range_last\nexport function useful() {\n  return 42;\n}\n';
  beforeAll(async () => {
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
    vi.stubEnv('CODEGRAPH_EXPLORE_LINENUMS', '1');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-target-integration-'));
    fs.writeFileSync(path.join(root, 'worker.h'), 'namespace harbor {\nclass LedgerWriter { public:\n  int commit();\n};\n}\n');
    fs.writeFileSync(path.join(root, 'worker.cpp'), implementation);
    fs.writeFileSync(path.join(root, 'ranges.ts'), module);
    fs.writeFileSync(path.join(root, 'notes.cpp'), '// comments_only_first\n// comments_only_second\n');
    for (const dir of ['left', 'right']) {
      fs.mkdirSync(path.join(root, dir));
      fs.writeFileSync(path.join(root, dir, 'peer.ts'), `export function ${dir}Peer() { return 1; }\n`);
    }
    fs.writeFileSync(path.join(root, 'range-caller.ts'), 'import { leftPeer } from "./left/peer";\nexport function fetchValue() {\n  return leftPeer();\n}\n');
    cg = CodeGraph.initSync(root, { config: { include: ['**/*.ts', '**/*.cpp', '**/*.h'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });
  afterAll(() => {
    cg?.close();
    const relative = path.relative(os.tmpdir(), root);
    if (!relative.startsWith('cg-target-integration-') || relative.includes(path.sep)) throw new Error('unsafe fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const ask = async (query: string, maxFiles = 1) => {
    const result = await handler.execute('explore', { query, maxFiles });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('\n');
  };
  const body = (text: string) => [...text.matchAll(/```[^\n]*\n([\s\S]*?)\n```/g)].map(m => m[1]).join('\n');

  it('delivers a qualified out-of-line C++ definition', async () => {
    const text = await ask('harbor::LedgerWriter::commit');
    expect(body(text)).toContain('verified_implementation = 813');
    expect(body(text)).toContain('return verified_implementation');
    expect(text.match(/^#### /gm)).toHaveLength(1);
  });
  it('does not let a pinned declaration displace its exact implementation at maxFiles=1', async () => {
    const text = await ask('worker.h:3');
    expect(text).toContain('#### worker.cpp');
    expect(body(text)).toContain('return verified_implementation');
    expect(text.match(/^#### /gm)).toHaveLength(1);
  });
  it('delivers an explicit multiline range as that range', async () => {
    const text = await ask('ranges.ts:4-6');
    expect(body(text)).toContain('4\t// range_first');
    expect(body(text)).toContain('6\t// range_last');
    expect(body(text)).not.toContain('outside_requested_range');
  });
  it('retains indexed source without callable nodes for a path and a range', async () => {
    expect(cg.getFile('notes.cpp')).toBeTruthy();
    expect(body(await ask('notes.cpp:1-2'))).toContain('comments_only_second');
    expect(body(await ask('notes.cpp'))).toContain('comments_only_first');
  });
  it('does not expand a pure line-range request through cross-file calls', async () => {
    const text = await ask('range-caller.ts:3-4', 12);
    expect(body(text)).toContain('3\t  return leftPeer();');
    expect(text).not.toContain('#### left/peer.ts');
    expect(text.match(/^#### /gm)).toHaveLength(1);
  });
  it('reports ambiguous basenames rather than choosing a sibling', async () => {
    const text = await ask('peer.ts:1');
    expect(text).toMatch(/ambiguous|unresolved/i);
    expect(body(text)).not.toContain('leftPeer');
    expect(body(text)).not.toContain('rightPeer');
  });
  it('does not reuse verified bytes across queries after a same-size edit', async () => {
    expect(body(await ask('harbor::LedgerWriter::commit'))).toContain('813');
    const file = path.join(root, 'worker.cpp');
    const stamp = fs.statSync(file);
    try {
      fs.writeFileSync(file, implementation.replace('813', '927'));
      fs.utimesSync(file, stamp.atime, stamp.mtime);
      const text = await ask('harbor::LedgerWriter::commit');
      expect(text).toContain('Source omitted: worker.cpp');
      expect(text).toContain('changed since indexing');
      expect(body(text)).not.toContain('813');
      expect(body(text)).not.toContain('927');
      expect(text).not.toMatch(/Complete target: worker\.h:[^\n]*commit/);
      expect(text).toContain('Declaration only');
    } finally { fs.writeFileSync(file, implementation); }
  });
  it('never slices a shifted body at old indexed line numbers', async () => {
    const file = path.join(root, 'worker.cpp');
    try {
      fs.writeFileSync(file, 'int unrelated_shifted_body() { return 999; }\n\n' + implementation);
      const text = await ask('worker.cpp:3-6');
      expect(text).toMatch(/cannot be mapped safely|Source omitted/);
      expect(body(text)).not.toContain('unrelated_shifted_body');
      expect(body(text)).not.toContain('verified_implementation');
    } finally { fs.writeFileSync(file, implementation); }
  });
  it('reports a missing explicit source instead of silently succeeding with a body', async () => {
    const file = path.join(root, 'worker.cpp');
    try {
      fs.unlinkSync(file);
      const text = await ask('harbor::LedgerWriter::commit');
      expect(text).toContain('source file is missing');
      expect(body(text)).not.toContain('verified_implementation');
    } finally { fs.writeFileSync(file, implementation); }
  });
  it('reports an out-of-bounds range without fabricating source lines', async () => {
    const text = await ask('ranges.ts:400-405');
    expect(text).toContain('exceeds');
    expect(body(text)).not.toMatch(/^40[0-5]\t/m);
    expect(body(text)).toBe('');
    expect(text.length).toBeLessThanOrEqual(13000);
  });
  it.each(['ranges.ts:0', 'ranges.ts:-2'])('does not widen invalid range %s into the whole file', async query => {
    const text = await ask(query);
    expect(text).toMatch(/Invalid line target/i);
    expect(body(text)).toBe('');
  });
});
