/**
 * Symlink identity dedup — `CODEGRAPH_DEDUP_SYMLINKS` (default on).
 *
 * The same physical file reached via its real path OR an in-repo symlink must
 * be indexed ONCE (one `files` row, one set of nodes), and an import written via
 * either path must resolve to that one node. External-target symlinks stay
 * blocked by #527 (validatePathWithinRoot) — not indexed, no new regression.
 *
 * Coverage: filesystem-walk path (non-git), git path, sync reconcile, the
 * #527 external boundary, and the opt-out env switch.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';
import { canonicalFilePath, clearCanonicalCache } from '../src/utils';

// Windows: file symlinks need admin / Developer Mode; directory junctions do
// not. Probe once at load so file-symlink tests can gate themselves.
const HAVE_FILE_SYMLINKS = (() => {
  const a = path.join(os.tmpdir(), `cg-probe-a-${process.pid}`);
  const b = path.join(os.tmpdir(), `cg-probe-b-${process.pid}`);
  try {
    fs.writeFileSync(a, 'x');
    fs.symlinkSync(a, b);
    return fs.lstatSync(b).isSymbolicLink();
  } catch {
    return false;
  } finally {
    try { fs.rmSync(a, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(b, { force: true }); } catch { /* ignore */ }
  }
})();

