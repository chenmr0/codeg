/** Initial active-file installation must not expose an unopened/partial DB. */
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import CodeGraph from '../src/index';
import { DatabaseConnection } from '../src/db';
import { getCodeGraphDir } from '../src/directory';
import { PortableCoordinator } from '../src/sync/portable/protocol';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const graph of graphs.splice(0)) { await graph.whenIdle(); graph.close(); await graph.whenIdle(); }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-initial-staging-'));
  roots.push(root); return root;
}
function assertNoActive(root: string) {
  const dir = getCodeGraphDir(root);
  for (const name of ['codegraph.db', 'codegraph.db-wal', 'codegraph.db-shm', 'codegraph.db-journal']) {
    expect(fs.existsSync(path.join(dir, name)), `must not expose ${name}`).toBe(false);
  }
}

it.each(['sync', 'async'] as const)('%s init can retry after initialization throws before opening its staging database', async mode => {
  const root = fixture(); let attempted: string | undefined;
  const injected = vi.spyOn(DatabaseConnection, 'initialize').mockImplementation(file => {
    attempted = file; throw new Error('injected failure before database open');
  });
  if (mode === 'sync') expect(() => CodeGraph.initSync(root)).toThrow('injected failure before database open');
  else await expect(CodeGraph.init(root)).rejects.toThrow('injected failure before database open');
  expect(attempted).toBeDefined();
  expect(attempted).not.toBe(path.join(getCodeGraphDir(root), 'codegraph.db'));
  assertNoActive(root);
  expect(fs.existsSync(path.join(getCodeGraphDir(root), 'codegraph.lock'))).toBe(false);
  injected.mockRestore();
  const graph = mode === 'sync' ? CodeGraph.initSync(root) : await CodeGraph.init(root);
  graphs.push(graph);
  expect(graph.getStats().nodeCount).toBe(0);
  expect(fs.existsSync(graph.getDatabaseFilePath())).toBe(true);
});

// Use the same source tree in child processes: no pre-existing dist build can
// hide a regression. This test-local hook only transpiles repository TS files.
function sourceLoader(): string {
  const ts = require.resolve('typescript');
  return `const fs=require('node:fs');const ts=require(${JSON.stringify(ts)});require.extensions['.ts']=function(module,filename){const source=fs.readFileSync(filename,'utf8');const output=ts.transpileModule(source,{fileName:filename,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;module._compile(output,filename);};`;
}

it.skipIf(process.platform === 'win32')('SIGKILL before staging DB open leaves no active file; offline CLI unlock permits a clean retry', async () => {
  const root = fixture(), dataDir = getCodeGraphDir(root);
  const sourceRoot = path.resolve(__dirname, '../src');
  const marker = path.join(root, 'before-open.json');
  const script = `${sourceLoader()}
    const {DatabaseConnection}=require(${JSON.stringify(path.join(sourceRoot, 'db/index.ts'))});
    DatabaseConnection.initialize=function(file){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({file}));process.kill(process.pid,'SIGKILL');throw Error('SIGKILL did not terminate');};
    const {CodeGraph}=require(${JSON.stringify(path.join(sourceRoot, 'index.ts'))});
    CodeGraph.initSync(${JSON.stringify(root)});`;
  const child = spawnSync(process.execPath, ['--liftoff-only', '-e', script], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1' },
  });
  expect(child.signal, child.stderr).toBe('SIGKILL');
  expect(child.status).toBeNull();
  expect(JSON.parse(fs.readFileSync(marker, 'utf8')).file).not.toBe(path.join(dataDir, 'codegraph.db'));
  assertNoActive(root);
  const lock = path.join(dataDir, 'codegraph.lock');
  expect(fs.existsSync(lock)).toBe(true);
  // The child has terminated and this fixture has no other writers. Exercise
  // the supported maintenance command, never manually delete a stale lock.
  const loader = path.join(root, 'source-loader.cjs'); fs.writeFileSync(loader, sourceLoader());
  const unlock = spawnSync(process.execPath, ['--liftoff-only', '--require', loader,
    path.join(sourceRoot, 'bin/codegraph.ts'), 'unlock', root, '--offline'], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1', CODEGRAPH_NO_DAEMON: '1' },
  });
  expect(unlock.status, unlock.stdout + unlock.stderr).toBe(0);
  expect(fs.existsSync(lock), unlock.stdout + unlock.stderr).toBe(false);
  assertNoActive(root);
  const graph = CodeGraph.initSync(root); graphs.push(graph);
  expect(graph.getStats().nodeCount).toBe(0);
  expect(fs.existsSync(graph.getDatabaseFilePath())).toBe(true);
}, 60000);

