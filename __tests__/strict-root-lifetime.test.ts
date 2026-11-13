/** Real indexes + production session/engine, controlled transport; build first. */
import { afterEach, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../dist';
import { MCPSession } from '../dist/mcp/session';
import { MCPEngine } from '../dist/mcp/engine';
let base: string | undefined, engine: MCPEngine | undefined;
afterEach(async () => { if (engine) { await engine.stopAndDrain(); } if (base) fs.rmSync(base, { force: true, recursive: true }); });
it.each(['unopened-index', 'opened-index', 'replaced-root'])('never discovers another project after %s', async mode => {
  const opened = mode === 'opened-index';
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-root-life-'));
  const b = path.join(base, 'outer'), a = path.join(b, 'inner'); fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(b, 'b.c'), 'int betaPrivate(void) { return 1; }\n');
  fs.writeFileSync(path.join(a, 'a.c'), 'int alphaOnly(void) { return 2; }\n');
  for (const root of [b, a]) { const cg = CodeGraph.initSync(root); await cg.indexAll(); await cg.whenIdle(); cg.close(); await cg.whenIdle(); }
  engine = new MCPEngine({ watch: false });
  const replies: any[] = [];
  const transport = { stop() {}, sendResult: (id: number, result: unknown) => replies.push({ id, result }), sendError: (id: number, code: number, message: string) => replies.push({ id, error: { code, message } }) };
  const session = new MCPSession(transport as any, engine, { explicitProjectPath: a, restrictProject: true });
  if (opened) await engine.ensureInitialized(a, true);
  // Close the engine's background sync before the directory move.
  if (opened) await engine.getToolHandler().whenIdle();
  if (mode === 'replaced-root') {
    fs.renameSync(a, path.join(base, 'saved-root'));
    fs.symlinkSync(b, a, process.platform === 'win32' ? 'junction' : 'dir');
  } else fs.renameSync(path.join(a, '.codegraph-wx'), path.join(base, 'saved-index'));
  await (session as any).handleMessage({ id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'betaPrivate' } } });
  const result = JSON.stringify(replies);
  expect(result).not.toContain('b.c');
  expect(result).not.toContain('int betaPrivate');
  session.stop();
}, 20000);
