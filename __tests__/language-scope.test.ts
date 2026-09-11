import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import CodeGraph from '../src/index';
import { ExtractionOrchestrator, scanDirectory, scanDirectoryAsync } from '../src/extraction';
import { detectLanguage, initGrammars, isLanguageSupported, isSourceFile, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { getLanguageScope, getLanguageScopeKey, isLanguageEnabled, withLanguageScope } from '../src/extraction/language-scope';
import { decodeRustSnapshot, runRustScan, type RustScanRequest } from '../src/extraction/rust-scan';
import { RUST_SCAN_PROTOCOL } from '../src/extraction/rust-scan-artifact';
import { ScanDiagnostics } from '../src/extraction/sync-diagnostics';
import { ParseWorkerPool } from '../src/extraction/parse-pool';
import { collectHybridFiles } from '../src/extraction/hybrid-scan';
import { FileWatcher, __emitWatchEventForTests } from '../src/sync/watcher';
import { clearCanonicalCache } from '../src/utils';
import ignore from 'ignore';

vi.mock('../src/extraction/rust-scan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/extraction/rust-scan')>();
  return { ...actual, runRustScan: vi.fn(actual.runRustScan) };
});

const selectedFiles = ['src/a.c', 'src/b.cpp', 'src/c.hh', 'src/d.m', 'src/e.mm', 'src/f.py', 'src/g.lua'];
const excludedFiles = ['src/x.ts', 'src/x.rs', 'src/x.luau', 'src/x.inc', 'src/x.vue', 'src/x.xml', 'src/x.yaml', 'conf/routes', 'templates/page.json'];
let directory: string | undefined;
let graph: CodeGraph | undefined;
let watcher: FileWatcher | undefined;

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['c', 'cpp', 'typescript', 'python']);
});

beforeEach(() => {
  vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', undefined);
  vi.stubEnv('CODEGRAPH_RUST_SCAN', '0');
  vi.stubEnv('CODEGRAPH_HYBRID_SCAN', '0');
  vi.mocked(runRustScan).mockReset();
});

afterEach(() => {
  watcher?.stop(); watcher = undefined;
  graph?.close(); graph = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearCanonicalCache();
  if (directory) {
    const target = path.resolve(directory);
    expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(target).startsWith('cg-language-scope-')).toBe(true);
    fs.rmSync(target, { recursive: true, force: true });
    directory = undefined;
  }
});

function createDirectory(): string {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-language-scope-'));
  return directory;
}

