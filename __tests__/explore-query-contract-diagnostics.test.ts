import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import CodeGraph from '../src/index';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
import { ToolHandler } from '../src/upstream-explore/mcp/tools';
import { ExploreDiagnostics } from '../src/upstream-explore/mcp/explore-diagnostics';
import { QueryContractTrace } from '../src/upstream-explore/mcp/query-contract-trace';
import { parseExploreQuery } from '../src/upstream-explore/search/query-intent';
import type { Node } from '../src/upstream-explore/types';

const roots: string[] = [], graphs: CodeGraph[] = [];
afterEach(async () => {
  for (const cg of graphs.splice(0)) { await cg.whenIdle(); cg.close(); await cg.whenIdle(); }
  for (const root of roots.splice(0)) {
    const allowed = fs.realpathSync(path.resolve(__dirname, '../../fixtures')).toLowerCase() + path.sep;
    expect(fs.realpathSync(root).toLowerCase().startsWith(allowed)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
const node = (id: string, extra: Partial<Node> = {}): Node => ({ id, name: id, qualifiedName: id, kind: 'function', language: 'cpp',
  filePath: 'src/tasks.cpp', startLine: 2, endLine: 5, startColumn: 0, endColumn: 0, updatedAt: 0, ...extra });
const file = (extra = {}) => ({ path: 'src/tasks.cpp', rank: 0, allowance: 100, render: 'focused', skipped: null, clipped: true, finalChars: 30, ...extra });

describe('query contract diagnostic observations', () => {
  it('is absent unless the existing debug sink is enabled', () => {
    vi.stubEnv('CODEGRAPH_EXPLORE_DEBUG', '0');
    expect(ExploreDiagnostics.start('Worker run', '.', { maxOutputChars: 100, maxCharsPerFile: 100 }, 1, 2)).toBeNull();
  });
  it('separates discovery, admitted identity and final indexed-range coverage', () => {
    const intent = parseExploreQuery('检查 `Task::run`，新增字段 `run_reason`。');
    const trace = new QueryContractTrace(intent), decl = node('decl', { isDeclaration: true, endLine: 2 }), def = node('def');
    trace.gather([decl]); trace.candidates('Task::run', [decl], [def], [def]);
    trace.selection([decl, def], new Map([['decl', 'def']]), new Set(['def']), new Set(['def']), new Set(['def']));
    trace.checkpoint('gather');
    const report: any = trace.finish('**`src/tasks.cpp`**\n```cpp\n2\tvoid run() {\n3\t  work();\n```', [file()], new Map());
    const d = report.entities.find((n: any) => n.id === 'def');
    expect(d).toMatchObject({ gathered: false, admitted: true, named: true, exact: true, flow: true, shownLines: 2,
      shownRanges: [{ start: 2, end: 3 }], indexedRangeCovered: false, reason: 'partial-source-window', semanticEvidenceAssessed: false });
    expect(report.entities.find((n: any) => n.id === 'decl')).toMatchObject({ gathered: true, canonicalId: 'def', identityStatus: 'paired-in-gather' });
    expect(report.version).toBe(2);
    expect(report.namedTokens).toContain('run_reason');
    expect(report.mentions.find((m: any) => m.normalized === 'run_reason')).toMatchObject({ kind: 'symbol', quoted: true });
    expect(report.mentions.every((m: any) => !('intent' in m))).toBe(true);
    expect(report.timings.map((t: any) => t.stage)).toEqual(['gather', 'render-and-finalize']);
    expect(report.timedMilliseconds).toBeGreaterThanOrEqual(0);
  });
  it('does not mistake output text outside source fences for delivered evidence', () => {
    const trace = new QueryContractTrace(parseExploreQuery('TaskRun'));
    trace.gather([node('TaskRun')]);
    trace.selection([node('TaskRun')], new Map(), new Set(), new Set(), new Set());
    const report: any = trace.finish('2\tthis is prose\n**`src/tasks.cpp`**\nNo source emitted.', [file({ finalChars: 0 })], new Map());
    expect(report.entities[0]).toMatchObject({ shownLines: null, reason: 'no-source-in-final-output' });
  });
  it('labels unnumbered render ranges and refuses clipped unnumbered coverage claims', () => {
    for (const clipped of [false, true]) {
      const trace = new QueryContractTrace(parseExploreQuery('TaskRun')); trace.gather([node('TaskRun')]);
      trace.selection([node('TaskRun')], new Map(), new Set(), new Set(), new Set());
      const report: any = trace.finish('**`src/tasks.cpp`**\n```cpp\nvoid run() {}\n```', [file({ clipped })], new Map([['src/tasks.cpp', [{ start: 2, end: 5 }]]]));
      expect(report.entities[0].sourceEvidence).toBe(clipped ? 'coverage-unavailable' : 'render-records-unclipped-file');
      expect(report.entities[0].indexedRangeCovered).toBe(clipped ? null : true);
    }
  });
  it('bounds candidates and entities and keeps requests isolated', () => {
    const trace = new QueryContractTrace(parseExploreQuery('TaskRun'));
    const nodes = Array.from({ length: 700 }, (_, i) => node('n' + i)); trace.gather(nodes);
    trace.candidates('TaskRun', nodes, nodes, nodes.slice(0, 3));
    const report: any = trace.finish('', [], new Map());
    expect(report.entities).toHaveLength(512); expect(report.truncated.entityLimit).toBeGreaterThan(0);
    expect(report.resolutions[0].rawIds).toHaveLength(8); expect(report.truncated.candidateLimit).toBeGreaterThan(0);
    expect((new QueryContractTrace(parseExploreQuery('Other')).finish('', [], new Map()) as any).entities).toEqual([]);
  });
  it('inspects only bounded candidate prefixes and counts discarded observations without a global unique set', () => {
    const trace = new QueryContractTrace(parseExploreQuery('TaskRun'));
    const prefix = Array.from({ length: 8 }, (_, i) => node('picked' + i));
    const huge = new Proxy(prefix, {
      get(target, key, receiver) {
        if (key === 'length') return 1_000_000;
        if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) >= 8) throw new Error('unbounded diagnostic traversal');
        return Reflect.get(target, key, receiver);
      },
    });
    trace.candidates('TaskRun', huge, huge, huge);
    const report: any = trace.finish('', [], new Map());
    expect(report.entities).toHaveLength(8);
    expect(report.entities.every((entity: any) => entity.admitted)).toBe(true);
    expect(report.resolutions[0]).toMatchObject({ rawCount: 1_000_000, eligibleCount: 1_000_000, pickedCount: 1_000_000,
      omittedCandidates: 1_999_992 });
    expect(report.truncated.candidateLimit).toBe(1_999_992);
    expect(report.truncationCountUnit).toContain('not necessarily distinct entities');
  });
  it('bounds normalized omissions and named token lengths and counts', () => {
    const intent = parseExploreQuery('TaskRun'), longName = 'A'.repeat(10_000);
    intent.symbolTokens = Array.from({ length: 200 }, () => longName);
    intent.omitted = [{ normalized: longName, reason: 'named-token-limit' }];
    const report: any = new QueryContractTrace(intent).finish('', [], new Map());
    expect(report.namedTokens).toHaveLength(128);
    expect(report.namedTokens.every((token: string) => token.length === 160)).toBe(true);
    expect(report.omitted[0].normalized).toHaveLength(320);
    expect(report.truncated.namedTokens).toBe(72);
  });
  it('measures an awaited interval rather than just Promise creation', async () => {
    const trace = new QueryContractTrace(parseExploreQuery('TaskRun'));
    await new Promise(resolve => setTimeout(resolve, 20)); trace.checkpoint('async-gather');
    const report: any = trace.finish('', [], new Map());
    expect(report.timings[0].milliseconds).toBeGreaterThanOrEqual(10);
    expect(report.timings.reduce((sum: number, t: any) => sum + t.milliseconds, 0)).toBe(report.timedMilliseconds);
  });

  it.each([
    '检查 `runJob` 与 `flushJob`，以及 `src/jobs.ts`。',
    '拟新增诊断字段 `runJob`、`flushJob`；路径 `src/jobs.ts`。',
    'Proposed fields: `runJob`, `flushJob`; file `src/jobs.ts`.',
  ])('keeps lexical names and byte-identical off/on handler output: %s', async query => {
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1'); vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
    vi.stubEnv('CODEGRAPH_EXPLORE_LINENUMS', '1'); vi.stubEnv('CODEGRAPH_EXPLORE_DEDUP', '0');
    const fixtures = path.resolve(__dirname, '../../fixtures'); fs.mkdirSync(fixtures, { recursive: true });
    const root = fs.mkdtempSync(path.join(fixtures, 'cg-query-contract-')); roots.push(root);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/jobs.ts'), 'export function flushJob() { return 7; }\nexport function runJob() { return flushJob(); }\n');
    const cg = CodeGraph.initSync(root); graphs.push(cg); await cg.indexAll();
    const graph = createUpstreamExploreGraph(cg), handler = new ToolHandler(graph);
    const gather = vi.spyOn(graph, 'findRelevantContext');
    const nameLookup = vi.spyOn(graph, 'getNodesByName');
    vi.stubEnv('CODEGRAPH_EXPLORE_DEBUG', '0');
    const off = await handler.execute('codegraph_explore', { query, maxFiles: 2 });
    const lookupsOff = nameLookup.mock.calls.length; nameLookup.mockClear();
    const sidecar = path.join(root, 'trace.jsonl'); vi.stubEnv('CODEGRAPH_EXPLORE_DEBUG', sidecar);
    const on = await handler.execute('codegraph_explore', { query, maxFiles: 2 });
    const text = (result: any) => result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    expect(on.isError).not.toBe(true); expect(text(on)).toBe(text(off));
    expect(nameLookup.mock.calls.length).toBe(lookupsOff);
    const report = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    expect(report.queryContract.namedTokens).toEqual(expect.arrayContaining(['runJob', 'flushJob']));
    expect(report.queryContract.version).toBe(2);
    expect(report.queryContract.entities.some((e: any) => e.name === 'runJob' && e.named)).toBe(true);
    expect(report.queryContract.pinnedFiles).toContain('src/jobs.ts');
    expect(report.queryContract.entities.some((e: any) => e.name === 'runJob' && e.shownLines > 0)).toBe(true);
    expect(gather.mock.calls[1]![1]!.queryIntent).toBeDefined();
    expect(report.queryContract.timings.some((t: any) => t.stage === 'context-gather')).toBe(true);
    expect(text(on)).not.toContain('queryContract');
  });

  it('reports the canonical definition that receives Flow source priority when the narrative uses a declaration', async () => {
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1'); vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
    vi.stubEnv('CODEGRAPH_EXPLORE_LINENUMS', '1'); vi.stubEnv('CODEGRAPH_EXPLORE_DEDUP', '0');
    const fixtures = path.resolve(__dirname, '../../fixtures'); fs.mkdirSync(fixtures, { recursive: true });
    const root = fs.mkdtempSync(path.join(fixtures, 'cg-query-contract-flow-')); roots.push(root);
    fs.writeFileSync(path.join(root, 'worker.hpp'), 'class Worker { public: int runJob(int value); };\n');
    fs.writeFileSync(path.join(root, 'worker.cpp'), '#include "worker.hpp"\nint Worker::runJob(int value) {\n  return value + 17;\n}\n');
    const cg = CodeGraph.initSync(root); graphs.push(cg); await cg.indexAll();
    const graph = createUpstreamExploreGraph(cg), handler = new ToolHandler(graph);
    const nodes = graph.getNodesByName('runJob');
    const decl = nodes.find(n => n.isDeclaration)!, def = nodes.find(n => !n.isDeclaration)!;
    expect(decl).toBeDefined(); expect(def).toBeDefined();
    // Keep indexing, pairing, ranking and rendering real. Control only the
    // narrative identity to exercise the diagnostic hook's normalization order.
    vi.spyOn(handler as any, 'buildFlowFromNamedSymbols').mockImplementation(() => ({
      text: '', pathNodeIds: new Set([decl.id]), namedNodeIds: new Set([decl.id]),
      uniqueNamedNodeIds: new Set([decl.id]), spineCallSites: new Map(),
    }));
    const sidecar = path.join(root, 'trace.jsonl'); vi.stubEnv('CODEGRAPH_EXPLORE_DEBUG', sidecar);
    const result = await handler.execute('codegraph_explore', { query: 'Worker runJob', maxFiles: 2 });
    expect(result.isError).not.toBe(true);
    const report = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    const declaration = report.queryContract.entities.find((entity: any) => entity.id === decl.id);
    const definition = report.queryContract.entities.find((entity: any) => entity.id === def.id);
    expect(declaration).toMatchObject({ canonicalId: def.id, flow: false });
    expect(definition).toMatchObject({ flow: true, indexedRangeCovered: true, reason: 'indexed-range-covered' });
    expect(definition.fileAllowance).toBeGreaterThan(0);
    expect(definition.shownLines).toBe(def.endLine - def.startLine + 1);
  });
});
