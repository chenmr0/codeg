import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import CodeGraph from '../src';
import { PortableCoordinator, type PortableLease } from '../src/sync/portable/protocol';
import { getCodeGraphDir } from '../src/directory';
import { SEMANTIC_CONFIG_KEY, SEMANTIC_REINDEX_PENDING, requiresSemanticReindex } from '../src/sync/index-policy';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';
let root: string, graph: CodeGraph, leases: PortableLease[];
const queries = () => (graph as any).queries;
beforeEach(async () => {
  vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-policy-sync-'));
  fs.writeFileSync(path.join(root, 'main.c'), 'int one(void) { return 1; }\n');
  graph = CodeGraph.initSync(root); graph.close(); await graph.whenIdle();
  const coordinator = new PortableCoordinator(getCodeGraphDir(root));
  leases = [coordinator.acquireWriter(), coordinator.acquireReader()];
  graph = CodeGraph.openPortableRaw(root, coordinator.active, false);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  graph?.close(); await graph?.whenIdle();
  for (const lease of leases ?? []) lease.release();
  fs.rmSync(root, { recursive: true, force: true });
});
it('CMake text changes only update policy metadata without init or unchanged extraction', async () => {
  await graph.indexAll();
  const full = vi.spyOn((graph as any).orchestrator, 'indexAll');
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), '# comment-only build edit\n');
  const result = await graph.sync({ adaptive: false, paths: ['main.c'] });
  expect(result.complete).toBe(true); expect(result.filesModified).toBe(0);
  expect(full).not.toHaveBeenCalled();
  expect((await graph.sync({ adaptive: false })).filesModified).toBe(0);
});
it('an extraction upgrade replaces same-content files incrementally and stamps only success', async () => {
  await graph.indexAll();
  queries().setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION - 1));
  const full = vi.spyOn((graph as any).orchestrator, 'indexAll');
  const result = await graph.sync({ adaptive: false });
  expect(result.complete).toBe(true); expect(result.filesModified).toBe(1);
  expect(graph.isIndexStale()).toBe(false); expect(full).not.toHaveBeenCalled();
  expect((await graph.sync({ adaptive: false })).filesModified).toBe(0);
});
it('a failed semantic refresh retains the old fingerprint and retries on the next sync', async () => {
  await graph.indexAll();
  const before = queries().getMetadata(SEMANTIC_CONFIG_KEY);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":"."}}');
  const sync = vi.spyOn((graph as any).orchestrator, 'sync').mockRejectedValueOnce(new Error('injected extraction failure'));
  await expect(graph.sync({ adaptive: false })).rejects.toThrow('injected extraction failure');
  expect(queries().getMetadata(SEMANTIC_CONFIG_KEY)).toBe(before);
  sync.mockRestore();
  expect((await graph.sync({ adaptive: false })).filesModified).toBe(1);
  expect(queries().getMetadata(SEMANTIC_CONFIG_KEY)).not.toBe(before);
});
it('changing tsconfig aliases refreshes references in unchanged source with a live resolver', async () => {
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function target() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'b.ts'), 'export function target() { return 2; }\n');
  fs.writeFileSync(path.join(root, 'use.ts'), 'import { target } from "@target"; export function caller() { return target(); }\n');
  const config = (name: string) => fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@target': [name] } } }));
  config('a.ts'); await graph.indexAll();
  const targets = () => graph.getCallees(graph.getNodesByName('caller')[0]!.id).filter(item => item.node.name === 'target').map(item => item.node.filePath);
  expect(targets()).toContain('a.ts');
  config('b.ts'); const result = await graph.sync({ adaptive: false, paths: ['main.c'] });
  expect(result.complete).toBe(true); expect(targets()).toContain('b.ts'); expect(targets()).not.toContain('a.ts');
});
it('a build-directory compilation database is a semantic input even when CMake is unchanged', async () => {
  await graph.indexAll();
  const before = queries().getMetadata(SEMANTIC_CONFIG_KEY);
  fs.mkdirSync(path.join(root, 'build'));
  fs.writeFileSync(path.join(root, 'build/compile_commands.json'), '[]');
  expect((await graph.sync({ adaptive: false })).filesModified).toBe(1);
  expect(queries().getMetadata(SEMANTIC_CONFIG_KEY)).not.toBe(before);
});
it.each(['sync', 'indexAll'] as const)('retries semantic work via %s after partial B writes even if configuration is restored to A', async (operation) => {
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function target() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'b.ts'), 'export function target() { return 2; }\n');
  fs.writeFileSync(path.join(root, 'use.ts'), 'import { target } from "@target"; export function caller() { return target(); }\n');
  const config = (name: string) => fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@target': [name] } } }));
  config('a.ts'); await graph.indexAll();
  const resolver = (graph as any).resolver;
  const resolve = resolver.resolveFilesAndPersist.bind(resolver);
  const injected = vi.spyOn(resolver, 'resolveFilesAndPersist').mockImplementationOnce(async (...args) => {
    await resolve(...args);
    throw new Error('interrupted after committing B references');
  });
  config('b.ts');
  await expect(graph.sync({ adaptive: false })).rejects.toThrow('interrupted after committing B references');
  injected.mockRestore(); config('a.ts');
  const result = operation === 'sync' ? await graph.sync({ adaptive: false }) : await graph.indexAll();
  expect(result.complete).toBe(true);
  if ('filesModified' in result) expect(result.filesModified).toBe(4);
  else expect(result.filesIndexed).toBe(4);
  const callees = graph.getCallees(graph.getNodesByName('caller')[0]!.id).filter(item => item.node.name === 'target').map(item => item.node.filePath);
  expect(callees).toContain('a.ts'); expect(callees).not.toContain('b.ts');
  expect(graph.hasPortableCatchupWork()).toBe(false);
});
it('a new ordinary source directory does not invalidate the semantic configuration', async () => {
  await graph.indexAll();
  const before = queries().getMetadata(SEMANTIC_CONFIG_KEY);
  fs.mkdirSync(path.join(root, 'newdir'));
  fs.writeFileSync(path.join(root, 'newdir/new.c'), 'int added(void) { return 5; }\n');
  const result = await graph.sync({ adaptive: false });
  expect(result.filesAdded).toBe(1); expect(result.filesModified).toBe(0);
  expect(queries().getMetadata(SEMANTIC_CONFIG_KEY)).toBe(before);
  expect((await graph.sync({ adaptive: false })).filesModified).toBe(0);
});
it('does not train ordinary incremental costs with a mixed semantic re-extraction workload', async () => {
  await graph.indexAll();
  const record = vi.spyOn(graph as any, 'recordCostSample');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":"."}}');
  fs.writeFileSync(path.join(root, 'main.c'), 'int changed(void) { return 77; }\n');
  expect((await graph.sync({ adaptive: false })).complete).toBe(true);
  expect(record).not.toHaveBeenCalled();
});
it('explicit indexAll also re-extracts same-content sources after semantic configuration changes', async () => {
  await graph.indexAll();
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":"."}}');
  const index = vi.spyOn((graph as any).orchestrator, 'indexAll');
  const result = await graph.indexAll();
  expect(result.complete).toBe(true);
  expect(index.mock.calls[0]!.at(-1)).toMatchObject({ force: true, reconcile: true });
  expect(graph.hasPortableCatchupWork()).toBe(false);
});
it('does not acknowledge a configuration changed in the middle of explicit indexAll', async () => {
  await graph.indexAll();
  const before = queries().getMetadata(SEMANTIC_CONFIG_KEY);
  const orchestrator = (graph as any).orchestrator;
  const original = orchestrator.indexAll.bind(orchestrator);
  const injected = vi.spyOn(orchestrator, 'indexAll').mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":"new-base"}}');
    return result;
  });
  expect((await graph.indexAll()).complete).toBe(false);
  expect(queries().getMetadata(SEMANTIC_CONFIG_KEY)).toBe(before);
  expect(graph.hasPortableCatchupWork()).toBe(true);
  injected.mockRestore();
  const retry = await graph.sync({ adaptive: false });
  expect(retry.complete).toBe(true); expect(retry.filesModified).toBe(1);
  expect(graph.hasPortableCatchupWork()).toBe(false);
});