for (const boundary of ['before-rename', 'after-rename'] as const) {
  it.skipIf(process.platform === 'win32')(`SIGKILL ${boundary} preserves a safe baseline and never adopts or overwrites abandoned staging`, async () => {
    const root = fixture(), dataDir = getCodeGraphDir(root);
    fs.writeFileSync(path.join(root, 'main.c'), 'int recovered_initial_symbol(void) { return 9; }\n');
    const sourceRoot = path.resolve(__dirname, '../src');
    const marker = path.join(root, 'rename-boundary.json');
    const active = path.join(dataDir, 'codegraph.db');
    const script = `${sourceLoader()}
      const rename=fs.renameSync;
      fs.renameSync=function(from,to){
        if(String(to)===${JSON.stringify(active)} && require('node:path').basename(String(from))==='baseline.db'){
          fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({from,to}));
          if(${JSON.stringify(boundary)}==='before-rename')process.kill(process.pid,'SIGKILL');
          const result=rename.apply(this,arguments);
          process.kill(process.pid,'SIGKILL');return result;
        }
        return rename.apply(this,arguments);
      };
      const {CodeGraph}=require(${JSON.stringify(path.join(sourceRoot, 'index.ts'))});
      CodeGraph.initSync(${JSON.stringify(root)});`;
    const child = spawnSync(process.execPath, ['--liftoff-only', '-e', script], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1' },
    });
    expect(child.signal, child.stderr).toBe('SIGKILL'); expect(child.status).toBeNull();
    const stage = JSON.parse(fs.readFileSync(marker, 'utf8')).from as string;
    expect(stage).not.toBe(active);
    expect(fs.existsSync(path.dirname(stage))).toBe(true);
    const { DatabaseSync } = require('node:sqlite');
    if (boundary === 'before-rename') {
      assertNoActive(root);
      // Poison only abandoned private staging. A retry must create its own
      // baseline rather than trusting this apparently valid old schema.
      const stale = new DatabaseSync(stage);
      try { stale.exec('CREATE TABLE abandoned_stage_sentinel(value TEXT); INSERT INTO abandoned_stage_sentinel VALUES(\'never adopt\')'); }
      finally { stale.close(); }
    } else {
      expect(fs.existsSync(active)).toBe(true);
      const db = new DatabaseSync(active, { readOnly: true });
      try {
        expect(db.prepare('PRAGMA quick_check').get().quick_check).toBe('ok');
        expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n).toBe(0);
        expect(db.prepare('SELECT COUNT(*) AS n FROM project_metadata').get().n).toBeGreaterThan(0);
      } finally { db.close(); }
      // Rename committed, but its old directory survived. An unrelated file
      // subsequently appearing there must not be treated as resumable state.
      fs.writeFileSync(stage, 'untrusted abandoned stage; do not overwrite or adopt');
    }
    const sentinel = path.join(path.dirname(stage), 'unknown-owner.txt');
    fs.writeFileSync(sentinel, 'preserve for offline inspection');
    const preserved = fs.readFileSync(stage);
    const lock = path.join(dataDir, 'codegraph.lock'); expect(fs.existsSync(lock)).toBe(true);
    const loader = path.join(dataDir, 'source-loader.cjs'); fs.writeFileSync(loader, sourceLoader());
    const unlock = spawnSync(process.execPath, ['--liftoff-only', '--require', loader,
      path.join(sourceRoot, 'bin/codegraph.ts'), 'unlock', root, '--offline'], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1', CODEGRAPH_NO_DAEMON: '1' },
    });
    expect(unlock.status, unlock.stdout + unlock.stderr).toBe(0);
    expect(fs.existsSync(lock), unlock.stdout + unlock.stderr).toBe(false);
    let graph: CodeGraph;
    if (boundary === 'before-rename') graph = CodeGraph.initSync(root);
    else {
      expect(() => CodeGraph.initSync(root)).toThrow(/already initialized/i);
      graph = CodeGraph.openSync(root);
    }
    graphs.push(graph);
    expect((await graph.indexAll()).success).toBe(true);
    expect(graph.searchNodes('recovered_initial_symbol').length).toBeGreaterThan(0);
    const db = new DatabaseSync(active, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA quick_check').get().quick_check).toBe('ok');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='abandoned_stage_sentinel'").get()).toBeUndefined();
    } finally { db.close(); }
    expect(fs.readFileSync(stage)).toEqual(preserved);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserve for offline inspection');
  }, 60000);
}

