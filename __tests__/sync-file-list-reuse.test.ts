import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';
import type { CppMacroDefinition } from '../src/extraction/declaration-macros';

// Wrap the named bindings used by the scanner, but execute real filesystem
// and Git operations. Counts below do not depend on the new log assertions.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

interface ContextAccess {
  ensureDetectedFrameworks(files?: string[]): string[];
  ensureGlobalMacroNames(files?: string[]): Promise<Set<string>>;
  globalMacroDefinitions: CppMacroDefinition[] | null;
}

describe('sync per-invocation full file list reuse', () => {
  let dir: string;
  let cg: CodeGraph;
  let messages: string[];
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  const context = () => (cg as unknown as { orchestrator: ContextAccess }).orchestrator;
  const reopen = () => { cg.close(); cg = CodeGraph.openSync(dir); };
  const resetObservations = () => {
    vi.mocked(fs.readFileSync).mockClear();
    vi.mocked(execFileSync).mockClear();
    messages.length = 0;
  };
  const expectScans = (route: 'git' | 'walk' | 'hybrid', count: number) => {
    const gitLists = vi.mocked(execFileSync).mock.calls.filter(([cmd, args]) =>
      cmd === 'git' && Array.isArray(args) && args[0] === 'ls-files');
    // Each walk reads the existing .codegraphignore for the negation check
    // and the root matcher. Framework probes do not read this file.
    const ignoreReads = vi.mocked(fs.readFileSync).mock.calls.filter(([file]) =>
      typeof file === 'string' && file === path.join(dir, '.codegraphignore'));
    expect(gitLists).toHaveLength(route === 'walk' ? 0 : count * 2);
    if (route !== 'git') expect(ignoreReads).toHaveLength(count * 2);
  };
  const detail = () => messages.find((message) => message.startsWith('[sync] context-files '));
  const addMacroConsumer = (file = 'keep/new.c', name = 'recovered_value') => {
    write(file, `#include "defs.h"\nDECLARE_GLOBAL(${name})\n`);
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-list-reuse-'));
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe', windowsHide: true });
    write('keep/defs.h', '#define DECLARE_GLOBAL(name) int name;\n');
    write('keep/a.c', 'int alpha(void) { return 1; }\n');
    cg = CodeGraph.initSync(dir);
    await cg.indexFiles(['keep/defs.h', 'keep/a.c']);
    reopen(); // A new CLI process starts with cold framework/macro caches.
    messages = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { messages.push(args.join(' ')); });
    resetObservations();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cg?.close();
    if (dir) {
      const resolved = path.resolve(dir);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
          !path.basename(resolved).startsWith('codegraph-list-reuse-')) throw new Error('Unsafe cleanup');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });

  it.each(['git', 'walk', 'hybrid'] as const)('enumerates once on a cold full %s sync and preserves cross-file macros', async (route) => {
    if (route === 'hybrid') vi.stubEnv('CODEGRAPH_HYBRID_SCAN', '1');
    if (route === 'walk') vi.stubEnv('CODEGRAPH_NO_HYBRID_SCAN', '1');
    if (route !== 'git') {
      write('.codegraphignore', '/*\n!/keep/\n');
      write('excluded/bad.h', '#define DECLARE_GLOBAL(name) double name;\n');
    }
    addMacroConsumer();
    const frameworks = vi.spyOn(context(), 'ensureDetectedFrameworks');
    const macros = vi.spyOn(context(), 'ensureGlobalMacroNames');
    const result = await cg.sync({ verbose: true });
    expect(result).toMatchObject({ filesAdded: 1, filesModified: 0, filesRemoved: 0, complete: true });
    expectScans(route, 1);
    const files = frameworks.mock.calls[0]?.[0];
    expect(files?.slice().sort()).toEqual(['keep/a.c', 'keep/defs.h', 'keep/new.c']);
    expect(macros.mock.calls[0]?.[0]).toBe(files);
    expect(context().globalMacroDefinitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'DECLARE_GLOBAL', replacement: 'int name;' }),
    ]));
    expect(cg.getNodesInFile('keep/new.c')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'recovered_value', kind: 'variable', startLine: 2 }),
    ]));
    expect(detail()).toBe('[sync] context-files source=reconcile files=3 reuses=2 extraScans=0');
  });

  it('shares one lazy full scan for a cold scoped sync, without indexing outside paths', async () => {
    vi.stubEnv('CODEGRAPH_HYBRID_SCAN', '1');
    write('.codegraphignore', '/*\n!/keep/\n');
    addMacroConsumer();
    write('keep/pending.c', 'int pending(void) { return 9; }\n');
    const frameworks = vi.spyOn(context(), 'ensureDetectedFrameworks');
    const macros = vi.spyOn(context(), 'ensureGlobalMacroNames');
    expect(await cg.sync({ paths: ['keep/new.c'], verbose: true })).toMatchObject({ filesChecked: 1, filesAdded: 1 });
    expectScans('hybrid', 1);
    const files = frameworks.mock.calls[0]?.[0];
    expect(files?.slice().sort()).toEqual(['keep/a.c', 'keep/defs.h', 'keep/new.c', 'keep/pending.c']);
    expect(macros.mock.calls[0]?.[0]).toBe(files);
    expect(cg.getNodesInFile('keep/new.c')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'recovered_value', kind: 'variable', startLine: 2 }),
    ]));
    expect(cg.searchNodes('pending')).toHaveLength(0);
    expect(detail()).toBe('[sync] context-files source=scoped-scan files=4 reuses=1 extraScans=1');
  });

  it('reuses a full reconciliation fallback instead of treating invalid scope as a partial list', async () => {
    addMacroConsumer();
    expect(await cg.sync({ paths: ['../outside.c'], verbose: true })).toMatchObject({ filesAdded: 1, complete: true });
    expectScans('git', 1);
    expect(detail()).toBe('[sync] context-files source=reconcile files=3 reuses=2 extraScans=0');
  });

  it('does not add a scan when scoped framework and macro contexts are already warm', async () => {
    addMacroConsumer();
    await cg.sync({ paths: ['keep/new.c'], verbose: true });
    resetObservations();
    addMacroConsumer('keep/second.c', 'second_value');
    expect(await cg.sync({ paths: ['keep/second.c'], verbose: true })).toMatchObject({ filesAdded: 1, complete: true });
    expectScans('git', 0);
    expect(detail()).toBe('[sync] context-files source=unused files=0 reuses=0 extraScans=0');
    expect(cg.getNodesInFile('keep/second.c')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'second_value', kind: 'variable', startLine: 2 }),
    ]));
  });

  it('lazily obtains a fresh full list when only the macro context is cold', async () => {
    write('keep/first.js', 'function first() { return 1; }\n');
    await cg.sync({ paths: ['keep/first.js'] });
    // The first non-C sync warmed framework detection, but not macro context.
    write('keep/extra.h', '#define DECLARE_EXTRA(name) int name;\n');
    write('keep/new.c', 'DECLARE_EXTRA(extra_value)\n');
    const frameworks = vi.spyOn(context(), 'ensureDetectedFrameworks');
    const macros = vi.spyOn(context(), 'ensureGlobalMacroNames');
    resetObservations();
    expect(await cg.sync({ paths: ['keep/new.c'], verbose: true })).toMatchObject({ filesChecked: 1, filesAdded: 1 });
    expectScans('git', 1);
    expect(frameworks.mock.calls[0]?.[0]).toBeUndefined();
    expect(macros.mock.calls[0]?.[0]).toContain('keep/extra.h');
    expect(cg.getNodesInFile('keep/new.c')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'extra_value', kind: 'variable', startLine: 1 }),
    ]));
    expect(cg.getNodesInFile('keep/extra.h')).toHaveLength(0);
    expect(detail()).toBe('[sync] context-files source=scoped-scan files=5 reuses=0 extraScans=1');
  });

  it.each([false, true])('does not add context preparation to a deletion-only sync (scoped=%s)', async (scoped) => {
    fs.unlinkSync(path.join(dir, 'keep/a.c'));
    const frameworks = vi.spyOn(context(), 'ensureDetectedFrameworks');
    const macros = vi.spyOn(context(), 'ensureGlobalMacroNames');
    expect(await cg.sync({ paths: scoped ? ['keep/a.c'] : undefined, verbose: true })).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 1 });
    expectScans('git', scoped ? 0 : 1);
    expect(frameworks).not.toHaveBeenCalled();
    expect(macros).not.toHaveBeenCalled();
    expect(detail()).toBeUndefined();
  });

  it.each([false, true])('does not prepare global context for an unchanged sync (scoped=%s)', async (scoped) => {
    const frameworks = vi.spyOn(context(), 'ensureDetectedFrameworks');
    const macros = vi.spyOn(context(), 'ensureGlobalMacroNames');
    expect(await cg.sync({ paths: scoped ? ['keep/a.c'] : undefined, verbose: true })).toMatchObject({ filesAdded: 0, filesModified: 0 });
    expectScans('git', scoped ? 0 : 1);
    expect(frameworks).not.toHaveBeenCalled();
    expect(macros).not.toHaveBeenCalled();
    expect(detail()).toBeUndefined();
  });

  it('still detects frameworks and extracts routes for a non-C change without scanning macros', async () => {
    write('package.json', '{"dependencies":{"express":"*"}}');
    write('keep/server.js', 'const express = require("express");\nconst app = express();\napp.get("/health", (req, res) => res.send("ok"));\n');
    const frameworks = vi.spyOn(context(), 'ensureDetectedFrameworks');
    const macros = vi.spyOn(context(), 'ensureGlobalMacroNames');
    expect(await cg.sync({ verbose: true })).toMatchObject({ filesAdded: 1, complete: true });
    expectScans('git', 1);
    expect(frameworks.mock.results[0]?.value).toContain('express');
    expect(macros).not.toHaveBeenCalled();
    expect(cg.getNodesByKind('route').some((node) => node.name.includes('/health'))).toBe(true);
    expect(detail()).toBe('[sync] context-files source=reconcile files=3 reuses=1 extraScans=0');
  });

  it('does not retain a file list across sync invocations', async () => {
    addMacroConsumer();
    await cg.sync({ verbose: true });
    reopen();
    fs.unlinkSync(path.join(dir, 'keep/new.c'));
    addMacroConsumer('keep/second.c', 'second_value');
    const frameworks = vi.spyOn(context(), 'ensureDetectedFrameworks');
    resetObservations();
    expect(await cg.sync({ verbose: true })).toMatchObject({ filesAdded: 1, filesRemoved: 1 });
    expectScans('git', 1);
    expect(frameworks.mock.calls[0]?.[0]?.slice().sort()).toEqual(['keep/a.c', 'keep/defs.h', 'keep/second.c']);
    expect(cg.searchNodes('recovered_value')).toHaveLength(0);
    expect(cg.getNodesInFile('keep/second.c')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'second_value', kind: 'variable', startLine: 2 }),
    ]));
  });

  it('also reuses the list without verbose logging', async () => {
    addMacroConsumer();
    expect(await cg.sync()).toMatchObject({ filesAdded: 1, complete: true });
    expectScans('git', 1);
    expect(detail()).toBeUndefined();
  });
});
