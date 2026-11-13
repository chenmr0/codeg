import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';
import { scanDirectory, scanDirectoryAsync } from '../src/extraction';
import { runAdaptiveReadWorker } from '../src/sync/rebuild-controller';
import { validateProjectPath, isAllowedSourceTarget } from '../src/utils';

let base: string, root: string, shared: string;
const prior = process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-allowed-')));
  root = path.join(base, 'project'); shared = path.join(base, 'shared');
  fs.mkdirSync(root); fs.mkdirSync(shared);
  fs.writeFileSync(path.join(root, 'local.c'), 'int local_fn(void) { return 1; }\n');
  fs.writeFileSync(path.join(shared, 'remote.c'), 'int remote_fn(void) { return 2; }\n');
  fs.symlinkSync(shared, path.join(root, 'linked'), 'junction');
  process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS = shared;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (prior === undefined) delete process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS;
  else process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS = prior;
  fs.rmSync(base, { recursive: true, force: true });
});

for (const tracked of [false, true]) {
  it(`discovers authorized directory links in a real Git repo (tracked=${tracked})`, async () => {
    git('init', '-q'); if (tracked) git('add', 'linked', 'local.c');
    expect(scanDirectory(root).sort()).toEqual(['linked/remote.c', 'local.c']);
    expect((await scanDirectoryAsync(root)).sort()).toEqual(['linked/remote.c', 'local.c']);
    const cg = CodeGraph.initSync(root);
    try {
      const result = await cg.indexAll();
      expect(result.complete).toBe(true);
      expect(result.filesIndexed).toBe(2);
      expect(cg.getNodesByKind('function').some(n => n.name === 'remote_fn')).toBe(true);
    } finally { cg.close(); }
  }, 60000);
}

it('does not delete an existing authorized link index after git init; sync sees later changes', async () => {
  const cg = CodeGraph.initSync(root);
  try {
    await cg.indexAll(); git('init', '-q'); git('add', 'linked', 'local.c');
    const result = await cg.sync();
    expect(result.complete).toBe(true); expect(result.filesRemoved).toBe(0);
    expect(cg.getNodesByKind('function').some(n => n.name === 'remote_fn')).toBe(true);
    fs.writeFileSync(path.join(shared, 'remote.c'), 'int updated_remote_fn(void) { return 333; }\n');
    const changed = await cg.sync();
    expect(changed.filesModified).toBe(1); expect(changed.filesRemoved).toBe(0);
    expect(cg.getNodesByKind('function').some(n => n.name === 'updated_remote_fn')).toBe(true);
    fs.writeFileSync(path.join(shared, 'added.c'), 'int added_remote_fn(void) { return 4; }\n');
    expect((await cg.sync()).filesAdded).toBe(1);
    expect(cg.getNodesByKind('function').some(n => n.name === 'added_remote_fn')).toBe(true);
    fs.unlinkSync(path.join(shared, 'remote.c'));
    expect((await cg.sync()).filesRemoved).toBe(1);
  } finally { cg.close(); }
}, 60000);

it('keeps default behavior and refuses unauthorized directory links and nested escapes', () => {
  git('init', '-q'); git('add', 'linked', 'local.c');
  delete process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS;
  expect(scanDirectory(root)).toEqual(['local.c']);
  process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS = shared;
  const other = path.join(base, 'other'); fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'secret.c'), 'int secret_fn(void) { return 9; }');
  fs.symlinkSync(other, path.join(shared, 'escape'), 'junction');
  fs.symlinkSync(other, path.join(root, 'unauthorized'), 'junction');
  expect(scanDirectory(root).sort()).toEqual(['linked/remote.c', 'local.c']);
});

it('respects ignore rules inside the external tree and for the logical alias', () => {
  git('init', '-q'); git('add', 'linked', 'local.c');
  fs.writeFileSync(path.join(shared, '.gitignore'), 'ignored.c\n');
  fs.writeFileSync(path.join(shared, 'ignored.c'), 'int ignored_fn;');
  expect(scanDirectory(root).sort()).toEqual(['linked/remote.c', 'local.c']);
  fs.writeFileSync(path.join(root, '.codegraphignore'), 'linked/\n');
  expect(scanDirectory(root)).toEqual(['local.c']);
});