it.skipIf(process.platform === 'win32')('preserves the original runtime-fsync error after staging removal, with a valid active DB and released writer', () => {
  const root = fixture(), dataDir = getCodeGraphDir(root);
  const runtime = path.join(dataDir, '.runtime', 'portable');
  const sourceRoot = path.resolve(__dirname, '../src');
  const script = `${sourceLoader()}
    const assert=require('node:assert/strict');
    const originalRmdir=fs.rmdirSync, originalFsync=fs.fsyncSync;
    const runtime=${JSON.stringify(runtime)};
    let removed=false,injected=false;
    fs.rmdirSync=function(directory){const result=originalRmdir.apply(this,arguments);const path=require('node:path');if(path.dirname(String(directory))===runtime && path.basename(String(directory)).startsWith('initial-'))removed=true;return result;};
    const failure=new Error('injected runtime fsync after staging rmdir');
    fs.fsyncSync=function(fd){if(removed && !injected){const descriptor=fs.fstatSync(fd),expected=fs.statSync(runtime);if(descriptor.dev===expected.dev && descriptor.ino===expected.ino){injected=true;throw failure;}}return originalFsync.apply(this,arguments);};
    const {CodeGraph}=require(${JSON.stringify(path.join(sourceRoot, 'index.ts'))});
    let caught;try{CodeGraph.initSync(${JSON.stringify(root)});}catch(error){caught=error;}
    assert.equal(removed,true);assert.equal(injected,true);assert.equal(caught,failure);
    fs.rmdirSync=originalRmdir;fs.fsyncSync=originalFsync;
    const {PortableCoordinator}=require(${JSON.stringify(path.join(sourceRoot, 'sync/portable/protocol.ts'))});
    const coordinator=new PortableCoordinator(${JSON.stringify(dataDir)});
    const writer=coordinator.acquireWriter();writer.release();
    assert.equal(fs.existsSync(${JSON.stringify(path.join(dataDir, 'codegraph.lock'))}),false);
    process.stdout.write('FSYNC_FAILURE_SAFELY_RETAINED');`;
  const child = spawnSync(process.execPath, ['--liftoff-only', '-e', script], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1' },
  });
  expect(child.status, child.stdout + child.stderr).toBe(0);
  expect(child.stdout).toContain('FSYNC_FAILURE_SAFELY_RETAINED');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'codegraph.db'), { readOnly: true });
  try {
    expect(db.prepare('PRAGMA quick_check').get().quick_check).toBe('ok');
    expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n).toBe(0);
  } finally { db.close(); }
  const graph = CodeGraph.openSync(root); graphs.push(graph);
  expect(() => graph.clear()).not.toThrow();
  expect(graph.getStats().nodeCount).toBe(0);
}, 40000);

it('refuses installation and cleanup through a substituted staging-directory symlink', context => {
  const root = fixture(), dataDir = getCodeGraphDir(root);
  fs.mkdirSync(dataDir, { recursive: true });
  const coordinator = new PortableCoordinator(dataDir), writer = coordinator.acquireWriter();
  try {
    const stage = coordinator.reserveInitialActive(), directory = path.dirname(stage);
    const external = path.join(root, 'external-owner'); fs.mkdirSync(external);
    const externalFile = path.join(external, 'baseline.db');
    const bytes = Buffer.from('external owned file: must never be changed, adopted, or deleted');
    fs.writeFileSync(externalFile, bytes);
    fs.rmdirSync(directory);
    try { fs.symlinkSync(external, directory, 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip(); return;
      }
      throw error;
    }
    expect(() => coordinator.installInitialActive()).toThrow(/unsafe initial staging directory/i);
    expect(fs.readFileSync(externalFile)).toEqual(bytes);
    expect(() => coordinator.discardInitialStage()).toThrow(/unsafe initial staging directory/i);
    expect(fs.readFileSync(externalFile)).toEqual(bytes);
    expect(fs.lstatSync(directory).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(external)).toEqual(['baseline.db']);
    assertNoActive(root);
  } finally { writer.release(); }
});