it('never trusts missing or v1-only semantic baselines, even with an equal broad fingerprint', () => {
  expect(requiresSemanticReindex(null, 'current', null, 'broad', false)).toBe(true);
  expect(requiresSemanticReindex(null, 'current', 'broad', 'broad', false)).toBe(true);
  expect(requiresSemanticReindex('current', 'current', 'broad', 'broad', false)).toBe(false);
  expect(requiresSemanticReindex('current', 'current', 'broad', 'broad', false, true)).toBe(true);
});
it.each(['missing', 'poisoned', 'healthy-v1'] as const)('migrates a %s baseline exactly once and never acknowledges failed work', async (baseline) => {
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function target() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'b.ts'), 'export function target() { return 2; }\n');
  fs.writeFileSync(path.join(root, 'use.ts'), 'import { target } from "@target"; export function caller() { return target(); }\n');
  const config = (name: string) => fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@target': [name] } } }));
  config('a.ts'); await graph.indexAll();
  const oldSemantic = queries().getMetadata(SEMANTIC_CONFIG_KEY);
  if (baseline !== 'healthy-v1') config('b.ts');
  const { semanticConfigFingerprint } = await import('../src/sync/index-policy');
  const { adaptiveConfigFingerprint } = await import('../src/sync/adaptive-plan');
  queries().applyMetadataChanges({
    [SEMANTIC_CONFIG_KEY]: null,
    'index:semantic-config-v1': baseline === 'missing' ? null : semanticConfigFingerprint(root, queries().getAllFiles()),
    'adaptive:index-config-v1': baseline === 'missing' ? null : adaptiveConfigFingerprint(root, queries().getAllFiles()),
  });
  const sync = vi.spyOn((graph as any).orchestrator, 'sync').mockRejectedValueOnce(new Error('migration interrupted'));
  await expect(graph.sync({ adaptive: false })).rejects.toThrow('migration interrupted');
  expect(queries().getMetadata(SEMANTIC_CONFIG_KEY)).toBeNull();
  expect(queries().getMetadata(SEMANTIC_REINDEX_PENDING)).not.toBeNull();
  sync.mockRestore();
  graph.close(); await graph.whenIdle();
  graph = CodeGraph.openPortableRaw(root, new PortableCoordinator(getCodeGraphDir(root)).active, false);
  expect(queries().getMetadata(SEMANTIC_REINDEX_PENDING)).not.toBeNull();
  const result = await graph.sync({ adaptive: false });
  expect(result.complete).toBe(true); expect(result.filesModified).toBe(4);
  const targets = graph.getCallees(graph.getNodesByName('caller')[0]!.id).filter(item => item.node.name === 'target').map(item => item.node.filePath);
  expect(targets).toEqual([baseline === 'healthy-v1' ? 'a.ts' : 'b.ts']);
  expect(queries().getMetadata(SEMANTIC_CONFIG_KEY)).not.toBeNull();
  if (baseline === 'healthy-v1') expect(queries().getMetadata(SEMANTIC_CONFIG_KEY)).toBe(oldSemantic);
  expect(queries().getMetadata(SEMANTIC_REINDEX_PENDING)).toBeNull();
  expect((await graph.sync({ adaptive: false })).filesModified).toBe(0);
});

it('indexAll only stamps the migration baseline after a complete retry', async () => {
  await graph.indexAll();
  queries().applyMetadataChanges({ [SEMANTIC_CONFIG_KEY]: null });
  const orchestrator = (graph as any).orchestrator;
  const original = orchestrator.indexAll.bind(orchestrator);
  const injected = vi.spyOn(orchestrator, 'indexAll').mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    return { ...result, complete: false, filesErrored: 1 };
  });
  expect((await graph.indexAll()).complete).toBe(false);
  expect(queries().getMetadata(SEMANTIC_CONFIG_KEY)).toBeNull();
  expect(queries().getMetadata(SEMANTIC_REINDEX_PENDING)).not.toBeNull();
  injected.mockRestore();
  expect((await graph.indexAll()).complete).toBe(true);
  expect(queries().getMetadata(SEMANTIC_CONFIG_KEY)).not.toBeNull();
  expect(queries().getMetadata(SEMANTIC_REINDEX_PENDING)).toBeNull();
  expect((await graph.sync({ adaptive: false })).filesModified).toBe(0);
});
