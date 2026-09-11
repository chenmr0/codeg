import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph, { SyncIncompleteError } from '../src/index';
import type { QueryBuilder } from '../src/db/queries';
import { DECLARATION_MACRO_RECOVERY_SKIPPED_CODE } from '../src/extraction/diagnostics';

describe('language scope migration', () => {
  let directory: string;
  let cg: CodeGraph;

  const queries = (): QueryBuilder => (cg as any).queries;
  const files = () => queries().getAllFiles().map(file => file.path).sort();
  const graph = () => {
    const db = (cg as any).db.getDb();
    return {
      nodes: db.prepare('SELECT * FROM nodes ORDER BY id').all().map(({ updated_at, ...node }: any) => node),
      edges: db.prepare('SELECT source, target, kind, metadata, line, col, provenance FROM edges ORDER BY source, target, kind, line, col').all(),
      refs: db.prepare('SELECT from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, status, name_tail FROM unresolved_refs ORDER BY from_node_id, reference_name, reference_kind, line, col').all(),
    };
  };

  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', undefined);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-language-scope-'));
    fs.writeFileSync(path.join(directory, 'api.h'), 'int calculate(int value);\n');
    fs.writeFileSync(path.join(directory, 'api.c'), '#include "api.h"\nint calculate(int value) { return value + 1; }\n');
    fs.writeFileSync(path.join(directory, 'helper.py'), 'def helper():\n    return 42\n');
    fs.writeFileSync(path.join(directory, 'script.lua'), 'function work() return 42 end\n');
    fs.writeFileSync(path.join(directory, 'widget.ts'), 'export function extra() { return 7; }\nexport function caller() { return extra(); }\n');
    cg = CodeGraph.initSync(directory);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cg?.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('reconciles both directions even when sync is scoped, then retains the no-op fast path', async () => {
    expect((await cg.indexAll()).complete).toBe(true);
    const defaultGraph = graph();
    expect(files()).toEqual(['api.c', 'api.h', 'helper.py', 'script.lua']);
    expect(queries().getMetadata('indexed_language_scope')).toBe('default-v1');

    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    const expanded = await cg.sync({ paths: ['api.c'] });
    expect(expanded.complete).toBe(true);
    expect(expanded.filesAdded).toBe(1);
    expect(files()).toContain('widget.ts');
    const allGraph = graph();
    expect(queries().getMetadata('indexed_language_scope')).toBe('all');

    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', undefined);
    const narrowed = await cg.sync({ paths: ['api.c'] });
    expect(narrowed.filesRemoved).toBe(1);
    expect(graph()).toEqual(defaultGraph);
    expect(queries().getMetadata('language_scope_pending')).toBeNull();

    const fullIndex = vi.spyOn((cg as any).orchestrator, 'indexAll');
    const noChange = await cg.sync({ paths: ['api.c'] });
    expect(noChange.filesChecked).toBe(1);
    expect(noChange.filesModified).toBe(0);
    expect(fullIndex).not.toHaveBeenCalled();

    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    await cg.sync({ paths: ['api.c'] });
    expect(graph()).toEqual(allGraph);
  });

  it('treats unstamped legacy indexes as all languages and removes missing files on migration', async () => {
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    await cg.indexAll();
    queries().applyMetadataChanges({ indexed_language_scope: null });
    const fullIndex = vi.spyOn((cg as any).orchestrator, 'indexAll');
    await cg.sync({ paths: ['api.c'] });
    expect(fullIndex).not.toHaveBeenCalled();
    queries().applyMetadataChanges({ indexed_language_scope: null });
    fs.unlinkSync(path.join(directory, 'helper.py'));
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', undefined);
    await cg.sync({ paths: ['api.c'] });
    expect(files()).toEqual(['api.c', 'api.h', 'script.lua']);
    expect(fullIndex).toHaveBeenCalledOnce();
    expect(queries().getMetadata('indexed_language_scope')).toBe('default-v1');
  });

  it('does not accept an interrupted transition and retries even if the environment is switched back', async () => {
    await cg.indexAll();
    const original = graph();
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    const controller = new AbortController();
    controller.abort();
    const stopped = await cg.indexAll({ signal: controller.signal });
    expect(stopped.complete).toBe(false);
    expect(queries().getMetadata('indexed_language_scope')).toBe('default-v1');
    expect(queries().getMetadata('language_scope_pending')).toBe('all');
    expect(graph()).toEqual(original);

    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', undefined);
    const fullIndex = vi.spyOn((cg as any).orchestrator, 'indexAll');
    await cg.sync({ paths: ['api.c'] });
    expect(fullIndex).toHaveBeenCalledOnce();
    expect(queries().getMetadata('language_scope_pending')).toBeNull();
    expect(graph()).toEqual(original);
  });

  it('keeps the scope snapshot through an operation and exposes failed migrations as incomplete', async () => {
    await cg.indexAll({ onProgress: () => { process.env.CODEGRAPH_ALL_LANGUAGES = '1'; } });
    expect(files()).not.toContain('widget.ts');
    expect(queries().getMetadata('indexed_language_scope')).toBe('default-v1');
    const fullIndex = vi.spyOn((cg as any).orchestrator, 'indexAll').mockRejectedValueOnce(new Error('store failed'));
    await expect(cg.sync({ paths: ['api.c'] })).rejects.toThrow('store failed');
    expect(queries().getMetadata('language_scope_pending')).toBe('all');
    expect(queries().getMetadata('index_completeness')).toBe('incomplete');
    fullIndex.mockRestore();
    const controller = new AbortController();
    controller.abort();
    await expect(cg.sync({ signal: controller.signal })).rejects.toBeInstanceOf(SyncIncompleteError);
    await cg.sync();
    expect(files()).toContain('widget.ts');
    expect(queries().getMetadata('language_scope_pending')).toBeNull();
  });

  it('keeps explicit indexing within the scope, including the first index and scope changes', async () => {
    await cg.indexFiles(['api.c', 'widget.ts']);
    expect(files()).toEqual(['api.c']);
    expect(queries().getMetadata('indexed_language_scope')).toBe('default-v1');
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    await cg.indexFiles(['widget.ts']);
    expect(files()).toContain('widget.ts');
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', undefined);
    await cg.indexFiles(['widget.ts']);
    expect(files()).not.toContain('widget.ts');
    expect(queries().getMetadata('indexed_language_scope')).toBe('default-v1');
  });

  it('records an empty narrowed index so later sync does not rebuild forever', async () => {
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    await cg.indexAll();
    for (const file of ['api.c', 'api.h', 'helper.py', 'script.lua']) fs.unlinkSync(path.join(directory, file));
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', undefined);
    await cg.sync();
    expect(files()).toEqual([]);
    expect(graph().nodes).toEqual([]);
    const fullIndex = vi.spyOn((cg as any).orchestrator, 'indexAll');
    await cg.sync();
    expect(fullIndex).not.toHaveBeenCalled();
  });

  it('retries a base-only macro file incrementally after the language selection was applied', async () => {
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    await cg.indexAll();
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', undefined);
    const orchestrator = (cg as any).orchestrator;
    const original = orchestrator.indexAll.bind(orchestrator);
    const fullIndex = vi.spyOn(orchestrator, 'indexAll').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      const diagnostic = {
        code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
        severity: 'warning' as const,
        filePath: 'api.c',
        message: 'Base AST symbols were indexed; macro recovery skipped',
      };
      queries().upsertFile({ ...queries().getFileByPath('api.c')!, errors: [diagnostic] });
      result.errors.push(diagnostic);
      return result;
    });
    await expect(cg.sync()).rejects.toBeInstanceOf(SyncIncompleteError);
    expect(queries().getMetadata('indexed_language_scope')).toBe('default-v1');
    expect(queries().getMetadata('language_scope_pending')).toBeNull();
    fullIndex.mockClear();
    const retried = await cg.sync();
    expect(fullIndex).not.toHaveBeenCalled();
    expect(retried.filesModified).toBe(1);
    expect(queries().getFileByPath('api.c')!.errors ?? []).toEqual([]);
  });
});