it('deduplicates aliases and terminates directory link cycles', () => {
  git('init', '-q');
  fs.symlinkSync(shared, path.join(root, 'alias'), 'junction');
  fs.symlinkSync(shared, path.join(shared, 'cycle'), 'junction');
  const found = scanDirectory(root);
  expect(found.filter(f => f.endsWith('/remote.c'))).toHaveLength(1);
  expect(found).toHaveLength(2);
});

it('blocks Windows sensitive home directories case-insensitively (platform logic)', () => {
  vi.spyOn(require('os'), 'homedir').mockReturnValue(base);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  try {
  for (const name of ['.SSH', '.GnUpG', '.AWS', '.CONFIG']) {
    const dir = path.join(base, name); fs.mkdirSync(dir);
    expect(validateProjectPath(dir)).toMatch(/sensitive/);
    process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS = dir;
    expect(isAllowedSourceTarget(path.join(dir, 'key.c'))).toBe(false);
    fs.mkdirSync(path.join(dir, 'nested'));
    expect(validateProjectPath(path.join(dir, 'nested'))).toMatch(/sensitive/);
  }
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});


it('treats a directory alias with a source suffix as a directory, not a source file', () => {
  git('init', '-q');
  fs.renameSync(path.join(root, 'linked'), path.join(root, 'linked.c'));
  git('add', 'linked.c', 'local.c');
  expect(scanDirectory(root).sort()).toEqual(['linked.c/remote.c', 'local.c']);
});

it('honors nested parent ignore rules for a linked directory', () => {
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'parent'));
  fs.renameSync(path.join(root, 'linked'), path.join(root, 'parent/linked'));
  fs.writeFileSync(path.join(root, 'parent/.gitignore'), 'linked/\n');
  git('add', '-f', 'parent/linked', 'local.c');
  expect(scanDirectory(root)).toEqual(['local.c']);
});

it('does not lose external links when hybrid supplements are also enabled', () => {
  git('init', '-q'); git('add', 'linked', 'local.c');
  fs.mkdirSync(path.join(root, 'extra'));
  fs.writeFileSync(path.join(root, 'extra/add.c'), 'int extra_fn;');
  fs.writeFileSync(path.join(root, '.codegraphignore'), '!/extra/\n');
  vi.stubEnv('CODEGRAPH_HYBRID_SCAN', '1');
  expect(scanDirectory(root).sort()).toEqual(['extra/add.c', 'linked/remote.c', 'local.c']);
});

it('falls back to incremental evaluation but never authorizes full-hash publication for links', async () => {
  git('init', '-q'); git('add', 'linked', 'local.c');
  const cg = CodeGraph.initSync(root);
  try {
    await cg.indexAll();
    const job = { type: 'evaluate' as const, root, databasePath: path.join(root, '.codegraph-wx/codegraph.db'),
      portable: true, eligibility: {}, decisionOnly: true };
    expect(await runAdaptiveReadWorker(job, {})).toEqual({ decision: {
      strategy: 'incremental', reason: 'symlink-source-ineligible',
    } });
    await expect(runAdaptiveReadWorker({ ...job, fullHash: true }, {})).rejects.toThrow('Symlink source');
  } finally { cg.close(); }
}, 60000);


it('retains JS fallback coverage when a requested native scanner is unavailable', () => {
  git('init', '-q'); git('add', 'linked', 'local.c');
  fs.writeFileSync(path.join(root, '.codegraphignore'), '!/linked/\n');
  vi.stubEnv('CODEGRAPH_RUST_SCAN', '1');
  vi.stubEnv('CODEGRAPH_RUST_SCAN_PATH', path.join(base, 'missing-native-scanner'));
  expect(scanDirectory(root).sort()).toEqual(['linked/remote.c', 'local.c']);
});
