'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const runtime = require('../../dist/runtime-paths.js');
function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-runtime-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const data = path.join(project, '.codegraph-wx'); fs.mkdirSync(data);
  return { project, data };
}
function mark(data) {
  const dir = runtime.ensureRuntimeDirectory(data);
  fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify({version:1, layout:'fixed-path-v1', migrationId:randomUUID()}));
}
test('internal paths preserve legacy behavior and switch only with fixed marker', t => {
  const { data } = fixture(t);
  fs.writeFileSync(path.join(data, 'codegraph.db'), 'legacy');
  assert.equal(runtime.getInternalFilePath(data, 'daemon.pid'), path.join(data, 'daemon.pid'));
  runtime.ensureRuntimeDirectory(data);
  assert.equal(runtime.getInternalFilePath(data, 'daemon.pid'), path.join(data, 'daemon.pid'));
  mark(data);
  assert.equal(runtime.getInternalFilePath(data, 'daemon.pid'), path.join(data, '.runtime', 'daemon.pid'));
  assert.throws(() => runtime.getInternalFilePath(data, '../oops'));
});
test('offline peripheral migration preserves bytes and unknown user files', t => {
  const { data } = fixture(t);
  fs.writeFileSync(path.join(data, '.gitignore'), 'custom ignore bytes\n');
  fs.writeFileSync(path.join(data, 'errors.log'), 'diagnostic bytes');
  fs.writeFileSync(path.join(data, 'user.txt'), 'never delete me');
  runtime.migrateLegacyRuntimeArtifacts(data);
  assert.equal(fs.readFileSync(path.join(data, '.runtime', 'legacy-root.gitignore'), 'utf8'), 'custom ignore bytes\n');
  assert.equal(fs.readFileSync(path.join(data, '.runtime', 'errors.log'), 'utf8'), 'diagnostic bytes');
  assert.equal(fs.readFileSync(path.join(data, 'user.txt'), 'utf8'), 'never delete me');
  runtime.migrateLegacyRuntimeArtifacts(data); // restart after completed moves is harmless
});
test('migration preflights every destination before moving any source', t => {
  const { data } = fixture(t); runtime.ensureRuntimeDirectory(data);
  fs.writeFileSync(path.join(data, 'errors.log'), 'early');
  fs.writeFileSync(path.join(data, 'adaptive-sync.log'), 'late');
  fs.writeFileSync(path.join(data, '.runtime', 'adaptive-sync.log'), 'conflict');
  assert.throws(() => runtime.migrateLegacyRuntimeArtifacts(data), /conflict/);
  assert.equal(fs.readFileSync(path.join(data, 'errors.log'), 'utf8'), 'early');
  assert.equal(fs.readFileSync(path.join(data, '.runtime', 'adaptive-sync.log'), 'utf8'), 'conflict');
});
test('migration refuses live daemon, unknown PID, and symlink evidence', t => {
  const { data } = fixture(t), pid = path.join(data, 'daemon.pid');
  fs.writeFileSync(pid, JSON.stringify({pid:process.pid}));
  assert.throws(() => runtime.migrateLegacyRuntimeArtifacts(data), /Stop legacy daemon/);
  fs.writeFileSync(pid, 'unknown');
  assert.throws(() => runtime.migrateLegacyRuntimeArtifacts(data), /Unrecognized/);
  fs.unlinkSync(pid);
  if (process.platform !== 'win32') {
    fs.symlinkSync('missing', path.join(data, 'errors.log'));
    assert.throws(() => runtime.migrateLegacyRuntimeArtifacts(data), /Unsafe legacy/);
    assert.equal(fs.lstatSync(path.join(data, 'errors.log')).isSymbolicLink(), true);
  }
});
test('fixed Git protection ignores root database without adding a root .gitignore', t => {
  const { project, data } = fixture(t);
  execFileSync('git', ['init', '-q', project]);
  fs.writeFileSync(path.join(project, '.gitignore'), '# user rules\n');
  runtime.ensureFixedPathGitProtection(data);
  runtime.ensureFixedPathGitProtection(data);
  fs.writeFileSync(path.join(data, 'codegraph.db'), 'db');
  assert.deepEqual(fs.readdirSync(data).sort(), ['.runtime', 'codegraph.db']);
  assert.equal(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), '# user rules\n');
  const ignored = execFileSync('git', ['-C', project, 'check-ignore', '.codegraph-wx/codegraph.db'], {encoding:'utf8'});
  assert.equal(ignored.trim(), '.codegraph-wx/codegraph.db');
  const exclude = fs.readFileSync(path.join(project, '.git/info/exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter(line => line === '/.codegraph-wx/').length, 1);
});
test('runtime directory junctions fail closed on every platform', t => {
  const { project, data } = fixture(t);
  fs.symlinkSync(project, path.join(data, '.runtime'), 'junction');
  assert.throws(() => runtime.ensureRuntimeDirectory(data), /Unsafe runtime/);
  assert.throws(() => runtime.getInternalFilePath(data, 'errors.log'), /Unsafe runtime/);
});
test('runtime marker file symlink fails closed (requires actual file-symlink capability)', t => {
  const { project, data } = fixture(t); runtime.ensureRuntimeDirectory(data);
  const target = path.join(project, 'foreign-layout.json');
  const bytes = JSON.stringify({version:1, layout:'fixed-path-v1', migrationId:randomUUID()});
  fs.writeFileSync(target, bytes);
  const marker = path.join(data, '.runtime', 'layout.json');
  try { fs.symlinkSync(target, marker, 'file'); }
  catch (error) {
    if (['EPERM','EACCES','ENOSYS'].includes(error.code) && process.env.STRICT_SYMLINK_TESTS !== '1') {
      return t.skip(`actual file symlink unavailable: ${error.code}; rerun with capability and STRICT_SYMLINK_TESTS=1`);
    }
    throw error;
  }
  assert(fs.lstatSync(marker).isSymbolicLink());
  assert.throws(() => runtime.getInternalFilePath(data, 'errors.log'), /Unsafe layout marker/);
  assert.equal(fs.readFileSync(target, 'utf8'), bytes);
});
test('Git exclusion respects a custom global excludesFile and linked worktree', t => {
  const { project } = fixture(t);
  execFileSync('git', ['init', '-q', project]);
  execFileSync('git', ['-C', project, '-c', 'user.name=Tests', '-c', 'user.email=tests@example.invalid', 'commit', '--allow-empty', '-qm', 'initial']);
  const custom = path.join(project, 'my-excludes'); fs.writeFileSync(custom, '# custom\n');
  execFileSync('git', ['-C', project, 'config', 'core.excludesFile', custom]);
  const worktree = project + '-worktree';
  t.after(() => { try { execFileSync('git', ['-C', project, 'worktree', 'remove', '--force', worktree], {stdio:'ignore'}); } catch { fs.rmSync(worktree,{recursive:true,force:true}); } });
  execFileSync('git', ['-C', project, 'worktree', 'add', '-q', '-b', 'test-worktree', worktree]);
  const data = path.join(worktree, '.codegraph-wx'); fs.mkdirSync(data);
  runtime.ensureFixedPathGitProtection(data);
  fs.writeFileSync(path.join(data, 'codegraph.db'), 'db');
  assert.equal(execFileSync('git', ['-C', worktree, 'check-ignore', '.codegraph-wx/codegraph.db'], {encoding:'utf8'}).trim(), '.codegraph-wx/codegraph.db');
  assert.equal(fs.readFileSync(custom, 'utf8'), '# custom\n');
});
test('Git exclusion refuses an existing lock without changing user rules', t => {
  const { project, data } = fixture(t); execFileSync('git', ['init', '-q', project]);
  const exclude = path.join(project, '.git/info/exclude'), before = fs.readFileSync(exclude, 'utf8');
  fs.writeFileSync(exclude + '.lock', 'foreign edit');
  assert.throws(() => runtime.ensureFixedPathGitProtection(data), /Cannot lock Git exclude/);
  assert.equal(fs.readFileSync(exclude, 'utf8'), before);
  assert.equal(fs.readFileSync(exclude + '.lock', 'utf8'), 'foreign edit');
});
test('Git exclusion reports unwritable metadata instead of pretending protection', t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('requires POSIX permissions and non-root user');
  const { project, data } = fixture(t); execFileSync('git', ['init', '-q', project]);
  const info = path.join(project, '.git/info');
  fs.chmodSync(info, 0o500);
  try { assert.throws(() => runtime.ensureFixedPathGitProtection(data), /Cannot lock Git exclude/); }
  finally { fs.chmodSync(info, 0o700); }
});
test('project negation overrides local excludes and must fail closed before migration', t => {
  const { project, data } = fixture(t); execFileSync('git', ['init', '-q', project]);
  const rules = '!/.codegraph-wx/\n'; fs.writeFileSync(path.join(project, '.gitignore'), rules);
  // Legacy child ignore must not hide the protection failure before it is moved.
  fs.writeFileSync(path.join(data, '.gitignore'), '*\n');
  fs.writeFileSync(path.join(data, 'codegraph.db'), 'precious');
  assert.throws(() => runtime.ensureFixedPathGitProtection(data), /Git protection is ineffective/);
  assert.equal(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), rules);
  assert.equal(fs.readFileSync(path.join(data, '.gitignore'), 'utf8'), '*\n');
  // Exact reproduction without the legacy child rule: database is visible.
  fs.unlinkSync(path.join(data, '.gitignore'));
  const status = execFileSync('git', ['-C', project, 'status', '--porcelain', '--untracked-files=all'], {encoding:'utf8'});
  assert.match(status, /\.codegraph-wx\/codegraph\.db/);
  assert.throws(() => runtime.ensureFixedPathGitProtection(data), /Git protection is ineffective/);
});
test('already staged database is rejected even if ignore rules match', t => {
  const { project, data } = fixture(t); execFileSync('git', ['init', '-q', project]);
  fs.writeFileSync(path.join(data, 'codegraph.db'), 'precious');
  execFileSync('git', ['-C', project, 'add', '.codegraph-wx/codegraph.db']);
  assert.throws(() => runtime.ensureFixedPathGitProtection(data), /already tracked or staged/);
  assert.equal(execFileSync('git', ['-C', project, 'ls-files', '.codegraph-wx/codegraph.db'], {encoding:'utf8'}).trim(), '.codegraph-wx/codegraph.db');
});
test('pre-marker fixed initialization diagnostics never select the data root', t => {
  const { data } = fixture(t), old = process.env.CODEGRAPH_FIXED_PATH;
  try {
    process.env.CODEGRAPH_FIXED_PATH = '1';
    assert.equal(runtime.usesRuntimeDiagnostics(data), true);
    assert.equal(runtime.getInternalFilePath(data, 'errors.log', runtime.usesRuntimeDiagnostics(data)), path.join(data, '.runtime', 'errors.log'));
    delete process.env.CODEGRAPH_FIXED_PATH;
    fs.mkdirSync(path.join(data, '.runtime', 'fixed-initialization'), {recursive:true});
    fs.writeFileSync(path.join(data, '.runtime', 'fixed-initialization', 'intent.json'), 'pending');
    assert.equal(runtime.usesRuntimeDiagnostics(data), true);
  } finally { if (old === undefined) delete process.env.CODEGRAPH_FIXED_PATH; else process.env.CODEGRAPH_FIXED_PATH = old; }
});
test('fresh initialization defaults to fixed while explicit zero preserves legacy', t => {
  const { data } = fixture(t), previous = process.env.CODEGRAPH_FIXED_PATH;
  try {
    delete process.env.CODEGRAPH_FIXED_PATH;
    assert.equal(runtime.shouldInitializeFixedPath(), true);
    assert.equal(runtime.usesRuntimeDiagnostics(data), true);
    process.env.CODEGRAPH_FIXED_PATH = '0';
    assert.equal(runtime.shouldInitializeFixedPath(), false);
    assert.equal(runtime.usesRuntimeDiagnostics(data), false);
    process.env.CODEGRAPH_FIXED_PATH = '1';
    assert.equal(runtime.shouldInitializeFixedPath(), true);
  } finally { if (previous === undefined) delete process.env.CODEGRAPH_FIXED_PATH; else process.env.CODEGRAPH_FIXED_PATH = previous; }
});
test('legacy diagnostics keep their root regardless of fresh-project default', t => {
  const { data } = fixture(t), previous = process.env.CODEGRAPH_FIXED_PATH;
  try {
    delete process.env.CODEGRAPH_FIXED_PATH;
    fs.writeFileSync(path.join(data, 'codegraph.db'), 'legacy');
    assert.equal(runtime.usesRuntimeDiagnostics(data), false);
    process.env.CODEGRAPH_FIXED_PATH = '1';
    assert.equal(runtime.usesRuntimeDiagnostics(data), false);
    fs.unlinkSync(path.join(data, 'codegraph.db'));
    fs.writeFileSync(path.join(data, 'CURRENT'), 'legacy-generation');
    assert.equal(runtime.usesRuntimeDiagnostics(data), false);
  } finally { if (previous === undefined) delete process.env.CODEGRAPH_FIXED_PATH; else process.env.CODEGRAPH_FIXED_PATH = previous; }
});
test('allocation-stage recovery diagnostics remain runtime even after opt-out', t => {
  const { data } = fixture(t), previous = process.env.CODEGRAPH_FIXED_PATH;
  try {
    process.env.CODEGRAPH_FIXED_PATH = '0';
    fs.mkdirSync(path.join(data, '.runtime', 'fixed-initialization'), {recursive:true});
    fs.writeFileSync(path.join(data, '.runtime', 'fixed-initialization', 'allocation.pending'), 'owned intent');
    assert.equal(runtime.usesRuntimeDiagnostics(data), true);
  } finally { if (previous === undefined) delete process.env.CODEGRAPH_FIXED_PATH; else process.env.CODEGRAPH_FIXED_PATH = previous; }
});

