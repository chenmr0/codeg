import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { SyncDiagnosticsSummary } from '../src/sync/diagnostics-summary';

const roots: string[] = [], graphs: CodeGraph[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-project-sentinel-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'private-source-sentinel.c'), 'int private_symbol_sentinel(void) { return 1; }\n');
  const graph = CodeGraph.initSync(root); graphs.push(graph); await graph.indexAll();
  return { root, graph, internal: graph as any };
}
function number(lines: readonly string[], key: string): number {
  const match = lines.join(' ').match(new RegExp(`\\b${key}=(\\d+)`));
  return match ? Number(match[1]) : 0;
}
function delay(ms: number) { const until = performance.now() + ms; while (performance.now() < until) { /* deterministic local delay */ } }

describe('anonymous per-sync summary', () => {
  it('renders only finite fixed-key numeric groups with explicit containment', () => {
    const d = new SyncDiagnosticsSummary();
    d.add('store', '/private/path', 10); d.add('store', 'bad', NaN); d.add('store', 'negative', -1);
    d.add('store', 'readMs', 12); d.add('store', 'readMs', 3);
    const lines = d.lines('success');
    expect(lines).toHaveLength(8);
    expect(lines.join('\n')).toContain('readMs=15');
    expect(lines.join('\n')).not.toMatch(/private|NaN|negative/);
    expect(lines.at(-1)).toContain('inclusiveNestedNotAdditive');
  });
  it('keeps default sync silent and emits no path/symbol when opted in without verbose', async () => {
    const { graph, root } = await fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await graph.sync();
    expect(log.mock.calls.flat().some(x => String(x).startsWith('[sync-summary]'))).toBe(false);
    let lines: readonly string[] = [];
    const result = await graph.sync({ diagnosticsSummary: value => { lines = value; } });
    expect(result.filesModified).toBe(0); expect(lines).toHaveLength(8);
    expect(lines[0]).toContain('outcome=success');
    expect(lines.join('\n')).not.toContain(root);
    expect(lines.join('\n')).not.toMatch(/private-project|private-source|private_symbol/);
    expect(number(lines, 'rpcWallMs')).toBe(0);
  });
  it('resets counters between calls and records deferred-journal time inside resolve wall', async () => {
    const { graph, root, internal } = await fixture();
    fs.writeFileSync(path.join(root, 'private-source-sentinel.c'), 'int callee(void){return 1;}\nint private_symbol_sentinel(void){ return callee(); }\n');
    const original = internal.queries.journalDeferredConformanceReferences.bind(internal.queries);
    vi.spyOn(internal.queries, 'journalDeferredConformanceReferences').mockImplementation((...args: any[]) => { delay(20); return original(...args); });
    let first: readonly string[] = [], second: readonly string[] = [];
    await graph.sync({ diagnosticsSummary: lines => { first = lines; } });
    expect(number(first, 'changedRefsDetailJournalDeferredMs')).toBeGreaterThanOrEqual(18);
    expect(number(first, 'changedRefsResolveMs')).toBeGreaterThanOrEqual(number(first, 'changedRefsDetailJournalDeferredMs') - 1);
    await graph.sync({ diagnosticsSummary: lines => { second = lines; } });
    expect(number(second, 'changedRefsDetailJournalDeferredMs')).toBe(0);
  });
  it('emits once on error, omits error text and does not let the sink replace the original exception', async () => {
    const { graph, internal } = await fixture();
    const originalError = new Error('private-source-sentinel.c private_symbol_sentinel');
    vi.spyOn(internal.orchestrator, 'sync').mockRejectedValueOnce(originalError);
    let calls = 0, lines: readonly string[] = [];
    await expect(graph.sync({ diagnosticsSummary: value => { calls++; lines = value; throw new Error('sink failed'); } })).rejects.toBe(originalError);
    expect(calls).toBe(1); expect(lines[0]).toContain('outcome=error');
    expect(lines.join('\n')).not.toMatch(/private-source|private_symbol|sink failed/);
  });
  it('does not turn a successful sync into failure when the sink throws', async () => {
    const { graph } = await fixture();
    await expect(graph.sync({ diagnosticsSummary: () => { throw new Error('sink'); } })).resolves.toMatchObject({ filesModified: 0 });
  });
  it('reports lock-unavailable without changing the watcher sentinel', async () => {
    const { graph, internal } = await fixture();
    vi.spyOn(internal.fileLock, 'acquire').mockImplementation(() => { throw new Error('busy'); });
    let lines: readonly string[] = [];
    expect(await graph.sync({ diagnosticsSummary: value => { lines = value; } })).toMatchObject({ durationMs: 0, nodesUpdated: 0 });
    expect(lines[0]).toContain('outcome=lockUnavailable');
  });
});
