import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import childProcess from 'child_process';
import CodeGraph from '../src/index';
import { QueryBuilder } from '../src/db/queries';
import { scanDirectory, scanDirectoryAsync } from '../src/extraction';
import { ReconcileDiagnostics, ScanDiagnostics } from '../src/extraction/sync-diagnostics';
import { DECLARATION_MACRO_RECOVERY_SKIPPED_CODE } from '../src/extraction/diagnostics';
import { ResolutionDiagnostics } from '../src/resolution/diagnostics';

describe('verbose sync reconciliation diagnostics', () => {
  const dirs: string[] = [];
  let dir: string;
  let cg: CodeGraph;
  let queries: QueryBuilder;
  let messages: string[];
  const temp = () => {
    const created = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sync-diag-'));
    dirs.push(created);
    return created;
  };
  const git = (cwd: string, ...args: string[]) => childProcess.execFileSync('git', args, {
    cwd, stdio: 'pipe', windowsHide: true,
  });
  const fields = (kind: string) => {
    const line = messages.find((m) => m.startsWith(`[sync] ${kind} `));
    expect(line, `Missing ${kind}`).toBeDefined();
    return Object.fromEntries([...line!.matchAll(/(\w+)=([^\s]+)/g)].map((m) => [m[1], m[2]]));
  };
  const counts = () => Object.fromEntries(Object.entries(fields('reconcile-counts')).map(([k, v]) => [k, Number(v)]));
  const sync = async (options: Parameters<CodeGraph['sync']>[0] = { verbose: true }) => {
    messages.length = 0;
    return cg.sync(options);
  };

  beforeEach(async () => {
    dir = temp();
    git(dir, 'init', '-q');
    fs.writeFileSync(path.join(dir, 'a.c'), 'int alpha(void) { return 1; }\n');
    cg = CodeGraph.initSync(dir);
    queries = (cg as unknown as { queries: QueryBuilder }).queries;
    await cg.indexFiles(['a.c']);
    messages = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { messages.push(args.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cg?.destroy();
    for (const created of dirs.splice(0)) {
      if (!created.startsWith(path.join(os.tmpdir(), 'codegraph-sync-diag-'))) throw new Error('Unsafe temp cleanup');
      fs.rmSync(created, { recursive: true, force: true });
    }
  });

  it('reports an unchanged git scan and resets all counters on each sync', async () => {
    const before = queries.getFileByPath('a.c');
    for (let i = 0; i < 2; i++) {
      expect(await sync()).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
      expect(fields('scan-detail')).toMatchObject({ mode: 'git', fallbackReason: 'none', gitCommands: '3', sourceFiles: '1', walkDirectories: '0' });
      expect(counts()).toMatchObject({ currentFiles: 1, trackedFiles: 1, existsChecks: 1,
        statChecks: 1, statUnchanged: 1, hashReadAttempts: 0, hashReadFiles: 0, sameHashSkipped: 0 });
      for (const kind of ['reconcile-detail', 'reconcile-io']) {
        for (const [key, value] of Object.entries(fields(kind))) {
          if (key.endsWith('Ms')) expect(Number(value.replace(/ms$/, ''))).toBeGreaterThanOrEqual(0);
        }
      }
    }
    expect(queries.getFileByPath('a.c')).toEqual(before);
  });

  it('keeps verbose diagnostics off by default and leaves indexed data unchanged', async () => {
    const log = vi.spyOn(ReconcileDiagnostics.prototype, 'log');
    const format = vi.spyOn(ScanDiagnostics.prototype, 'format');
    const before = queries.getFileByPath('a.c');
    const result = await sync({});
    expect(result).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
    expect(log).not.toHaveBeenCalled();
    expect(format).not.toHaveBeenCalled();
    expect(messages.some((m) => /scan-detail|reconcile-(detail|io|counts)/.test(m))).toBe(false);
    expect(queries.getFileByPath('a.c')).toEqual(before);
  });

  it('observes repeated same-hash reads without refreshing metadata or reindexing', async () => {
    const filename = path.join(dir, 'a.c');
    const tracked = queries.getFileByPath('a.c');
    const stat = fs.statSync(filename);
    fs.utimesSync(filename, stat.atime, new Date(stat.mtimeMs + 5000));
    for (let i = 0; i < 2; i++) {
      expect(await sync()).toMatchObject({ filesModified: 0, nodesUpdated: 0 });
      expect(counts()).toMatchObject({ statChecks: 1, statUnchanged: 0, hashReadAttempts: 1,
        hashReadFiles: 1, sameHashSkipped: 1, recoveryRetryFiles: 0 });
    }
    expect(queries.getFileByPath('a.c')).toEqual(tracked);
  });

  it('reports reference load/warm/match/store only for a verbose changed-file pass', async () => {
    const format = vi.spyOn(ResolutionDiagnostics.prototype, 'format');
    fs.writeFileSync(path.join(dir, 'b.c'), 'int beta(void) { return alpha(); }\n');
    await sync({});
    expect(format).not.toHaveBeenCalled();
    expect(messages.some(m => m.includes('refs-detail'))).toBe(false);
    fs.writeFileSync(path.join(dir, 'c.c'), 'int delta(void) { return alpha(); }\n');
    await sync();
    expect(fields('refs-detail')).toMatchObject({ scope: 'changed', complete: 'true', failedPhase: 'none', files: '1', cache: 'cold', nameLookup: 'indexed', knownNames: 'not-loaded' });
    expect(Number(fields('refs-detail').refs)).toBeGreaterThan(0);
    for (const key of ['loadRefsMs', 'fileNamesLoadMs', 'fileNamesSetMs', 'symbolNamesLoadMs',
      'symbolNamesSetMs', 'normalizeMs', 'matchMs', 'edgeBuildMs', 'edgeInsertMs',
      'resolvedCleanupMs', 'failedCleanupMs', 'totalMs']) expect(fields('refs-detail')[key]).toMatch(/^\d+ms$/);
    format.mockClear(); await sync();
    expect(format).not.toHaveBeenCalled();
    expect(messages.some(m => m.includes('refs-detail'))).toBe(false);
  });

  it('counts real additions, changes and removals without changing their results', async () => {
    fs.writeFileSync(path.join(dir, 'a.c'), 'int alpha_updated(void) { return 12345; }\n');
    fs.writeFileSync(path.join(dir, 'b.c'), 'int beta(void) { return 2; }\n');
    expect(await sync()).toMatchObject({ filesAdded: 1, filesModified: 1, filesRemoved: 0 });
    expect(counts()).toMatchObject({ currentFiles: 2, trackedFiles: 1, statChecks: 1, statUnchanged: 0,
      hashReadFiles: 2, sameHashSkipped: 0, added: 1, modified: 1, removed: 0 });
    expect(cg.searchNodes('alpha_updated').length).toBeGreaterThan(0);
    expect(cg.searchNodes('beta').length).toBeGreaterThan(0);
    fs.unlinkSync(path.join(dir, 'b.c'));
    expect(await sync()).toMatchObject({ filesRemoved: 1 });
    expect(counts()).toMatchObject({ currentFiles: 1, trackedFiles: 2, existsChecks: 1,
      statUnchanged: 1, hashReadFiles: 0, removed: 1 });
    expect(cg.searchNodes('beta')).toHaveLength(0);
  });

  it('does not count unchanged recovery retries as ordinary same-hash skips', async () => {
    const tracked = queries.getFileByPath('a.c')!;
    queries.upsertFile({ ...tracked, errors: [{ severity: 'warning',
      code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE, message: 'Test recovery retry.' }] });
    expect(await sync()).toMatchObject({ filesModified: 1 });
    expect(counts()).toMatchObject({ recoveryRetryFiles: 1, statChecks: 0,
      hashReadFiles: 1, sameHashSkipped: 0, modified: 1 });
    await sync();
    expect(counts()).toMatchObject({ recoveryRetryFiles: 0, statUnchanged: 1, hashReadFiles: 0 });
  });

  it('reports scoped watcher checks without scanning files outside the scope', async () => {
    fs.writeFileSync(path.join(dir, 'outside.c'), 'int outside(void) { return 3; }\n');
    expect(await sync({ verbose: true, paths: ['a.c'] })).toMatchObject({ filesChecked: 1, filesAdded: 0 });
    expect(fields('reconcile-detail').scope).toBe('scoped');
    expect(fields('scan-detail')).toMatchObject({ mode: 'scoped', gitCommands: '0', sourceFiles: '1' });
    expect(counts()).toMatchObject({ existsChecks: 2, currentFiles: 1, trackedFiles: 1, statUnchanged: 1 });
    expect(cg.searchNodes('outside')).toHaveLength(0);
    expect(await sync({ verbose: true, paths: ['../outside.c'] })).toMatchObject({ filesAdded: 1 });
    expect(fields('reconcile-detail').scope).toBe('full-fallback');
    expect(fields('scan-detail').mode).toBe('git');
  });

  it.each(['stat', 'read'] as const)('preserves existing %s-error handling and reports the failed attempt', async (operation) => {
    const filename = path.join(dir, 'a.c');
    const stat = fs.statSync(filename);
    fs.utimesSync(filename, stat.atime, new Date(stat.mtimeMs + 5000));
    // Inject only after enumeration, so this tests reconciliation rather
    // than making the scanner fall back because of the artificial failure.
    let injected = false;
    const getAll = queries.getAllFiles.bind(queries);
    vi.spyOn(queries, 'getAllFiles').mockImplementation(() => {
      const tracked = getAll();
      if (!injected) {
        // Exercise actual filesystem races, without relying on mutable
        // bindings for Node's named fs exports. A directory passes exists
        // and stat but readFileSync rejects it on Windows/Linux.
        fs.unlinkSync(filename);
        if (operation === 'read') fs.mkdirSync(filename);
        injected = true;
      }
      return tracked;
    });
    expect(await sync()).toMatchObject({ filesModified: 0 });
    expect(counts()).toMatchObject(operation === 'stat'
      ? { statChecks: 1, statErrors: 1, hashReadAttempts: 0 }
      : { statErrors: 0, hashReadAttempts: 1, hashReadErrors: 1, hashReadFiles: 0 });
  });

  it.each(['sync', 'async'] as const)('keeps whitelist walk results identical with %s scanning diagnostics', async (variant) => {
    vi.stubEnv('CODEGRAPH_NO_HYBRID_SCAN', '1');
    fs.mkdirSync(path.join(dir, 'keep/nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'keep/nested/yes.c'), 'int yes;\n');
    fs.writeFileSync(path.join(dir, '.codegraphignore'), '/*\n!/keep/nested/\n');
    const scan = variant === 'sync' ? scanDirectory : scanDirectoryAsync;
    const baseline = await scan(dir);
    const diagnostics = new ScanDiagnostics();
    expect(await scan(dir, undefined, diagnostics)).toEqual(baseline);
    expect(baseline).toEqual(['keep/nested/yes.c']);
    expect(diagnostics).toMatchObject({ mode: 'walk', fallbackReason: 'codegraph-negation', gitCommands: 0, sourceFiles: 1 });
    expect(diagnostics.walkDirectories).toBeGreaterThanOrEqual(3);
    expect(diagnostics.walkMs).toBeGreaterThanOrEqual(diagnostics.ignoreBuildMs);
  });

  it('reports non-git fallback without extra git probes', async () => {
    const other = temp();
    fs.writeFileSync(path.join(other, 'plain.c'), 'int plain;\n');
    const diagnostics = new ScanDiagnostics();
    expect(await scanDirectoryAsync(other, undefined, diagnostics)).toEqual(['plain.c']);
    expect(diagnostics).toMatchObject({ mode: 'walk', fallbackReason: 'git-path-error',
      failureStage: 'rev-parse', gitCommands: 1, sourceFiles: 1 });
  });

  it('records the parent-ignore fallback and preserves the nested project scan', () => {
    fs.mkdirSync(path.join(dir, 'ignored'));
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
    fs.writeFileSync(path.join(dir, 'ignored/inside.c'), 'int inside;\n');
    const diagnostics = new ScanDiagnostics();
    expect(scanDirectory(path.join(dir, 'ignored'), undefined, diagnostics)).toEqual(['inside.c']);
    expect(diagnostics).toMatchObject({ mode: 'walk', fallbackReason: 'parent-gitignored', gitCommands: 2 });
  });

  it('includes existing nested-repository git commands in the scan totals', () => {
    const nested = path.join(dir, 'nested');
    fs.mkdirSync(nested);
    git(nested, 'init', '-q');
    fs.writeFileSync(path.join(nested, 'nested.c'), 'int nested;\n');
    const diagnostics = new ScanDiagnostics();
    expect(scanDirectory(dir, undefined, diagnostics).sort()).toEqual(['a.c', 'nested/nested.c']);
    expect(diagnostics).toMatchObject({ mode: 'git', gitCommands: 5, sourceFiles: 2, walkDirectories: 0 });
  });

  it('still detects deletion of a tracked path that git continues to enumerate', async () => {
    git(dir, 'add', 'a.c');
    fs.unlinkSync(path.join(dir, 'a.c'));
    expect(await sync()).toMatchObject({ filesRemoved: 1, filesModified: 0 });
    expect(counts()).toMatchObject({ currentFiles: 1, trackedFiles: 1, existsChecks: 1,
      statChecks: 1, statErrors: 1, hashReadFiles: 0, removed: 1 });
    expect(cg.searchNodes('alpha')).toHaveLength(0);
  });
});
