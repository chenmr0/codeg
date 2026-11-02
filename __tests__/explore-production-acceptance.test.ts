/** Independent acceptance: native graph -> production ToolHandler (not the oracle facade).
 * These storage tests use native SQLite. Real WASM SQL equivalence is separately
 * covered by explore-dominant-aggregation / explore-query-cache; no WASM claim here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { ExploreSessionState } from '../src/upstream-explore/mcp/explore-session-state';
import { PortableCoordinator } from '../src/sync/portable/protocol';
import { getCodeGraphDir } from '../src/directory';

const roots: string[] = [], graphs: CodeGraph[] = [], handlers: ToolHandler[] = [];
function directory() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-production-')); roots.push(root); return root; }
async function fixture(body = 'export function acceptanceEntry(value: number) { return acceptanceLeaf(value); }\nexport function acceptanceLeaf(value: number) { return value + 731; }\n') {
  const root = directory(); fs.writeFileSync(path.join(root, 'service.ts'), body);
  const graph = CodeGraph.initSync(root); graphs.push(graph); await graph.indexAll();
  const handler = new ToolHandler(graph); handlers.push(handler); return { root, graph, handler };
}
async function answer(handler: ToolHandler, query: string, session?: ExploreSessionState) {
  const result = await handler.execute('explore', { query, maxFiles: 4 }, { exploreSession: session });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result).not.toHaveProperty('_cgExploreEmission');
  expect(result).not.toHaveProperty('_cgAnswerFiles');
  return result.content.map(item => item.text ?? '').join('\n');
}
beforeEach(() => { vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1'); vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,node,search,context'); vi.stubEnv('CODEGRAPH_NO_DAEMON', '1'); });
afterEach(async () => {
  for (const handler of handlers.splice(0)) handler.closeAll();
  for (const graph of graphs.splice(0)) { await graph.whenIdle(); graph.close(); await graph.whenIdle(); }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Explore production entry acceptance', () => {
  it('lists the actual short-name schema and accepts a Chinese flow question', async () => {
    const { handler } = await fixture();
    const tool = handler.getTools().find(tool => tool.name === 'explore')!;
    expect(tool.inputSchema.required).toContain('query');
    expect(tool.inputSchema.properties).toHaveProperty('maxFiles');
    expect(tool.inputSchema.properties!.maxFiles).not.toHaveProperty('default');
    expect(tool.annotations?.readOnlyHint).toBe(true);
    const text = await answer(handler, '解释 acceptanceEntry 调用 acceptanceLeaf 的流程');
    expect(text).toContain('return value + 731;');
    expect(text).toContain('acceptanceLeaf(value)');
    expect(text).toContain('service.ts');
  });

  it('keeps sessions isolated and re-serves changed source to an existing session', async () => {
    const { root, graph, handler } = await fixture();
    const first = new ExploreSessionState(), second = new ExploreSessionState();
    expect(await answer(handler, 'acceptanceLeaf', first)).toContain('return value + 731;');
    await answer(handler, 'acceptanceLeaf', first);
    expect(first.callCount(root)).toBe(2); expect(second.callCount(root)).toBe(0);
    expect(await answer(handler, 'acceptanceLeaf', second)).toContain('return value + 731;');
    fs.writeFileSync(path.join(root, 'service.ts'), 'export function acceptanceLeaf(value: number) { return value + 947; }\n');
    await graph.sync();
    expect(await answer(handler, 'acceptanceLeaf', first)).toContain('return value + 947;');
    expect(first.callCount(root)).toBe(3); expect(second.callCount(root)).toBe(1);
  });

  it('refreshes a warmed handler after sync by an independently opened writer', async () => {
    const { root, handler } = await fixture();
    expect(await answer(handler, 'acceptanceLeaf')).toContain('return value + 731;');
    const writer = await CodeGraph.open(root, { sync: false }); graphs.push(writer);
    fs.writeFileSync(path.join(root, 'service.ts'), 'export function acceptanceReplacement(value: number) { return value + 953; }\n');
    await writer.sync();
    const text = await answer(handler, 'acceptanceReplacement');
    expect(text).toContain('return value + 953;'); expect(text).not.toContain('return value + 731;');
  });

  it('refreshes a warmed handler across real fixed-path candidate publication', async () => {
    const current = await fixture();
    expect(await answer(current.handler, 'acceptanceLeaf')).toContain('return value + 731;');
    const replacement = await fixture('export function publishedAcceptance(value: number) { return value + 997; }\n');
    replacement.graph.close(); await replacement.graph.whenIdle();
    fs.copyFileSync(path.join(replacement.root, 'service.ts'), path.join(current.root, 'service.ts'));
    const coordinator = new PortableCoordinator(getCodeGraphDir(current.root));
    const lease = coordinator.acquireWriter();
    try {
      const candidate = coordinator.beginCandidate();
      fs.copyFileSync(path.join(getCodeGraphDir(replacement.root), 'codegraph.db'), candidate.path);
      await coordinator.publish(candidate);
    } finally { lease.release(); }
    const text = await answer(current.handler, 'publishedAcceptance');
    expect(text).toContain('return value + 997;'); expect(text).not.toContain('return value + 731;');
  });

  it('keeps an oversized named function visible without exceeding the response ceiling', async () => {
    const body = 'export function acceptanceOversize(value: number) {\n' + Array.from({ length: 1600 }, (_, i) => `  value += ${i}; // acceptance detail ${'x'.repeat(70)}\n`).join('') + '  return value;\n}\n';
    const { handler } = await fixture(body);
    const text = await answer(handler, 'acceptanceOversize');
    expect(text).toContain('export function acceptanceOversize');
    expect(text.length).toBeLessThanOrEqual(25000);
    expect(text).toMatch(/omitt|truncat|partial|remaining|more|cut|shown/i);
  });
});
