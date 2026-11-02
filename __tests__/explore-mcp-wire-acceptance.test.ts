/** Real CLI -> stdio MCP -> production query dispatch. Run `npm run build`
 * before this suite, as for the existing mcp-initialize integration suite.
 * Native backend only; this does not claim daemon or Windows/WASM validation.
 */
import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import CodeGraph from '../src';

const roots: string[] = [], children: ChildProcessWithoutNullStreams[] = [];
function client(root: string, toolNames = 'explore,node,search,context') {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../dist/bin/codegraph.js'), 'serve', '--mcp'], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_ENABLE_EXPLORE: '1', CODEGRAPH_MCP_TOOLS: toolNames },
  });
  children.push(child);
  let stderr = '', nextId = 1;
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  readline.createInterface({ input: child.stdout }).on('line', line => {
    try { const response = JSON.parse(line); if (typeof response.id === 'number') pending.get(response.id)?.resolve(response); } catch { /* CLI diagnostics cannot satisfy an RPC. */ }
  });
  child.on('error', error => { for (const entry of pending.values()) entry.reject(error); });
  child.on('exit', code => { for (const entry of pending.values()) entry.reject(new Error(`MCP exited ${code}: ${stderr}`)); });
  async function request(method: string, params: unknown) {
    const id = nextId++;
    const result = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timeout: ${stderr}`)); }, 30000);
      pending.set(id, { resolve(value) { clearTimeout(timer); pending.delete(id); resolve(value); }, reject(error) { clearTimeout(timer); pending.delete(id); reject(error); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    expect(result.error, JSON.stringify(result)).toBeUndefined(); return result.result;
  }
  return { request, async initialize() {
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'explore-acceptance', version: '1' }, rootUri: pathToFileURL(root).href });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  } };
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('serves Explore schema and natural-language source over real MCP, without cross-session suppression', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-wire-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'wire.ts'), 'export function wireAcceptanceLeaf() { return 71493; }\nexport function wireAcceptanceEntry() { return wireAcceptanceLeaf(); }\n');
  const graph = CodeGraph.initSync(root);
  try { await graph.indexAll(); } finally { graph.close(); await graph.whenIdle(); }
  // Different processes are different real sessions. Calls are sequential, not a performance benchmark.
  for (let session = 0; session < 2; session++) {
    const rpc = client(root); await rpc.initialize();
    const listed = await rpc.request('tools/list', {});
    const explore = listed.tools.find((tool: any) => tool.name === 'explore');
    expect(explore.inputSchema.required).toContain('query');
    expect(explore.inputSchema.properties.query.type).toBe('string');
    expect(explore.inputSchema.properties).toHaveProperty('maxFiles');
    const result = await rpc.request('tools/call', { name: 'explore', arguments: { query: '解释 wireAcceptanceEntry 如何调用 wireAcceptanceLeaf', maxFiles: 2 } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/_cgExploreEmission|_cgAnswerFiles|_cgExploreSession/);
    const text = result.content.map((item: any) => item.text ?? '').join('\n');
    expect(text).toContain('return 71493;'); expect(text).toContain('wireAcceptanceLeaf()');
    expect(text.length).toBeLessThanOrEqual(25000);
    const invalid = await rpc.request('tools/call', { name: 'explore', arguments: { query: '' } });
    expect(invalid.isError).toBe(true);
  }
}, 90000);

it.each(['explore', 'explore,node'])('makes the rendered follow-up executable over MCP (%s), without rewriting source', async toolNames => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-followup-')); roots.push(root);
  const lines = [
    'export function wireOversized(value: number) {',
    '  const originalToolNames = "codegraph_node codegraph_explore";',
    ...Array.from({ length: 1600 }, (_, i) => `  value += ${i}; // ${'wire detailed evidence '.repeat(4)}`),
    '  return value + originalToolNames.length;',
    '}',
  ];
  fs.writeFileSync(path.join(root, 'oversized.ts'), lines.join('\n') + '\n');
  const graph = CodeGraph.initSync(root);
  try { await graph.indexAll(); } finally { graph.close(); await graph.whenIdle(); }
  const rpc = client(root, toolNames); await rpc.initialize();
  const listed = await rpc.request('tools/list', {});
  const names: string[] = listed.tools.map((tool: any) => tool.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toEqual(expect.arrayContaining(toolNames.split(',')));
  expect(names.some(name => name.startsWith('codegraph_'))).toBe(false);
  const result = await rpc.request('tools/call', { name: 'explore', arguments: { query: 'wireOversized', maxFiles: 1 } });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const text = result.content.map((item: any) => item.text ?? '').join('\n');
  // The identifiers below are literal user source, not recommendations. A global
  // string replacement would corrupt them while making superficial naming tests pass.
  expect(text).toContain('const originalToolNames = "codegraph_node codegraph_explore";');
  const recommendation = text.match(/elided — ([a-z_]+) `(oversized\.ts:(\d+)-(\d+))` returns them/);
  expect(recommendation, text.slice(-2500)).not.toBeNull();
  const [, name, query, from] = recommendation!;
  expect(names).toContain(name);
  const continued = await rpc.request('tools/call', { name, arguments: { query } });
  expect(continued.isError, JSON.stringify(continued)).not.toBe(true);
  expect(continued.content.map((item: any) => item.text ?? '').join('\n')).toContain(lines[Number(from) - 1]!.trim());
  const nodeSuggestion = text.match(/\(or `([a-z_]+)`\)/);
  if (toolNames.includes(',node')) {
    expect(nodeSuggestion, text.slice(-2500)).not.toBeNull();
    const suggestedNode = nodeSuggestion![1]!;
    expect(names).toContain(suggestedNode);
    const nodeResult = await rpc.request('tools/call', { name: suggestedNode, arguments: { file: 'oversized.ts', offset: Number(from), limit: 3 } });
    expect(nodeResult.isError, JSON.stringify(nodeResult)).not.toBe(true);
    expect(nodeResult.content.map((item: any) => item.text ?? '').join('\n')).toContain(lines[Number(from) - 1]!.trim());
  } else {
    expect(nodeSuggestion).toBeNull();
  }
}, 90000);
