import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import CodeGraph from '../src';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
import { ToolHandler } from '../src/mcp/tools';
import { removeDirectory } from '../src/directory';

let root: string;
let cg: CodeGraph | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'terms-explore-')); vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1'); });
afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function setup() {
  fs.writeFileSync(path.join(root, 'radio.cpp'), 'int getChannel() { return 6; }\nint getRadioCfg() { return getChannel(); }\n');
  fs.writeFileSync(path.join(root, 'order.ts'), 'export class OrderStateMachine { transit() { return 1; } }\n');
  cg = CodeGraph.initSync(root); await cg.indexAll();
  return cg;
}
function writeMappings(dataDir: string, symbols = ['getChannel', 'getRadioCfg']) {
  fs.writeFileSync(path.join(dataDir, 'term-mappings.json'), JSON.stringify({ rules: [{ terms: ['信道配置', '信道参数'], symbols }] }));
}

describe('project mappings in native Explore', () => {
  it('adds Chinese terminology recall while retaining automatic segment recall and respecting exact case', async () => {
    const graph = await setup();
    const api = createUpstreamExploreGraph(graph);
    const names = async (q: string) => [...(await api.findRelevantContext(q, { searchLimit: 8, maxNodes: 200 })).nodes.values()].map(n => n.name);
    expect(await names('信道配置')).not.toContain('getChannel');
    writeMappings(graph.getDataDirectory());
    expect(await names('信道配置')).toContain('getChannel');
    expect(await names('信道参数')).toContain('getRadioCfg');
    expect(await names('信道配置 state machine')).toContain('OrderStateMachine');
    writeMappings(graph.getDataDirectory(), ['GETCHANNEL', 'MissingSymbol']);
    expect(await names('信道配置')).not.toContain('getChannel');
    expect(await names('state machine')).toContain('OrderStateMachine');
  });
  it('keeps a single seed for multiword business terms and permits callback fields/macros', async () => {
    const graph = await setup();
    fs.writeFileSync(path.join(root, 'hooks.h'), '#define RADIO_MODE 1\nstruct Hooks { int (*getCallback)(int); };\n');
    await graph.indexAll();
    fs.writeFileSync(path.join(graph.getDataDirectory(), 'term-mappings.json'), JSON.stringify({ rules: [
      { terms: ['wireless selection'], symbols: ['getChannel'] },
      { terms: ['运行模式'], symbols: ['RADIO_MODE'] },
      { terms: ['业务钩子'], symbols: ['getCallback'] },
    ] }));
    const api = createUpstreamExploreGraph(graph);
    expect([...(await api.findRelevantContext('wireless selection')).nodes.values()].some(n => n.name === 'getChannel')).toBe(true);
    expect([...(await api.findRelevantContext('运行模式')).nodes.values()].some(n => n.name === 'RADIO_MODE')).toBe(true);
    expect([...(await api.findRelevantContext('业务钩子')).nodes.values()].some(n => n.name === 'getCallback')).toBe(true);
    expect([...(await api.findRelevantContext('业务钩子', { nodeKinds: ['function'] })).nodes.values()].some(n => n.name === 'getCallback')).toBe(false);
  });
  it('delivers mapped source through the real MCP tool and tolerates broken configuration', async () => {
    const graph = await setup();
    writeMappings(graph.getDataDirectory());
    const handler = new ToolHandler(graph);
    const result = await handler.execute('explore', { query: '信道配置', maxFiles: 2 });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('getChannel');
    fs.writeFileSync(path.join(graph.getDataDirectory(), 'term-mappings.json'), '{');
    const normal = await handler.execute('explore', { query: 'getChannel', maxFiles: 2 });
    expect(normal.isError).not.toBe(true);
    expect(normal.content[0]?.text).toContain('getChannel');
  });
  it('does not mutate read-only index bytes, and mapping edits do not require reindexing', async () => {
    const graph = await setup(); const dir = graph.getDataDirectory();
    graph.close(); cg = undefined;
    const dbPath = path.join(dir, 'codegraph.db');
    const hash = () => createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
    const before = hash();
    writeMappings(dir);
    cg = await CodeGraph.open(root, { readOnly: true, sync: false });
    const api = createUpstreamExploreGraph(cg);
    expect([...(await api.findRelevantContext('信道配置')).nodes.values()].some(n => n.name === 'getChannel')).toBe(true);
    cg.close(); cg = undefined;
    expect(hash()).toBe(before);
  });
  it('preserves mappings through sync, full init and uninitialize/reinitialize', async () => {
    const graph = await setup(); const dir = graph.getDataDirectory(); writeMappings(dir);
    const file = path.join(dir, 'term-mappings.json'); const bytes = fs.readFileSync(file);
    const synced = await graph.sync();
    expect(synced.filesAdded + synced.filesModified + synced.filesRemoved).toBe(0);
    expect(synced.adaptive?.strategy).not.toBe('rebuild');
    expect(fs.readFileSync(file)).toEqual(bytes);
    await graph.indexAll(); expect(fs.readFileSync(file)).toEqual(bytes);
    // Portable storage keeps its pre-existing live-process removal guard.
    // Exercise the offline directory cleanup used by native uninitialize.
    if (graph.isPortableStorage()) {
      expect(() => graph.uninitialize()).toThrow('Stop all processes');
      graph.close(); await graph.whenIdle();
      removeDirectory(root, path.basename(dir));
    } else graph.uninitialize();
    cg = undefined;
    expect(fs.readdirSync(dir)).toEqual(['term-mappings.json']);
    expect(fs.readFileSync(file)).toEqual(bytes);
    cg = CodeGraph.initSync(root); await cg.indexAll();
    expect([...(await createUpstreamExploreGraph(cg).findRelevantContext('信道配置')).nodes.values()].some(n => n.name === 'getChannel')).toBe(true);
  });
});
