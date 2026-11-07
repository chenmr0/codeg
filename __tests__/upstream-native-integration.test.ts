
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
import { ExploreSessionState } from '../src/upstream-explore/mcp/explore-session-state';

let root: string;
const opened: CodeGraph[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-upstream-adapter-'));
  vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
  vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,node,search,context');
});
afterEach(() => {
  for (const cg of opened.splice(0)) cg.close();
  fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});
async function index(files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
  const cg = CodeGraph.initSync(root); opened.push(cg); await cg.indexAll(); return cg;
}
describe('official Explore hosted on the native graph', () => {
  it('retains C++ declarations, definitions, macros and defines edges without rewriting the graph', async () => {
    const cg = await index({
      'worker.h': '#define LIMIT 4\nclass Worker { public: int run(int value); };\n',
      'worker.cpp': '#include "worker.h"\nint Worker::run(int value) { return value + LIMIT; }\n',
    });
    const api = createUpstreamExploreGraph(cg);
    const nodes = api.getNodesByName('run');
    expect(nodes.some(n => n.isDeclaration)).toBe(true);
    expect(nodes.some(n => !n.isDeclaration && n.filePath === 'worker.cpp')).toBe(true);
    expect(api.getNodesByName('LIMIT').some(n => n.kind === 'macro')).toBe(true);
    expect(nodes.flatMap(n => api.getOutgoingEdges(n.id)).some(e => e.kind === 'defines')).toBe(true);
    const before = cg.getStats();
    const result = await new ToolHandler(cg).execute('explore', { query: 'Worker run', maxFiles: 2 });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('worker.cpp');
    const after = cg.getStats();
    expect([after.nodeCount, after.edgeCount]).toEqual([before.nodeCount, before.edgeCount]);
  });
  it('provides segment recall on a read-only legacy index without changing persistent schema or bytes', async () => {
    const cg = await index({ 'service.ts': 'export class OrderStateMachine { transit() { return 1; } }\n' });
    cg.close(); opened.splice(opened.indexOf(cg), 1);
    const dbPath = path.join(root, '.codegraph-wx', 'codegraph.db');
    const hash = () => createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
    const before = hash();
    const reader = await CodeGraph.open(root, { readOnly: true, sync: false }); opened.push(reader);
    // TEMP writes are allowed, but the published main database stays fenced
    // by SQLite's read-only connection flag (not a mutable query_only pragma).
    expect(() => reader.getExploreQueryConnection().exec('CREATE TABLE main.forbidden_write (id INTEGER)')).toThrow();
    const api = createUpstreamExploreGraph(reader);
    const found = await api.findRelevantContext('state machine');
    expect([...found.nodes.values()].some(n => n.name === 'OrderStateMachine')).toBe(true);
    const db = reader.getExploreQueryConnection();
    expect(db.prepare("SELECT name FROM main.sqlite_master WHERE name='name_segment_vocab'").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM temp.sqlite_master WHERE name='name_segment_vocab'").get()).toBeTruthy();
    reader.close(); opened.splice(opened.indexOf(reader), 1);
    expect(hash()).toBe(before);
  });
  it('refreshes the TEMP vocabulary after native index changes', async () => {
    const cg = await index({ 'service.ts': 'export class OrderStateMachine { transit() { return 1; } }\n' });
    const api = createUpstreamExploreGraph(cg);
    await api.findRelevantContext('state machine');
    fs.writeFileSync(path.join(root, 'second.ts'), 'export class PurchaseLedgerStore { save() { return 2; } }\n');
    await cg.indexAll();
    const found = await createUpstreamExploreGraph(cg).findRelevantContext('purchase ledger');
    expect([...found.nodes.values()].some(n => n.name === 'PurchaseLedgerStore')).toBe(true);
  });
  it('routes natural-language queries and keeps session emission metadata off the wire', async () => {
    const cg = await index({ 'service.ts': 'export function loadOrder() { return saveOrder(); }\nfunction saveOrder() { return 1; }\n' });
    const session = new ExploreSessionState();
    const result = await new ToolHandler(cg).execute('explore',
      { query: '解释 loadOrder saveOrder 的调用关系', maxFiles: 2 },
      { exploreSession: session });
    expect(result.isError).not.toBe(true);
    expect(session.callCount(root)).toBe(1);
    expect(result).not.toHaveProperty('_cgExploreEmission');
    expect(result).not.toHaveProperty('_cgAnswerFiles');
  });
});

