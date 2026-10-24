import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import { QueryBuilder } from '../src/db/queries';
import { ToolHandler } from '../src/mcp/tools';
import { retrieveExploreContext } from '../src/mcp/explore-retrieval';
import type { Node } from '../src/types';
import { renderExploreSources, type ExploreSourceFile } from '../src/mcp/explore-selection';
import { findEntryProcessingNodes } from '../src/mcp/explore-entry-chain';

const node = (name: string, startLine: number, endLine: number, kind = 'function') =>
  ({ id: name, name, qualifiedName: name, startLine, endLine, kind, language: 'typescript' } as Node);
const file = (path: string, content: string, nodes: Node[], priorities: Record<string, number> = {}): ExploreSourceFile =>
  ({ path, content, nodes, priority: n => priorities[n.name] ?? 0, connectivity: () => 0,
    skeleton: false, bodyAllowed: () => true });
const render = (files: ExploreSourceFile[], total = 2400, perFile = 700, maxFiles = 12, lineNumbers = true) =>
  renderExploreSources('### Source Code\n\n', files, {
    maxOutputChars: total, maxCharsPerFile: perFile, maxFiles, lineNumbers, headerSymbols: 8,
  });
const body = (name: string, count: number) => [`function ${name}() {`, ...Array.from({ length: count }, (_, i) => `  step_${name}_${i}();`), `} // END_${name}`].join('\n');