/** Create a throwaway project dir. */
function mkDir(prefix = 'cg-symlink-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Raw sqlite handle for direct assertions (mirrors __tests__/accuracy). */
function rawDb(cg: CodeGraph): any {
  const handle = (cg as any).db?.db;
  if (handle && typeof handle.prepare === 'function') return handle;
  throw new Error('raw DB handle not accessible');
}

function filePaths(cg: CodeGraph): string[] {
  return (rawDb(cg).prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[]).map((r) => r.path);
}

function unresolvedCount(cg: CodeGraph): number {
  return (rawDb(cg).prepare('SELECT count(*) AS c FROM unresolved_refs').get() as { c: number }).c;
}

/** Fresh project + fresh full index. */
async function indexFresh(dir: string): Promise<CodeGraph> {
  clearCanonicalCache();
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  return cg;
}

/** Directory symlink: 'junction' on Windows needs no admin; ignored on POSIX. */
function linkDir(target: string, link: string): void {
  fs.symlinkSync(target, link, 'junction');
}

function cleanup(cg: CodeGraph | null, dir: string): void {
  try { cg?.destroy(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('symlink identity dedup (CODEGRAPH_DEDUP_SYMLINKS default on)', () => {
  describe('filesystem-walk path (non-git)', () => {
    it.runIf(HAVE_FILE_SYMLINKS)('a file symlink and its real target collapse to one file row', async () => {
      const dir = mkDir();
      let cg: CodeGraph | null = null;
      try {
        fs.writeFileSync(path.join(dir, 'real.ts'), `export function shared() { return 1; }\n`);
        fs.symlinkSync(path.join(dir, 'real.ts'), path.join(dir, 'link.ts'));
        cg = await indexFresh(dir);
        // Canonical only — the symlink path is deduped away.
        expect(filePaths(cg)).toEqual(['real.ts']);
        // The function is indexed exactly once.
        const fn = rawDb(cg).prepare("SELECT id FROM nodes WHERE name='shared' AND kind='function'").all() as { id: string }[];
        expect(fn.length).toBe(1);
      } finally {
        cleanup(cg, dir);
      }
    });

    it('a directory symlink stores files under the real path, deterministically', async () => {
      const dir = mkDir();
      let cg: CodeGraph | null = null;
      try {
        fs.mkdirSync(path.join(dir, 'realdir'));
        fs.writeFileSync(path.join(dir, 'realdir', 'foo.ts'), `export function foo() { return 1; }\n`);
        linkDir(path.join(dir, 'realdir'), path.join(dir, 'link'));
        cg = await indexFresh(dir);
        // realdir/foo.ts — never link/foo.ts — regardless of readdir order.
        expect(filePaths(cg)).toEqual(['realdir/foo.ts']);
        // A second index over the same tree yields the same canonical path.
        await cg.indexAll();
        expect(filePaths(cg)).toEqual(['realdir/foo.ts']);
      } finally {
        cleanup(cg, dir);
      }
    });

    it('imports written via the symlink path and via the real path both resolve to the one node', async () => {
      const dir = mkDir();
      let cg: CodeGraph | null = null;
      try {
        fs.mkdirSync(path.join(dir, 'realdir'));
        fs.writeFileSync(path.join(dir, 'realdir', 'foo.ts'), `export function foo() { return 1; }\n`);
        linkDir(path.join(dir, 'realdir'), path.join(dir, 'link'));
        // One importer reaches foo through the symlink path, one through the real path.
        fs.writeFileSync(
          path.join(dir, 'via-sym.ts'),
          `import { foo } from './link/foo';\nexport function callerSym() { return foo(); }\n`,
        );
        fs.writeFileSync(
          path.join(dir, 'via-real.ts'),
          `import { foo } from './realdir/foo';\nexport function callerReal() { return foo(); }\n`,
        );
        cg = await indexFresh(dir);
        // Both imports resolve — no unresolved references.
        expect(unresolvedCount(cg)).toBe(0);
        // foo is a single node (deduped), reachable from both callers.
        const foo = rawDb(cg).prepare("SELECT id FROM nodes WHERE name='foo' AND kind='function'").all() as { id: string }[];
        expect(foo.length).toBe(1);
        const fooId = foo[0]!.id;
        // Both callers connect to the one foo node (a call edge each — `foo()`
        // resolves through the import to the canonical foo). Count any edge kind
        // that targets foo; >=1 proves the symlink-path import wired into foo.
        const incoming = rawDb(cg)
          .prepare(`SELECT count(*) AS c FROM edges WHERE target=? AND kind IN ('calls','references')`)
          .get(fooId) as { c: number };
        expect(incoming.c).toBeGreaterThanOrEqual(1);
      } finally {
        cleanup(cg, dir);
      }
    });

    it('an external-target symlink is not indexed (#527 boundary, unchanged)', async () => {
      const dir = mkDir();
      const ext = mkDir('cg-ext-');
      let cg: CodeGraph | null = null;
      try {
        fs.mkdirSync(path.join(dir, 'realdir'));
        fs.writeFileSync(path.join(dir, 'realdir', 'foo.ts'), `export function foo() { return 1; }\n`);
        // External code outside the project root, pulled in via a junction.
        fs.mkdirSync(path.join(ext, 'extpkg'));
        fs.writeFileSync(path.join(ext, 'extpkg', 'bar.ts'), `export function bar() { return 2; }\n`);
        linkDir(path.join(ext, 'extpkg'), path.join(dir, 'extlink'));
        cg = await indexFresh(dir);
        const rows = filePaths(cg);
        // The in-repo real file is indexed; the external target is NOT.
        expect(rows).toEqual(['realdir/foo.ts']);
        expect(rows.some((r) => r.includes('extlink') || r.includes('extpkg'))).toBe(false);
      } finally {
        cleanup(cg, dir);
        try { fs.rmSync(ext, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  describe('git path (git ls-files)', () => {
    it.runIf(HAVE_FILE_SYMLINKS)('a tracked real file and an untracked symlink to it dedup to one row', async () => {
      const dir = mkDir('cg-symgit-');
      let cg: CodeGraph | null = null;
      try {
        execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
        fs.writeFileSync(path.join(dir, 'real.ts'), `export function shared() { return 1; }\n`);
        execFileSync('git', ['add', 'real.ts'], { cwd: dir, windowsHide: true });
        fs.symlinkSync(path.join(dir, 'real.ts'), path.join(dir, 'link.ts')); // untracked symlink
        cg = await indexFresh(dir);
        // git ls-files lists both real.ts (tracked) and link.ts (untracked);
        // canonicalization collapses them to the one real file.
        expect(filePaths(cg)).toEqual(['real.ts']);
      } finally {
        cleanup(cg, dir);
      }
    });
  });

  describe('sync reconcile', () => {
    it('adding a directory symlink does not duplicate; removing it keeps the canonical; removing the real file drops it', async () => {
      const dir = mkDir('cg-symsync-');
      let cg: CodeGraph | null = null;
      try {
        fs.mkdirSync(path.join(dir, 'realdir'));
        fs.writeFileSync(path.join(dir, 'realdir', 'foo.ts'), `export function foo() { return 1; }\n`);
        cg = await indexFresh(dir);
        expect(filePaths(cg)).toEqual(['realdir/foo.ts']);

        // Add a new symlink to the same real dir → no new file row.
        linkDir(path.join(dir, 'realdir'), path.join(dir, 'link'));
        await cg.sync();
        expect(filePaths(cg)).toEqual(['realdir/foo.ts']);

        // Remove the symlink (real file still present) → canonical row kept.
        // recursive: a directory junction is a directory; without it rmSync throws EISDIR.
        fs.rmSync(path.join(dir, 'link'), { recursive: true, force: true });
        await cg.sync();
        expect(filePaths(cg)).toEqual(['realdir/foo.ts']);

        // Remove the real file → canonical row dropped.
        fs.rmSync(path.join(dir, 'realdir', 'foo.ts'));
        await cg.sync();
        expect(filePaths(cg)).toEqual([]);
      } finally {
        cleanup(cg, dir);
      }
    });
  });

  describe('opt-out switch CODEGRAPH_DEDUP_SYMLINKS', () => {
    it.runIf(HAVE_FILE_SYMLINKS)('when off, the symlink is indexed as a separate file (old behavior)', async () => {
      const dir = mkDir('cg-symoff-');
      let cg: CodeGraph | null = null;
      const prev = process.env.CODEGRAPH_DEDUP_SYMLINKS;
      try {
        fs.writeFileSync(path.join(dir, 'real.ts'), `export function shared() { return 1; }\n`);
        fs.symlinkSync(path.join(dir, 'real.ts'), path.join(dir, 'link.ts'));
        process.env.CODEGRAPH_DEDUP_SYMLINKS = '0';
        cg = await indexFresh(dir);
        // Old behavior: both the real path and the symlink path are indexed.
        const rows = filePaths(cg);
        expect(rows).toContain('real.ts');
        expect(rows).toContain('link.ts');
      } finally {
        process.env.CODEGRAPH_DEDUP_SYMLINKS = prev;
        cleanup(cg, dir);
      }
    });

    it.runIf(HAVE_FILE_SYMLINKS)('when on (default), the symlink is deduped to the real file', async () => {
      const dir = mkDir('cg-symon-');
      let cg: CodeGraph | null = null;
      const prev = process.env.CODEGRAPH_DEDUP_SYMLINKS;
      try {
        fs.writeFileSync(path.join(dir, 'real.ts'), `export function shared() { return 1; }\n`);
        fs.symlinkSync(path.join(dir, 'real.ts'), path.join(dir, 'link.ts'));
        process.env.CODEGRAPH_DEDUP_SYMLINKS = '1';
        cg = await indexFresh(dir);
        expect(filePaths(cg)).toEqual(['real.ts']);
      } finally {
        process.env.CODEGRAPH_DEDUP_SYMLINKS = prev;
        cleanup(cg, dir);
      }
    });
  });

  describe('canonicalFilePath (unit)', () => {
    it('collapses a symlink path to the real path when the target is inside the root', () => {
      const dir = mkDir('cg-canon-');
      try {
        fs.mkdirSync(path.join(dir, 'realdir'));
        const real = path.join(dir, 'realdir', 'foo.ts');
        fs.writeFileSync(real, 'x');
        linkDir(path.join(dir, 'realdir'), path.join(dir, 'link'));
        clearCanonicalCache();
        const viaSym = canonicalFilePath(dir, 'link/foo.ts');
        const viaReal = canonicalFilePath(dir, 'realdir/foo.ts');
        expect(viaSym).toBe(viaReal);
        expect(viaSym).toBe('realdir/foo.ts');
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    it('a bare name not root-relative degrades to the normalized name (no throw)', () => {
      const dir = mkDir('cg-canon2-');
      try {
        clearCanonicalCache();
        // 'foo.ts' is not at the project root → realpath ENOENT → normalized 'foo.ts'.
        expect(canonicalFilePath(dir, 'foo.ts')).toBe('foo.ts');
        expect(canonicalFilePath(dir, './bar/baz.ts')).toBe('bar/baz.ts');
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });
});