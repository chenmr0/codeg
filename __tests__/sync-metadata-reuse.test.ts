import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';
import type { QueryBuilder } from '../src/db/queries';
import type { ExtractionOrchestrator } from '../src/extraction';
import type { ReplaceFileStore } from '../src/extraction/store-writer';
import { DECLARATION_MACRO_RECOVERY_SKIPPED_CODE } from '../src/extraction/diagnostics';
import * as rustScan from '../src/extraction/rust-scan';

const hooks = vi.hoisted(() => ({
  before: null as ((operation: 'stat' | 'exists' | 'read', filename: unknown) => void) | null,
  exists: null as ((filename: unknown) => boolean | undefined) | null,
}));
// Intercept the named exports used by reconciliation. Keep the default fs
// export real so fixture setup and assertions do not pollute the I/O counts.
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    statSync: (...args: any[]) => {
      hooks.before?.('stat', args[0]);
      return (actual.statSync as any)(...args);
    },
    existsSync: (...args: any[]) => {
      hooks.before?.('exists', args[0]);
      const result = hooks.exists?.(args[0]);
      return result ?? (actual.existsSync as any)(...args);
    },
    readFileSync: (...args: any[]) => {
      hooks.before?.('read', args[0]);
      return (actual.readFileSync as any)(...args);
    },
  };
});