test('fresh daemon rendezvous uses runtime before initialization without an env flag', t => {
  const { project, data } = fixture(t), previous = process.env.CODEGRAPH_FIXED_PATH;
  try {
    delete process.env.CODEGRAPH_FIXED_PATH;
    const daemon = require('../../dist/mcp/daemon-paths.js');
    assert.equal(daemon.getDaemonPidPath(project), path.join(data, '.runtime', 'daemon.pid'));
    assert.equal(runtime.ensureInternalDirectory(data), path.join(data, '.runtime'));
    fs.writeFileSync(path.join(data, 'codegraph.db'), 'legacy');
    assert.equal(daemon.getDaemonPidPath(project), path.join(data, 'daemon.pid'));
  } finally { if (previous === undefined) delete process.env.CODEGRAPH_FIXED_PATH; else process.env.CODEGRAPH_FIXED_PATH = previous; }
});
test('SDK internal subdirectories honor fresh-project default before marker', t => {
  const { project, data } = fixture(t), previous = process.env.CODEGRAPH_FIXED_PATH;
  try {
    delete process.env.CODEGRAPH_FIXED_PATH;
    const directory = require('../../dist/directory.js');
    fs.rmdirSync(data); // The API historically creates a missing data root.
    assert.equal(directory.ensureSubdirectory(project, 'logs'), path.join(data, '.runtime', 'logs'));
    assert.deepEqual(fs.readdirSync(data), ['.runtime']);
  } finally { if (previous === undefined) delete process.env.CODEGRAPH_FIXED_PATH; else process.env.CODEGRAPH_FIXED_PATH = previous; }
});
function withoutGit(action) {
  const previousPath = process.env.PATH;
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('GIT_')));
  try {
    for (const name of Object.keys(gitEnv)) delete process.env[name];
    process.env.PATH = path.join(os.tmpdir(), 'codegraph-no-git-' + randomUUID());
    return action();
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    for (const name of Object.keys(process.env).filter(name => name.startsWith('GIT_'))) delete process.env[name];
    Object.assign(process.env, gitEnv);
  }
}
test('missing Git permits a proven non-repository only', t => {
  const { project, data } = fixture(t);
  // Some managed executors reserve an inert /tmp/.git directory. Simulate the
  // positively absent ancestor entries rather than weakening production's
  // conservative treatment of that repository-shaped evidence.
  const absent = new Set();
  for (let dir = fs.realpathSync(project);; dir = path.dirname(dir)) {
    absent.add(path.join(dir, '.git'));
    if (path.dirname(dir) === dir) break;
  }
  const realLstat = fs.lstatSync;
  fs.lstatSync = function(file, ...args) {
    if (absent.has(file)) throw Object.assign(new Error('no entry'), {code:'ENOENT'});
    return realLstat.call(fs, file, ...args);
  };
  try { withoutGit(() => runtime.ensureFixedPathGitProtection(data)); }
  finally { fs.lstatSync = realLstat; }
  assert.deepEqual(fs.readdirSync(data), ['.runtime']);
});
test('missing Git refuses configured repository environments and ancestor checkouts', t => {
  const { project, data } = fixture(t);
  withoutGit(() => {
    process.env.GIT_DIR = path.join(project, 'external-git');
    assert.throws(() => runtime.ensureFixedPathGitProtection(data), /Cannot establish/);
  });
  execFileSync('git', ['init', '-q', project]);
  withoutGit(() => assert.throws(() => runtime.ensureFixedPathGitProtection(data), /Cannot establish/));
});
test('missing Git recognizes linked worktree .git files and symlinked checkout ancestors', t => {
  const { project, data } = fixture(t);
  fs.writeFileSync(path.join(project, '.git'), 'gitdir: /missing/worktree-metadata\n');
  withoutGit(() => assert.throws(() => runtime.ensureFixedPathGitProtection(data), /Cannot establish/));
  if (process.platform !== 'win32') {
    const alias = project + '-alias'; fs.symlinkSync(project, alias);
    t.after(() => fs.unlinkSync(alias));
    withoutGit(() => assert.throws(() => runtime.ensureFixedPathGitProtection(path.join(alias, '.codegraph-wx')), /Cannot establish/));
  }
});
test('missing Git fails closed on unreadable ancestor discovery', t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('requires POSIX permissions and non-root user');
  const { project, data } = fixture(t);
  const realLstat = fs.lstatSync;
  // Deterministic I/O fault avoids denying access to the runtime path itself.
  fs.lstatSync = function(file, ...args) {
    if (file === path.join(project, '.git')) throw Object.assign(new Error('permission denied'), {code:'EACCES'});
    return realLstat.call(fs, file, ...args);
  };
  try { withoutGit(() => assert.throws(() => runtime.ensureFixedPathGitProtection(data), /Cannot establish/)); }
  finally { fs.lstatSync = realLstat; }
});
