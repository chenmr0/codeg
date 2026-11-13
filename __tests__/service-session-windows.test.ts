/** Platform-logic test only: filesystem discovery is stubbed, not Windows I/O. */
import { afterEach, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as identity from '../src/path-identity';
import * as directory from '../src/directory';
import { MCPSession } from '../src/mcp/session';
import type { MCPEngine } from '../src/mcp/engine';
import type { JsonRpcTransport } from '../src/mcp/transport';
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => { Object.defineProperty(process, 'platform', descriptor); vi.restoreAllMocks(); });
it('accepts Windows rootUri and tool projectPath case variants but rejects another project', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  // Model the filesystem's identity result, not Unicode string folding.
  vi.spyOn(identity, 'sameExistingPath').mockImplementation((a,b) => path.resolve(a).replace(/[A-Z]/g,c=>c.toLowerCase()) === path.resolve(b).replace(/[A-Z]/g,c=>c.toLowerCase()));
  vi.spyOn(directory, 'findNearestCodeGraphRoot').mockImplementation(root => root);
  const transport = { sendResult: vi.fn(), sendError: vi.fn(), stop: vi.fn() } as unknown as JsonRpcTransport;
  const execute = vi.fn().mockResolvedValue({ content: [] });
  const engine = { ensureInitialized: vi.fn().mockResolvedValue(undefined), hasDefaultCodeGraph: () => true, getToolHandler: () => ({ execute }) } as unknown as MCPEngine;
  const session = new MCPSession(transport, engine, { explicitProjectPath: 'C:/work/MixedCase', restrictProject: true });
  await (session as any).handleInitialize({ id: 1, params: { rootUri: 'file:///c:/WORK/MIXEDCASE' } });
  expect(transport.sendError).not.toHaveBeenCalled(); expect(transport.sendResult).toHaveBeenCalled();
  await (session as any).handleToolsCall({ id: 2, params: { name: 'search', arguments: { query: 'foo', projectPath: 'C:/WORK/mixedcase' } } });
  expect(transport.sendError).not.toHaveBeenCalled(); expect(execute).toHaveBeenCalled();
  await (session as any).handleToolsCall({ id: 3, params: { name: 'search', arguments: { query: 'foo', projectPath: 'C:/work/Other' } } });
  expect(transport.sendError).toHaveBeenLastCalledWith(3, -32602, 'Shared service is bound to a different project');
  session.stop();
});