describe('per-sync reconciliation metadata reuse', () => {
  let root: string;
  let cg: CodeGraph;
  let queries: QueryBuilder;
  const full = (file = 'api.c') => path.join(root, file);
  const source = 'int alpha(void) { return 1; }\n';
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root, stdio: 'pipe', windowsHide: true,
  });
  const write = (file: string, contents: string) => {
    fs.mkdirSync(path.dirname(full(file)), { recursive: true });
    fs.writeFileSync(full(file), contents);
  };
  const graph = () => {
    const db = (cg as any).db.getDb();
    return ['nodes', 'edges', 'unresolved_refs'].map(table =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  };
  const operations = (file = 'api.c') => {
    const calls: string[] = [];
    hooks.before = (operation, filename) => { if (filename === full(file)) calls.push(operation); };
    return calls;
  };
  const initialize = async () => {
    cg = CodeGraph.initSync(root);
    queries = (cg as any).queries;
    expect((await cg.indexAll()).complete).toBe(true);
    await cg.sync();
  };

  beforeEach(async () => {
    hooks.before = null;
    hooks.exists = null;
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '0');
    vi.stubEnv('CODEGRAPH_HYBRID_SCAN', '0');
    vi.stubEnv('CODEGRAPH_DEDUP_SYMLINKS', '1');
    vi.stubEnv('CODEGRAPH_GIT_REALPATH', 'legacy');
    vi.stubEnv('CODEGRAPH_RUST_GIT_IGNORE', '0');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Realpath the fixture root too: /var on macOS can itself be a symlink.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-metadata-reuse-')));
    git('init', '-q');
    write('api.c', source);
    git('add', 'api.c');
    await initialize();
  });

  afterEach(() => {
    hooks.before = null;
    hooks.exists = null;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cg?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])('uses exactly one fresh source stat per no-op invocation (verbose=%s)', async verbose => {
    const before = queries.getFileByPath('api.c');
    const beforeGraph = graph();
    const calls = operations();
    for (let i = 0; i < 2; i++) {
      calls.length = 0;
      expect(await cg.sync({ verbose })).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
      expect(calls).toEqual(['stat']);
      expect(queries.getFileByPath('api.c')).toEqual(before);
      expect(graph()).toEqual(beforeGraph);
    }
    // A prior no-op must never leave metadata cached for the next invocation.
    write('api.c', 'int changed_after_noop(void) { return 12345; }\n');
    expect(await cg.sync({ verbose })).toMatchObject({ filesModified: 1, filesRemoved: 0 });
    expect(cg.getNodesByName('changed_after_noop')).toHaveLength(1);
    expect(cg.getNodesByName('alpha')).toHaveLength(0);
  });

  it.each(['edit', 'replace', 'delete'] as const)('reconciles a real Git-tracked %s after a no-op', async change => {
    const before = queries.getFileByPath('api.c')!;
    if (change === 'delete') fs.unlinkSync(full());
    else if (change === 'replace') {
      const old = fs.statSync(full());
      write('replacement.tmp', source.replace('alpha', 'delta'));
      fs.utimesSync(full('replacement.tmp'), old.atime, new Date(old.mtimeMs + 5000));
      fs.unlinkSync(full());
      fs.renameSync(full('replacement.tmp'), full());
    } else write('api.c', 'int alpha_edited(void) { return 12345; }\n');
    // Unstaged deletion/replacement does not change Git's tracked-path list.
    expect(git('ls-files').toString()).toBe('api.c\n');
    expect(await cg.sync()).toMatchObject({ filesAdded: 0,
      filesModified: change === 'delete' ? 0 : 1, filesRemoved: change === 'delete' ? 1 : 0 });
    expect(cg.getNodesByName('alpha')).toHaveLength(0);
    if (change === 'delete') expect(queries.getFileByPath('api.c')).toBeNull();
    else {
      expect(queries.getFileByPath('api.c')!.contentHash).not.toBe(before.contentHash);
      expect(cg.getNodesByName(change === 'replace' ? 'delta' : 'alpha_edited')).toHaveLength(1);
    }
    expect(await cg.sync()).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
  });

  it('retains the scoped existence filter and leaves out-of-scope files alone', async () => {
    write('outside.c', 'int outside(void) { return 1; }\n');
    git('add', 'outside.c');
    await cg.sync();
    const outside = queries.getFileByPath('outside.c');
    write('outside.c', 'int outside_changed(void) { return 12345; }\n');
    const calls = operations();
    expect(await cg.sync({ paths: ['api.c'] })).toMatchObject({ filesChecked: 1, filesModified: 0 });
    expect(calls).toEqual(['exists', 'stat']);
    expect(queries.getFileByPath('outside.c')).toEqual(outside);
    expect(cg.getNodesByName('outside_changed')).toHaveLength(0);
    fs.unlinkSync(full());
    expect(await cg.sync({ paths: ['api.c'] })).toMatchObject({ filesChecked: 1, filesRemoved: 1, filesModified: 0 });
    expect(queries.getFileByPath('outside.c')).toEqual(outside);
    expect(await cg.sync()).toMatchObject({ filesModified: 1 });
  });

  it('removes newly ignored tracked files without statting or reading their source', async () => {
    const calls = operations();
    write('.codegraphignore', 'api.c\n');
    expect(await cg.sync()).toMatchObject({ filesChecked: 0, filesRemoved: 1, filesModified: 0 });
    expect(calls).toEqual([]);
    expect(fs.existsSync(full())).toBe(true);
    expect(queries.getFileByPath('api.c')).toBeNull();
    expect(cg.getNodesByName('alpha')).toHaveLength(0);
  });

  it.each([false, true])('defers a transient stat failure until the next invocation (verbose=%s)', async verbose => {
    const before = queries.getFileByPath('api.c');
    const beforeGraph = graph();
    write('api.c', 'int recovered(void) { return 12345; }\n');
    const calls: string[] = [];
    let statAttempts = 0;
    hooks.before = (operation, filename) => {
      if (filename !== full()) return;
      calls.push(operation);
      if (operation === 'stat' && ++statAttempts === 1) {
        throw Object.assign(new Error('transient stat failure'), { code: 'EACCES' });
      }
    };
    expect(await cg.sync({ verbose })).toMatchObject({ filesModified: 0, filesRemoved: 0 });
    expect(calls).toEqual(['stat']);
    expect(queries.getFileByPath('api.c')).toEqual(before);
    expect(graph()).toEqual(beforeGraph);
    calls.length = 0;
    expect(await cg.sync({ verbose })).toMatchObject({ filesModified: 1, filesRemoved: 0 });
    expect(calls.slice(0, 2)).toEqual(['stat', 'read']);
    expect(cg.getNodesByName('recovered')).toHaveLength(1);
  });

  it.each([false, true])('preserves the graph across repeated stat failures and retries next sync (verbose=%s)', async verbose => {
    const before = queries.getFileByPath('api.c');
    const beforeGraph = graph();
    write('api.c', 'int recovered_later(void) { return 12345; }\n');
    const calls: string[] = [];
    hooks.before = (operation, filename) => {
      if (filename !== full()) return;
      calls.push(operation);
      if (operation === 'stat') throw Object.assign(new Error('temporary stat failure'), { code: 'EACCES' });
    };
    for (let i = 0; i < 2; i++) {
      calls.length = 0;
      expect(await cg.sync({ verbose })).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
      expect(calls).toEqual(['stat']);
      expect(queries.getFileByPath('api.c')).toEqual(before);
      expect(graph()).toEqual(beforeGraph);
    }
    hooks.before = null;
    expect(await cg.sync({ verbose })).toMatchObject({ filesModified: 1, filesRemoved: 0 });
    expect(cg.getNodesByName('recovered_later')).toHaveLength(1);
    expect(cg.getNodesByName('alpha')).toHaveLength(0);
  });

  it.each(['EACCES', 'EPERM', 'EIO', undefined, null] as const)(
    'preserves an inaccessible file after stat error %s even when exists would return false', async code => {
      const before = queries.getFileByPath('api.c');
      const beforeGraph = graph();
      write('api.c', 'int accessible_again(void) { return 12345; }\n');
      const calls: string[] = [];
      let denied = false;
      hooks.before = (operation, filename) => {
        if (filename !== full()) return;
        calls.push(operation);
        if (operation === 'stat') {
          denied = true;
          if (code === null) throw null;
          throw Object.assign(new Error('temporary stat failure'), { code });
        }
      };
      hooks.exists = filename => filename === full() && denied ? false : undefined;
      for (const verbose of [false, true]) {
        denied = false; calls.length = 0;
        expect(await cg.sync({ verbose })).toMatchObject({ filesModified: 0, filesRemoved: 0 });
        expect(calls).toEqual(['stat']);
        expect(denied).toBe(true);
        expect(hooks.exists(full())).toBe(false);
        expect(fs.existsSync(full())).toBe(true);
        expect(queries.getFileByPath('api.c')).toEqual(before);
        expect(graph()).toEqual(beforeGraph);
      }
      hooks.before = null; hooks.exists = null;
      expect(await cg.sync()).toMatchObject({ filesModified: 1, filesRemoved: 0 });
      expect(cg.getNodesByName('accessible_again')).toHaveLength(1);
    },
  );

  it.each(['ENOENT', 'ENOTDIR'] as const)('still removes an actually missing tracked path (%s)', async code => {
    const relative = 'nested/provider.c';
    write(relative, 'int nested_provider(void) { return 1; }\n');
    git('add', relative);
    expect(await cg.sync()).toMatchObject({ filesAdded: 1 });
    if (code === 'ENOENT') fs.unlinkSync(full(relative));
    else {
      fs.rmSync(full('nested'), { recursive: true });
      write('nested', 'a file replaced the directory');
    }
    try { fs.statSync(full(relative)); throw new Error('expected stat failure'); }
    catch (error) {
      // Windows may report ENOENT rather than ENOTDIR for a replaced parent.
      expect(code === 'ENOENT' ? ['ENOENT'] : ['ENOENT', 'ENOTDIR'])
        .toContain((error as NodeJS.ErrnoException).code);
    }
    const calls = operations(relative);
    expect(await cg.sync({ verbose: true })).toMatchObject({ filesRemoved: 1, filesModified: 0 });
    expect(calls).toEqual(['stat', 'exists']);
    expect(queries.getFileByPath(relative)).toBeNull();
    expect(cg.getNodesByName('nested_provider')).toHaveLength(0);
    expect(cg.getNodesByName('alpha')).toHaveLength(1);
  });

  it('handles ENOTDIR explicitly even on platforms that report missing parents as ENOENT', async () => {
    fs.unlinkSync(full());
    const calls: string[] = [];
    hooks.before = (operation, filename) => {
      if (filename !== full()) return;
      calls.push(operation);
      if (operation === 'stat') throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    };
    expect(await cg.sync()).toMatchObject({ filesRemoved: 1, filesModified: 0 });
    expect(calls).toEqual(['stat', 'exists']);
    expect(queries.getFileByPath('api.c')).toBeNull();
  });

  it('retains a path that reappears after a missing-path stat error', async () => {
    const before = queries.getFileByPath('api.c');
    const beforeGraph = graph();
    const calls: string[] = [];
    hooks.before = (operation, filename) => {
      if (filename !== full()) return;
      calls.push(operation);
      if (operation === 'stat') throw Object.assign(new Error('temporarily missing'), { code: 'ENOENT' });
    };
    expect(await cg.sync()).toMatchObject({ filesRemoved: 0, filesModified: 0 });
    expect(calls).toEqual(['stat', 'exists']);
    expect(queries.getFileByPath('api.c')).toEqual(before);
    expect(graph()).toEqual(beforeGraph);
  });

  it.each(['edit', 'delete'] as const)('detects a concurrent %s during the removal-loop yield in the same sync', async change => {
    const template = queries.getFileByPath('api.c')!;
    // Reach the removal loop's 1000-file cooperative yield without parsing a
    // thousand fixtures. These matching file records are ordinary no-op rows.
    for (let i = 0; i < 999; i++) {
      const filename = `z-${i}.c`;
      write(filename, source);
      const stat = fs.statSync(full(filename));
      queries.upsertFile({ ...template, path: filename, size: stat.size,
        modifiedAt: stat.mtimeMs, nodeCount: 0 });
    }
    let changedDuringYield = false;
    let statBeforeYield = false;
    const getAllFiles = queries.getAllFiles.bind(queries);
    vi.spyOn(queries, 'getAllFiles').mockImplementationOnce(() => {
      const tracked = getAllFiles();
      expect(tracked).toHaveLength(1000);
      expect(tracked[0]!.path).toBe('api.c');
      // Enumeration has finished. This callback cannot run until the removal
      // loop yields, after an eager presence-stat cache would have read api.c.
      setImmediate(() => {
        if (change === 'delete') fs.unlinkSync(full());
        else write('api.c', 'int changed_during_yield(void) { return 12345; }\n');
        changedDuringYield = true;
      });
      return tracked;
    });
    hooks.before = (operation, filename) => {
      if (operation === 'stat' && filename === full() && !changedDuringYield) statBeforeYield = true;
    };
    expect(await cg.sync()).toMatchObject({ filesAdded: 0,
      filesModified: change === 'edit' ? 1 : 0, filesRemoved: change === 'delete' ? 1 : 0 });
    expect(changedDuringYield).toBe(true);
    expect(statBeforeYield).toBe(false);
    expect(cg.getNodesByName('alpha')).toHaveLength(0);
    if (change === 'edit') expect(cg.getNodesByName('changed_during_yield')).toHaveLength(1);
    else expect(queries.getFileByPath('api.c')).toBeNull();
    expect(await cg.sync()).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
  });

  it.each(['inline', 'replacement'] as const)('rebinds an unchanged caller after a late Git-listed provider deletion (%s store)', async store => {
    const provider = 'int relocated_api(void) { return 7; }\n';
    write('z-provider.c', provider);
    write('caller.c', 'int invoke(void) { return relocated_api(); }\n');
    git('add', 'z-provider.c', 'caller.c');
    await cg.sync();
    const db = (cg as any).db.getDb();
    const calls = () => db.prepare(`SELECT t.name, t.file_path FROM edges e
      JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
      WHERE s.name='invoke' AND e.kind='calls' ORDER BY t.file_path`).all();
    expect(calls()).toEqual([{ name: 'relocated_api', file_path: 'z-provider.c' }]);
    const caller = queries.getFileByPath('caller.c');
    const removedViaReplacement: string[] = [];
    if (store === 'replacement') {
      // Exercise the asynchronous replacement callback with the same real
      // deletion/edge-resurrection entry point used by the store worker.
      const orchestrator = (cg as unknown as { orchestrator: ExtractionOrchestrator }).orchestrator;
      const originalSync = orchestrator.sync.bind(orchestrator);
      const replaceFileStore: ReplaceFileStore = async request => {
        expect(request).toEqual({ filePath: 'z-provider.c', remove: true });
        await new Promise<void>(resolve => setImmediate(resolve));
        const result = orchestrator.storeParsedReplacement(request);
        expect(result.resurrectedSourceFiles).toContain('caller.c');
        removedViaReplacement.push(request.filePath);
        return result;
      };
      vi.spyOn(queries, 'hasManyIncomingEdges').mockImplementation(file => file === 'z-provider.c');
      vi.spyOn(orchestrator, 'sync').mockImplementation((progress, scope, verbose) =>
        originalSync(progress, scope, verbose, replaceFileStore));
    }
    // Track the replacement too, putting it before the missing provider in
    // Git's sorted list: addition is queued before deletion is discovered.
    write('a-provider.c', provider);
    git('add', 'a-provider.c');
    fs.unlinkSync(full('z-provider.c'));
    const events: string[] = [];
    hooks.before = (operation, filename) => {
      if (filename === full('a-provider.c') || filename === full('z-provider.c')) {
        events.push(`${operation}:${path.basename(String(filename))}`);
      }
    };
    expect(await cg.sync()).toMatchObject({ filesAdded: 1, filesRemoved: 1, filesModified: 0 });
    expect(events).toContain('read:a-provider.c');
    expect(events).toContain('exists:z-provider.c');
    expect(events.indexOf('read:a-provider.c')).toBeLessThan(events.indexOf('exists:z-provider.c'));
    expect(removedViaReplacement).toEqual(store === 'replacement' ? ['z-provider.c'] : []);
    expect(queries.getFileByPath('caller.c')).toEqual(caller);
    expect(queries.getFileByPath('z-provider.c')).toBeNull();
    expect(calls()).toEqual([{ name: 'relocated_api', file_path: 'a-provider.c' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare("SELECT * FROM unresolved_refs WHERE reference_name='relocated_api'").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM project_metadata WHERE key GLOB 'sync-retry:pending:*'").all()).toEqual([]);
    expect(await cg.sync()).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
    expect(calls()).toEqual([{ name: 'relocated_api', file_path: 'a-provider.c' }]);
  });

  it('keeps recovery-marked files on their existence-and-read path', async () => {
    const before = queries.getFileByPath('api.c')!;
    queries.upsertFile({ ...before, errors: [{ severity: 'warning',
      code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE, message: 'Retry full macro recovery.' }] });
    const calls = operations();
    expect(await cg.sync()).toMatchObject({ filesModified: 1, filesRemoved: 0 });
    expect(calls[0]).toBe('read');
    expect(calls).not.toContain('exists');
    expect(queries.getFileByPath('api.c')!.errors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE }),
    ]));
  });

  it.each(['EACCES', 'EPERM', 'EIO', undefined, null] as const)(
    'preserves recovery graph and marker when access is lost during a yield (%s)', async code => {
      const template = queries.getFileByPath('api.c')!;
      queries.upsertFile({ ...template, errors: [{ severity: 'warning',
        code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE, message: 'Keep recovery pending.' }] });
      for (let i = 0; i < 999; i++) {
        const filename = `z-recovery-${i}.c`;
        write(filename, source);
        const stat = fs.statSync(full(filename));
        queries.upsertFile({ ...template, path: filename, size: stat.size,
          modifiedAt: stat.mtimeMs, nodeCount: 0 });
      }
      const before = queries.getFileByPath('api.c');
      const beforeGraph = graph();
      const getAllFiles = queries.getAllFiles.bind(queries);
      let denied = false;
      const calls: string[] = [];
      hooks.exists = filename => filename === full() && denied ? false : undefined;
      hooks.before = (operation, filename) => {
        if (filename !== full()) return;
        calls.push(operation);
        if (operation === 'read' && denied) {
          if (code === null) throw null;
          throw Object.assign(new Error('recovery read denied'), { code });
        }
      };
      for (const verbose of [false, true]) {
        denied = false; calls.length = 0;
        vi.spyOn(queries, 'getAllFiles').mockImplementationOnce(() => {
          const tracked = getAllFiles();
          expect(tracked).toHaveLength(1000);
          setImmediate(() => { denied = true; });
          return tracked;
        });
        expect(await cg.sync({ verbose })).toMatchObject({ filesModified: 0, filesRemoved: 0 });
        expect(denied).toBe(true);
        expect(calls).toEqual(['read']);
        expect(hooks.exists(full())).toBe(false);
        expect(fs.existsSync(full())).toBe(true);
        expect(queries.getFileByPath('api.c')).toEqual(before);
        expect(graph()).toEqual(beforeGraph);
      }
      hooks.before = null; hooks.exists = null;
      expect(await cg.sync()).toMatchObject({ filesModified: 1, filesRemoved: 0 });
      expect(queries.getFileByPath('api.c')!.errors).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE }),
      ]));
      expect(cg.getNodesByName('alpha')).toHaveLength(1);
    },
  );

  it.each(['ENOENT', 'ENOTDIR'] as const)('removes a missing recovery file after read error %s', async code => {
    const before = queries.getFileByPath('api.c')!;
    queries.upsertFile({ ...before, errors: [{ severity: 'warning',
      code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE, message: 'Pending recovery.' }] });
    fs.unlinkSync(full());
    const calls: string[] = [];
    hooks.before = (operation, filename) => {
      if (filename !== full()) return;
      calls.push(operation);
      // ENOENT comes from a real read; explicitly inject ENOTDIR for portable coverage.
      if (operation === 'read' && code === 'ENOTDIR') {
        throw Object.assign(new Error('not a directory'), { code });
      }
    };
    expect(await cg.sync({ verbose: true })).toMatchObject({ filesRemoved: 1, filesModified: 0 });
    expect(calls).toEqual(['read', 'exists']);
    expect(queries.getFileByPath('api.c')).toBeNull();
    expect(cg.getNodesByName('alpha')).toHaveLength(0);
  });

  it('retains a recovery file that reappears after a missing-path read error', async () => {
    const before = queries.getFileByPath('api.c')!;
    queries.upsertFile({ ...before, errors: [{ severity: 'warning',
      code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE, message: 'Pending recovery.' }] });
    const pending = queries.getFileByPath('api.c');
    const beforeGraph = graph();
    hooks.before = (operation, filename) => {
      if (filename === full() && operation === 'read') {
        throw Object.assign(new Error('temporarily missing'), { code: 'ENOENT' });
      }
    };
    expect(await cg.sync()).toMatchObject({ filesRemoved: 0, filesModified: 0 });
    expect(queries.getFileByPath('api.c')).toEqual(pending);
    expect(graph()).toEqual(beforeGraph);
  });

  it('continues to use native snapshot metadata without an extra source stat', async () => {
    write('.codegraphignore', '/*\n!/api.c\n');
    const before = queries.getFileByPath('api.c');
    const stat = fs.statSync(full());
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '1');
    const scan = vi.spyOn(rustScan, 'runRustScan').mockReturnValue({
      paths: ['api.c'], stats: new Map([['api.c', { path: 'api.c', size: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs) }]]), directories: 1, entries: 1, metadata: 1, kernelMs: 0,
    });
    const calls = operations();
    expect(await cg.sync()).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(queries.getFileByPath('api.c')).toEqual(before);
  });

  it.runIf(process.platform !== 'win32')('refreshes canonical identity when a tracked file symlink is repointed', async () => {
    write('first/target.c', 'int first_target(void) { return 1; }\n');
    write('second/target.c', 'int second_target(void) { return 2; }\n');
    write('.codegraphignore', 'first/\nsecond/\n');
    fs.unlinkSync(full());
    fs.symlinkSync(full('first/target.c'), full());
    expect(await cg.sync()).toMatchObject({ filesRemoved: 1, filesAdded: 1 });
    expect(queries.getAllFiles().map(file => file.path)).toEqual(['first/target.c']);
    fs.unlinkSync(full());
    fs.symlinkSync(full('second/target.c'), full());
    expect(await cg.sync()).toMatchObject({ filesRemoved: 1, filesAdded: 1, filesModified: 0 });
    expect(queries.getAllFiles().map(file => file.path)).toEqual(['second/target.c']);
    expect(cg.getNodesByName('first_target')).toHaveLength(0);
    expect(cg.getNodesByName('second_target')).toHaveLength(1);
    expect(await cg.sync()).toMatchObject({ filesRemoved: 0, filesAdded: 0, filesModified: 0 });
  });

  it.runIf(process.platform !== 'win32')('refreshes canonical identity through a repointed ancestor symlink', async () => {
    write('alias/entry.c', 'int original_target(void) { return 0; }\n');
    git('add', 'alias/entry.c');
    await cg.sync();
    write('first/entry.c', 'int first_target(void) { return 1; }\n');
    write('second/entry.c', 'int second_target(void) { return 2; }\n');
    write('.codegraphignore', 'first/\nsecond/\n');
    fs.rmSync(full('alias'), { recursive: true });
    fs.symlinkSync(full('first'), full('alias'), 'dir');
    expect(await cg.sync()).toMatchObject({ filesRemoved: 1, filesAdded: 1 });
    expect(queries.getFileByPath('first/entry.c')).not.toBeNull();
    fs.unlinkSync(full('alias'));
    fs.symlinkSync(full('second'), full('alias'), 'dir');
    expect(await cg.sync()).toMatchObject({ filesRemoved: 1, filesAdded: 1, filesModified: 0 });
    expect(queries.getAllFiles().map(file => file.path).sort()).toEqual(['api.c', 'second/entry.c']);
    expect(cg.getNodesByName('first_target')).toHaveLength(0);
    expect(cg.getNodesByName('second_target')).toHaveLength(1);
    expect(await cg.sync()).toMatchObject({ filesRemoved: 0, filesAdded: 0, filesModified: 0 });
  });
});
