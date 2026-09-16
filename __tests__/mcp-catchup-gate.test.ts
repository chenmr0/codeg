/**
 * MCP catch-up interaction budget — concurrent tool calls share one bounded
 * wait for the engine's post-open filesystem reconcile. Fast catch-up stays
 * strongly consistent; slow catch-up continues in the background while every
 * released response carries an explicit project-wide stale warning.
 *
 * Background: `MCPEngine.catchUpSync()` fires `cg.sync()` in the background.
 * Before this fix it was fire-and-forget — a tool call could race past it
 * and return rows for files that no longer exist on disk. The per-file
 * staleness banner (`withStalenessNotice`) couldn't help, because
 * `getPendingFiles()` is populated by the watcher, not by catch-up.
 *
 * `catchUpSync()` pushes its promise into the `ToolHandler` via
 * `setCatchUpGate(p)`. These tests exercise the shared gate directly,
 * including completion, timeout, concurrency, and failure semantics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import {
  MCP_CATCH_UP_DEFAULT_BUDGET_MS,
  resolveMcpCatchUpBudgetMs,
  ToolHandler,
} from '../src/mcp/tools';

describe('MCP catch-up gate', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-catchup-gate-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(
      path.join(testDir, 'src', 'survivor.ts'),
      'export function survivor() { return 1; }\n',
    );
    fs.writeFileSync(
      path.join(testDir, 'src', 'deleted-later.ts'),
      'export function deletedLater() { return 2; }\n',
    );

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    try { handler.closeAll(); } catch { /* ignore */ }
    try { cg.unwatch(); } catch { /* ignore */ }
    try { cg.close(); } catch { /* ignore */ }
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('awaits the gate before serving the first tool call', async () => {
    let gateResolved = false;
    const gate = new Promise<void>((resolve) => {
      setTimeout(() => { gateResolved = true; resolve(); }, 80);
    });
    handler.setCatchUpGate(gate);

    const res = await handler.execute('search', { query: 'survivor' });
    expect(gateResolved).toBe(true);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/survivor/);
    expect(res.content[0].text).not.toMatch(/index refresh/i);
  });

  it('clears the shared gate after catch-up completes', async () => {
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
    handler.setCatchUpGate(gate, 1_000);

    const first = handler.execute('search', { query: 'survivor' });
    resolveGate();
    expect((await first).content[0].text).not.toMatch(/index refresh/i);

    const second = await handler.execute('search', { query: 'survivor' });
    expect(second.content[0].text).not.toMatch(/index refresh/i);
  });

  it('keeps every concurrent request behind the same gate until completion', async () => {
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
    handler.setCatchUpGate(gate, 1_000);

    let firstDone = false;
    let secondDone = false;
    const first = handler.execute('search', { query: 'survivor' })
      .then((result) => { firstDone = true; return result; });
    const second = handler.execute('search', { query: 'survivor' })
      .then((result) => { secondDone = true; return result; });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);

    resolveGate();
    const results = await Promise.all([first, second]);
    expect(results.every((result) => !/index refresh/i.test(result.content[0].text))).toBe(true);
  });

  it('releases after the budget, warns, and lets catch-up continue in background', async () => {
    let resolveGate!: () => void;
    let gateCompleted = false;
    const gate = new Promise<void>((resolve) => {
      resolveGate = () => { gateCompleted = true; resolve(); };
    });
    handler.setCatchUpGate(gate, 0);

    const stale = await handler.execute('search', { query: 'survivor' });
    expect(gateCompleted).toBe(false);
    expect(stale.isError).toBeFalsy();
    expect(stale.content[0].text).toContain(
      '⚠️ Index refresh is still running; results for recently changed files may be stale.',
    );
    expect(stale.content[0].text).not.toMatch(
      /interaction budget|elapsed|retry this query|codegraph sync|codegraph_wx_status|provisional/i,
    );
    expect(stale.content[0].text).toMatch(/survivor/);

    resolveGate();
    await gate;
    const fresh = await handler.execute('search', { query: 'survivor' });
    expect(gateCompleted).toBe(true);
    expect(fresh.content[0].text).not.toMatch(/index refresh/i);
  });

  it('catch-up reconciles a deleted file before the first tool call sees it', async () => {
    // Simulate the empty-project / deleted-files startup case: file is in
    // the DB (we indexed it above) but vanishes from disk before the MCP
    // server's first query. The catch-up sync, awaited via the gate,
    // must remove the row so the first tool call returns no hit.
    fs.unlinkSync(path.join(testDir, 'src', 'deleted-later.ts'));

    // Push the actual catch-up sync as the gate — same flow the MCP engine
    // uses (`cg.sync()` returns a Promise<SyncResult>, the wrapper voids it).
    handler.setCatchUpGate(cg.sync().then(() => undefined));

    const res = await handler.execute('search', { query: 'deletedLater' });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).not.toMatch(/src\/deleted-later\.ts/);
  });

  it('catch-up that converges the project to 0 files clears all rows', async () => {
    // Worst case: every source file is gone between sessions. Without the
    // gate, the first tool call serves whatever was in the DB. With the
    // gate + the orchestrator's filesystem reconcile, the DB drains.
    fs.unlinkSync(path.join(testDir, 'src', 'survivor.ts'));
    fs.unlinkSync(path.join(testDir, 'src', 'deleted-later.ts'));

    handler.setCatchUpGate(cg.sync().then(() => undefined));

    const res = await handler.execute('search', { query: 'survivor' });
    expect(res.isError).toBeFalsy();
    expect(cg.getStats().fileCount).toBe(0);
  });

  it('a rejected catch-up stays visible without breaking tool calls', async () => {
    // A catch-up sync failure (lock contention, transient FS error) must
    // not poison tool dispatch, but the old index must not be presented as fresh.
    handler.setCatchUpGate(Promise.reject(new Error('simulated sync failure')));

    const res = await handler.execute('search', { query: 'survivor' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain(
      '⚠️ Startup index refresh was incomplete; results for recently changed files may be stale.',
    );
    expect(res.content[0].text).not.toContain('simulated sync failure');
    expect(res.content[0].text).not.toMatch(/codegraph sync|codegraph_wx_status|retry/i);
    expect(res.content[0].text).toMatch(/survivor/);

    const status = await handler.execute('status', {});
    expect(status.content[0].text).toMatch(/startup index refresh was incomplete/i);
    expect(status.content[0].text).toContain('simulated sync failure');

    // A later retry generation replaces the conservative failure state.
    handler.setCatchUpGate(Promise.resolve());
    const recovered = await handler.execute('search', { query: 'survivor' });
    expect(recovered.content[0].text).not.toMatch(/index refresh/i);
  });

  it('validates the environment budget and permits an explicit zero budget', () => {
    expect(resolveMcpCatchUpBudgetMs(undefined)).toBe(MCP_CATCH_UP_DEFAULT_BUDGET_MS);
    expect(resolveMcpCatchUpBudgetMs('')).toBe(MCP_CATCH_UP_DEFAULT_BUDGET_MS);
    expect(resolveMcpCatchUpBudgetMs('invalid')).toBe(MCP_CATCH_UP_DEFAULT_BUDGET_MS);
    expect(resolveMcpCatchUpBudgetMs('-1')).toBe(MCP_CATCH_UP_DEFAULT_BUDGET_MS);
    expect(resolveMcpCatchUpBudgetMs('60001')).toBe(MCP_CATCH_UP_DEFAULT_BUDGET_MS);
    expect(resolveMcpCatchUpBudgetMs('0')).toBe(0);
    expect(resolveMcpCatchUpBudgetMs('2500')).toBe(2_500);
  });
});