describe('Explore P1 source selection', () => {
  it('selects a distant named body instead of the enclosing type and adjacent filler', () => {
    const content = ['class Large {', body('filler', 40), body('target', 5), '}'].join('\n');
    const out = render([file('large.ts', content, [node('Large', 1, 51, 'class'), node('filler', 2, 43), node('target', 44, 50)], { filler: 4 })], 700, 500);
    expect(out).toContain('END_target');
    expect(out).not.toContain('END_filler');
    expect(out.length).toBeLessThanOrEqual(700);
  });
  it('borrows unused capacity for complete named functions after protecting another file', () => {
    const a = body('first', 20), b = body('last', 20);
    const out = render([file('same.ts', a + '\n' + b, [node('first', 1, 22), node('last', 23, 44)]),
      file('peer.ts', body('peer', 6), [node('peer', 1, 8)])], 2400, 700);
    expect(out).toContain('END_first'); expect(out).toContain('END_last'); expect(out).toContain('END_peer');
    expect(out.length).toBeLessThanOrEqual(2400);
  });
  it('cannot let an oversize first function consume a peer reservation', () => {
    const out = render([file('large.ts', body('huge', 120), [node('huge', 1, 122)]),
      file('peer.ts', body('peer', 8), [node('peer', 1, 10)])], 1600, 600);
    expect(out).toContain('END_peer'); expect(out).toContain('partial body');
    expect(out).not.toContain('END_huge'); expect(out).toContain('remaining body is omitted');
    expect(out.length).toBeLessThanOrEqual(1600);
  });
  it('reports missing bodies rather than treating a signature as complete', () => {
    const out = render([file('only.ts', body('large', 100), [node('large', 1, 102)])], 650, 400);
    expect(out).toContain('not fully shown'); expect(out).toContain('only.ts:1-102');
    expect(out).not.toContain('END_large');
  });
  it('deduplicates overlapping selected spans without swallowing a gap', () => {
    const out = render([file('nested.ts', 'outer {\ninner {\nline;\n}\n}\nNOT_SELECTED\nend;',
      [node('outer', 1, 5), node('inner', 2, 4), node('end', 7, 7)])]);
    expect(out.match(/3\tline;/g)).toHaveLength(1);
    expect(out).not.toContain('NOT_SELECTED'); expect(out).toContain('... (gap) ...');
  });
  it('keeps skeleton bodies out while preserving useful signatures', () => {
    const f = file('sibling.ts', body('handle', 8), [node('handle', 1, 10)]);
    f.skeleton = true; f.bodyAllowed = () => false;
    const out = render([f]); expect(out).toContain('skeleton (signatures only');
    expect(out).not.toContain('step_handle');
  });
  it('honors maxFiles and does not advertise omitted-file bodies as shown', () => {
    const out = render(['a', 'b', 'c'].map(n => file(n + '.ts', body(n, 2), [node(n, 1, 4)])), 2000, 700, 2);
    expect(out.match(/^#### /gm)).toHaveLength(2); expect(out).not.toContain('END_c'); expect(out).toContain('c.ts:1-4');
  });
  it('accounts for long paths, fences and enabled line numbers exactly', () => {
    const out = render([file('path/'.repeat(30) + 'file.ts', body('budget', 15), [node('budget', 1, 17)])], 520, 500);
    expect(out.length).toBeLessThanOrEqual(520);
    expect(out.match(/^```/gm)?.length ?? 0).toBe(2);
  });
  it('can omit line numbers without changing the selected complete body', () => {
    const out = render([file('plain.ts', body('plain', 3), [node('plain', 1, 5)])], 1000, 700, 12, false);
    expect(out).toContain('END_plain'); expect(out).not.toMatch(/\n\d+\t/);
  });
  it('rejects invalid source ranges instead of claiming nonexistent source', () => {
    const out = render([file('invalid.ts', 'one line', [node('missing', 10, 20)])]);
    expect(out).not.toContain('#### invalid.ts');
  });
  it('retains multiline non-container source rather than treating it as a type outline', () => {
    const out = render([file('settings.ts', 'const settings = {\n  enabled: true,\n};', [node('settings', 1, 3, 'constant')])]);
    expect(out).toContain('2\t  enabled: true,'); expect(out).toContain('3\t};');
  });
  it('does not starve a compact member group after admitting larger implementation groups', () => {
    const compact = [body('predicateA', 2), body('predicateB', 2), body('predicateC', 2)].join('\n');
    const small = file('rules.h', compact, [node('predicateA', 1, 4), node('predicateB', 5, 8), node('predicateC', 9, 12)]);
    small.priority = () => 2;
    const big = file('impl.cpp', body('first', 18) + '\n' + body('extra', 18), [node('first', 1, 20), node('extra', 21, 40)]);
    big.priority = () => 2; big.connectivity = () => 20;
    const out = render([big, small], 1300, 700);
    expect(out).toContain('END_predicateA'); expect(out).toContain('END_predicateB'); expect(out).toContain('END_predicateC');
    expect(out.length).toBeLessThanOrEqual(1300);
  });
  it('does not fund an ordinary neighbor before completing explicitly named bodies', () => {
    const primary = file('primary.cpp', [body('a', 20), body('b', 20), body('c', 20)].join('\n'),
      [node('a', 1, 22), node('b', 23, 44), node('c', 45, 66)]);
    const neighbor = file('neighbor.cpp', body('noise', 30), [node('noise', 1, 32)], { noise: 4 });
    const out = render([primary, neighbor], 2200, 950);
    expect(out).toContain('END_a'); expect(out).toContain('END_b'); expect(out).toContain('END_c');
    expect(out.length).toBeLessThanOrEqual(2200);
  });
});

describe('P1 on real C++ declarations and out-of-line definitions', () => {
  let root: string, cg: CodeGraph;
  beforeAll(async () => {
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-selection-p1-'));
    fs.writeFileSync(path.join(root, 'base.h'), 'namespace sample { class ArchiveBase { public: virtual int run() = 0; }; }');
    fs.writeFileSync(path.join(root, 'job.h'), '#include "base.h"\nnamespace sample { class ArchiveJob : public ArchiveBase { public: virtual int run() override; int stage(); int flush(); int spare(); }; }');
    fs.writeFileSync(path.join(root, 'client.cpp'), '#include "job.h"\nint drive(sample::ArchiveJob &job) { return job.run() + 141; }');
    const fn = (name: string, count: number, tail: string) => `int ArchiveJob::${name}() {\n  int value = ${name === 'run' ? 'config->archive_batch_limit' : '0'};\n`
      + Array.from({ length: count }, (_, i) => `  value += ${i}; // ${name}_${i}`).join('\n') + `\n  ${tail}\n}\n`;
    fs.writeFileSync(path.join(root, 'job.cpp'), '#include "job.h"\nusing namespace sample;\n'
      + fn('run', 20, 'return stage();') + fn('stage', 70, 'return flush();')
      + fn('spare', 350, 'return -1;') + fn('flush', 80, 'return value + 913;'));
    cg = CodeGraph.initSync(root, { config: { include: ['**/*.cpp', '**/*.h'], exclude: [] } });
    await cg.indexAll();
    // Pin the real source call in the fixture graph: this test exercises
    // selection/gating, independently of C++ parameter receiver resolution.
    const driver = cg.getNodesInFile('client.cpp').find(n => n.name === 'drive')!;
    const run = cg.getNodesInFile('job.cpp').find(n => n.name === 'run')!;
    (cg as unknown as { queries: QueryBuilder }).queries.insertEdge({ source: driver.id, target: run.id, kind: 'calls', line: 2 });
  });
  afterAll(() => { cg?.close(); fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  it('preserves type-member priority when the owner was reached through a literal hit', async () => {
    const r = await retrieveExploreContext(cg, 'archive_batch_limit');
    expect(r.evidence).toBeDefined();
    const flush = [...r.graph.nodes.values()].find(n => n.name === 'flush' && !n.isDeclaration)!;
    expect(flush).toBeDefined(); expect(r.memberNodeIds.has(flush.id)).toBe(true);
  });
  it('retains virtual contract evidence across declaration-to-definition merging', async () => {
    const r = await retrieveExploreContext(cg, 'ArchiveJob');
    const run = [...r.graph.nodes.values()].find(n => n.name === 'run' && n.filePath === 'job.cpp')!;
    expect(run).toBeDefined(); expect(r.contractMemberIds.has(run.id)).toBe(true);
  });
  it('follows a merged virtual entry to its out-of-line processing member', async () => {
    const r = await retrieveExploreContext(cg, 'ArchiveJob');
    const processing = findEntryProcessingNodes(r.graph, r.memberNodeIds, r.contractMemberIds);
    const stage = [...r.graph.nodes.values()].find(n => n.name === 'stage' && n.filePath === 'job.cpp')!;
    const spare = [...r.graph.nodes.values()].find(n => n.name === 'spare' && n.filePath === 'job.cpp')!;
    expect(processing.has(stage.id)).toBe(true);
    expect(processing.has(spare.id)).toBe(false);
  });
  it('does not prune source-proven member definitions with low random-walk mass', async () => {
    const handler = new ToolHandler(cg);
    const weights = new Map(['job.h', 'base.h', 'job.cpp', 'client.cpp'].flatMap(f =>
      cg.getNodesInFile(f).map(n => [n.id, f.endsWith('.cpp') ? 0 : 1] as const)));
    vi.spyOn(handler as any, 'computeGraphRelevance').mockReturnValue(weights);
    const result = await handler.execute('explore', { query: 'ArchiveJob', maxFiles: 12 });
    const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    expect(text).toContain('return value + 913;');
    expect(text).toContain('return job.run() + 141;');
  });
  for (const query of ['ArchiveJob', 'ArchiveJob run stage flush']) {
    it(`delivers complete mechanism bodies for ${query}`, async () => {
      const result = await new ToolHandler(cg).execute('explore', { query, maxFiles: 12 });
      const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      const lines = fs.readFileSync(path.join(root, 'job.cpp'), 'utf8').split('\n');
      for (const name of ['run', 'stage', 'flush']) {
        const n = cg.getNodesInFile('job.cpp').find(n => n.name === name && !n.isDeclaration)!;
        expect(n).toBeDefined();
        for (let i = n.startLine; i <= n.endLine; i++) expect(text).toContain(`${i}\t${lines[i - 1]}`);
      }
      expect(text.length).toBeLessThanOrEqual(13000);
      expect(text).not.toContain('349; // spare_349');
    });
  }
});
