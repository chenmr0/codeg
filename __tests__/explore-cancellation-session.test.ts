/** Real Explore + MCPSession, with a controlled dispatch/delivery boundary.
 * No timing sleeps: cancellation is delivered after rendering but before the
 * awaited tool dispatch returns, when no response has reached the client.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { ToolHandler, type ToolResult } from '../src/mcp/tools';
import { MCPSession } from '../src/mcp/session';
import type { MCPEngine } from '../src/mcp/engine';
import { ExploreSessionState } from '../src/upstream-explore/mcp/explore-session-state';
import type { JsonRpcRequest, JsonRpcNotification, JsonRpcResponse, JsonRpcTransport, MessageHandler } from '../src/mcp/transport';

class ControlledTransport implements JsonRpcTransport {
  handler!: MessageHandler;
  responses: JsonRpcResponse[] = [];
  failNextSend = false;
  start(handler: MessageHandler) { this.handler = handler; }
  stop() {}
  notify() {}
  async request(): Promise<unknown> { return {}; }
  send(response: JsonRpcResponse) { this.responses.push(response); }
  sendResult(id: string | number, result: unknown) {
    if (this.failNextSend) { this.failNextSend = false; throw new Error('controlled send failure'); }
    this.send({ jsonrpc: '2.0', id, result });
  }
  sendError(id: string | number | null, code: number, message: string) {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }
  deliver(message: JsonRpcRequest | JsonRpcNotification) { return this.handler(message); }
}
const fixtures: Array<{ root: string; graph: CodeGraph; handler: ToolHandler; session: MCPSession }> = [];
beforeEach(() => {
  vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
  vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,node');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    f.session.stop(); f.handler.closeAll();
    await f.graph.whenIdle(); f.graph.close(); await f.graph.whenIdle();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-cancel-'));
  fs.writeFileSync(path.join(root, 'service.ts'), 'export function cancellationEvidence() { return 873419; }\n');
  const graph = CodeGraph.initSync(root);
  const handler = new ToolHandler(graph);
  const transport = new ControlledTransport();
  // Keep the real session, dispatch, graph, renderer and state; only engine
  // initialization and the byte transport are controlled by this harness.
  const engine = { hasDefaultCodeGraph: () => true, getToolHandler: () => handler } as unknown as MCPEngine;
  const session = new MCPSession(transport, engine);
  fixtures.push({ root, graph, handler, session });
  await graph.indexAll(); session.start();
  const call = (id: number) => transport.deliver({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'explore', arguments: { query: 'cancellationEvidence' } } });
  return { root, handler, transport, session, call };
}
function text(result: ToolResult) {
  expect(result.isError).not.toBe(true);
  expect(result).not.toHaveProperty('_cgExploreEmission');
  return result.content.map(part => part.text ?? '').join('\n');
}

it('does not remember a cancelled response, and the retry still delivers its source', async () => {
  const f = await fixture();
  let ready!: () => void, resume!: () => void;
  const rendered = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const execute = f.handler.execute.bind(f.handler);
  vi.spyOn(f.handler, 'execute').mockImplementationOnce(async (...args) => {
    const result = await execute(...args);
    ready(); await gate; return result;
  });
  const first = f.call(41);
  try {
    await rendered;
    expect(f.transport.responses).toHaveLength(0);
    await f.transport.deliver({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 41 } });
  } finally { resume(); }
  await first;
  expect(f.transport.responses.at(-1)?.error?.code).toBe(-32800);
  expect(f.session.getExploreSessionState().callCount(f.root)).toBe(0);
  await f.call(42);
  expect(text(f.transport.responses.at(-1)!.result as ToolResult)).toContain('return 873419;');
  expect(f.session.getExploreSessionState().callCount(f.root)).toBe(1);
}, 30000);

it('does not remember a failed send, but commits a subsequent successful send exactly once', async () => {
  const f = await fixture(); f.transport.failNextSend = true;
  await expect(f.call(51)).rejects.toThrow('controlled send failure');
  expect(f.transport.responses).toHaveLength(0);
  expect(f.session.getExploreSessionState().callCount(f.root)).toBe(0);
  await f.call(52);
  expect(text(f.transport.responses.at(-1)!.result as ToolResult)).toContain('return 873419;');
  expect(f.session.getExploreSessionState().callCount(f.root)).toBe(1);
}, 30000);

it('keeps SDK successful-call bookkeeping, but never records an aborted SDK call', async () => {
  const f = await fixture(), state = new ExploreSessionState();
  const abort = new AbortController(); abort.abort();
  await f.handler.execute('explore', { query: 'cancellationEvidence' }, { exploreSession: state, signal: abort.signal });
  expect(state.callCount(f.root)).toBe(0);
  const result = await f.handler.execute('explore', { query: 'cancellationEvidence' }, { exploreSession: state });
  expect(text(result)).toContain('return 873419;');
  expect(state.callCount(f.root)).toBe(1);
}, 30000);