function write(file: string, content = 'int value;\n'): void {
  const target = path.join(directory!, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function nativeResponse(files: string[]) {
  return {
    protocol: RUST_SCAN_PROTOCOL, ok: true, elapsedMs: 1,
    files: files.map(file => ({ path: file, size: 10, mtimeMs: 100 })),
    counters: { directories: 1, entries: files.length, metadata: files.length },
  };
}

describe('indexing language selection', () => {
  it.each([undefined, '', '0', 'true', 'yes', ' 1', '01'])('uses the default scope for %s', value => {
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', value);
    expect(getLanguageScope()).toBe('default');
    expect(getLanguageScopeKey()).toBe('default-v1');
    expect(isLanguageEnabled('cpp')).toBe(true);
    expect(isLanguageEnabled('typescript')).toBe(false);
    expect(isLanguageEnabled('unknown')).toBe(false);
  });

  it('selects C/C++, Objective-C/Objective-C++, Python and Lua by default', () => {
    expect(selectedFiles.filter(file => isSourceFile(file))).toEqual(selectedFiles);
    expect(excludedFiles.filter(file => isSourceFile(file))).toEqual([]);
    expect(detectLanguage('file.inc')).toBe('php');
    expect(detectLanguage('file.mm')).toBe('objc');
    expect(isSourceFile('file.inc')).toBe(false);
  });

  it('restores every original extension and special format only for the exact value 1', () => {
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    expect(getLanguageScopeKey()).toBe('all');
    expect([...selectedFiles, ...excludedFiles].every(file => isSourceFile(file))).toBe(true);
    expect(isSourceFile('notes.txt')).toBe(false);
    expect(isLanguageEnabled('unknown')).toBe(false);
  });

  it('keeps grammar capabilities and explicit extraction available outside the selected scope', () => {
    expect(detectLanguage('explicit.ts')).toBe('typescript');
    expect(isLanguageSupported('typescript')).toBe(true);
    expect(isSourceFile('explicit.ts')).toBe(false);
    const result = extractFromSource('explicit.ts', 'export function available() { return 1; }', 'typescript');
    expect(result.errors).toEqual([]);
    expect(result.nodes.some(node => node.name === 'available')).toBe(true);
  });

  it('captures once across awaits and nested calls, independently for overlapping operations', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withLanguageScope(async () => {
      expect(getLanguageScope()).toBe('default');
      await gate;
      return withLanguageScope(async () => {
        await Promise.resolve();
        return getLanguageScopeKey();
      });
    });
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    const second = withLanguageScope(async () => {
      await gate;
      return getLanguageScopeKey();
    });
    release();
    expect(await Promise.all([first, second])).toEqual(['default-v1', 'all']);
    expect(withLanguageScope(() => getLanguageScope())).toBe('all');
  });

  it.each(['default', 'all'] as const)('propagates the %s snapshot to initial and recycled parse workers', async scope => {
    createDirectory();
    write('worker.cjs', `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', message => {
        if (message.type === 'load-grammars') parentPort.postMessage({ type: 'grammars-loaded' });
        if (message.type === 'parse') parentPort.postMessage({ type: 'parse-result', id: message.id,
          result: { nodes: [], edges: [], unresolvedReferences: [], errors: [],
            durationMs: process.env.CODEGRAPH_ALL_LANGUAGES === '1' ? 1 : 0 } });
      });
    `);
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', scope === 'all' ? '1' : undefined);
    await withLanguageScope(async () => {
      vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', scope === 'all' ? undefined : '1');
      const pool = new ParseWorkerPool({ size: 1, languages: [], workerScriptPath: path.join(directory!, 'worker.cjs'), recycleInterval: 1 });
      try {
        for (let i = 0; i < 3; i++) {
          const result = await pool.requestParse({ filePath: 'file.cpp', content: '', language: 'cpp' });
          expect(result.durationMs).toBe(scope === 'all' ? 1 : 0);
        }
      } finally {
        await pool.destroy();
      }
    });
  });
});

describe('all file discovery paths respect language selection', () => {
  it.each(['walk', 'git', 'hybrid'] as const)('selects the same default/all files through %s', async mode => {
    createDirectory();
    for (const file of [...selectedFiles, ...excludedFiles]) write(file);
    if (mode !== 'walk') {
      execFileSync('git', ['init', '-q'], { cwd: directory, windowsHide: true, stdio: 'pipe' });
      execFileSync('git', ['add', '.'], { cwd: directory, windowsHide: true, stdio: 'pipe' });
    }
    if (mode === 'hybrid') {
      write('.codegraphignore', '!/extra/\n');
      vi.stubEnv('CODEGRAPH_HYBRID_SCAN', '1');
    }
    const diagnostics = new ScanDiagnostics();
    expect(scanDirectory(directory!, undefined, diagnostics).sort()).toEqual([...selectedFiles].sort());
    expect(diagnostics.mode).toBe(mode);
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    expect((await scanDirectoryAsync(directory!)).sort()).toEqual([...selectedFiles, ...excludedFiles].sort());
  });

  it('does not change selection when a scan progress callback changes the environment', async () => {
    createDirectory();
    write('a.cpp'); write('z.ts');
    const files = await scanDirectoryAsync(directory!, () => vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1'));
    expect(files).toEqual(['a.cpp']);
    expect(scanDirectory(directory!).sort()).toEqual(['a.cpp', 'z.ts']);
  });

  it('keeps all languages when a progress callback disables the opt-in mid-scan', async () => {
    createDirectory(); write('a.cpp'); write('z.ts');
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    const files = await scanDirectoryAsync(directory!, () => vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', undefined));
    expect(files).toEqual(['a.cpp', 'z.ts']);
    expect(scanDirectory(directory!)).toEqual(['a.cpp']);
  });

  it('filters supplemental hybrid paths even when a caller supplies an unfiltered list', () => {
    createDirectory(); write('keep.cpp'); write('skip.ts');
    const files = collectHybridFiles(directory!, [], {
      rootIgnore: ignore(), readPatterns: () => '', git: () => '', supplement: () => ['keep.cpp', 'skip.ts'],
    });
    expect([...files]).toEqual(['keep.cpp']);
  });

  it('passes only enabled extensions to native scanning and filters legacy special-case results', () => {
    createDirectory(); write('.codegraphignore', '!/src/\n');
    const requests: RustScanRequest[] = [];
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '1');
    vi.mocked(runRustScan).mockImplementation(request => {
      requests.push(request);
      return decodeRustSnapshot(nativeResponse(['src/a.cpp', 'conf/routes', 'templates/page.json']));
    });
    const diagnostics = new ScanDiagnostics();
    expect(scanDirectory(directory!, undefined, diagnostics)).toEqual(['src/a.cpp']);
    expect(diagnostics.nativeStatus).toBe('used');
    expect(requests[0]!.extensions).toContain('.cpp');
    expect(requests[0]!.extensions).toContain('.mm');
    expect(requests[0]!.extensions).not.toContain('.ts');
    expect(requests[0]!.extensions).not.toContain('.inc');
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    expect(scanDirectory(directory!)).toEqual(['src/a.cpp', 'conf/routes', 'templates/page.json']);
    expect(requests[1]!.extensions).toContain('.ts');
    expect(requests[1]!.extensions).toContain('.inc');
  });

  it('validates native duplicates and counters before discarding disabled rows', () => {
    expect(() => decodeRustSnapshot(nativeResponse(['skip.ts', 'skip.ts']))).toThrow();
    const malformed = nativeResponse(['skip.ts']);
    malformed.counters.metadata = 0;
    expect(() => decodeRustSnapshot(malformed)).toThrow();
  });

  it('filters watcher events using the same language selection', async () => {
    createDirectory();
    watcher = new FileWatcher(directory!, vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 }), { inertForTests: true, debounceMs: 60_000 });
    expect(watcher.start()).toBe(true);
    await watcher.waitUntilReady();
    __emitWatchEventForTests(directory!, 'skip.ts');
    __emitWatchEventForTests(directory!, 'keep.cpp');
    expect(watcher.getPendingFiles().map(file => file.path)).toEqual(['keep.cpp']);
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    __emitWatchEventForTests(directory!, 'skip.ts');
    expect(watcher.getPendingFiles().map(file => file.path).sort()).toEqual(['keep.cpp', 'skip.ts']);
  });

  it('does not retain a completed operation snapshot in later watcher events or sync callbacks', async () => {
    createDirectory();
    const sync = vi.fn(async () => {
      expect(withLanguageScope(() => getLanguageScope())).toBe('all');
      return { filesChanged: 1, durationMs: 1 };
    });
    await withLanguageScope(async () => {
      watcher = new FileWatcher(directory!, sync, { inertForTests: true, debounceMs: 60_000 });
      expect(watcher.start()).toBe(true);
      vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
      __emitWatchEventForTests(directory!, 'later.ts');
      expect(watcher.getPendingFiles().map(file => file.path)).toEqual(['later.ts']);
      await (watcher as unknown as { flush(): Promise<void> }).flush();
      expect(getLanguageScope()).toBe('default');
    });
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe('direct indexing boundaries', () => {
  function openOrchestrator(): ExtractionOrchestrator {
    graph = CodeGraph.initSync(directory!);
    return (graph as unknown as { orchestrator: ExtractionOrchestrator }).orchestrator;
  }

  it('does not allow indexFiles, pre-read indexing or scoped sync to bypass selection', async () => {
    createDirectory();
    write('keep.cpp', 'int keep() { return 1; }');
    write('skip.ts', 'export function skipped() { return 1; }');
    const orchestrator = openOrchestrator();
    const indexed = await orchestrator.indexFiles(['keep.cpp', 'skip.ts']);
    expect(indexed).toMatchObject({ filesIndexed: 1, filesSkipped: 1, filesErrored: 0 });
    const skipped = await orchestrator.indexFileWithContent('skip.ts', 'export function skipped() {}', fs.statSync(path.join(directory!, 'skip.ts')));
    expect(skipped).toMatchObject({ stored: false, nodes: [], errors: [] });
    const sync = await orchestrator.sync(undefined, ['skip.ts']);
    expect(sync).toMatchObject({ complete: true, filesAdded: 0, filesModified: 0 });
    expect(graph!.getNodesByName('skipped')).toEqual([]);
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    expect(await orchestrator.indexFiles(['skip.ts'])).toMatchObject({ filesIndexed: 1 });
    expect(graph!.getNodesByName('skipped')).toHaveLength(1);
  });

  it('force/reconcile replaces unchanged graph data and removes out-of-scope, ignored and deleted files', async () => {
    createDirectory();
    write('keep.cpp', 'int keep() { return 1; }');
    write('skip.ts', 'export function skipped() {}');
    write('ignored.py', 'def ignored():\n    pass\n');
    write('gone.cpp', 'int gone() { return 0; }');
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    const orchestrator = openOrchestrator();
    await orchestrator.indexFiles(['keep.cpp', 'skip.ts', 'ignored.py', 'gone.cpp']);
    const raw = (graph as any).db.db;
    raw.prepare("UPDATE nodes SET name = 'stale_keep' WHERE name = 'keep'").run();
    fs.unlinkSync(path.join(directory!, 'gone.cpp'));
    write('.codegraphignore', 'ignored.py\n');
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', undefined);
    orchestrator.resetLanguageScopeCaches();
    const result = await orchestrator.indexAll(undefined, undefined, undefined, undefined, undefined, { force: true, reconcile: true });
    expect(result).toMatchObject({ success: true, filesIndexed: 1, filesErrored: 0 });
    expect(raw.prepare('SELECT path FROM files ORDER BY path').all()).toEqual([{ path: 'keep.cpp' }]);
    expect(graph!.getNodesByName('keep')).toHaveLength(1);
    expect(graph!.getNodesByName('stale_keep')).toEqual([]);
  });
});
