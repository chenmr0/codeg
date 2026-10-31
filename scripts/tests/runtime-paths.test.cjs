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
test('runtime directory and marker symlinks fail closed', t => {
  if (process.platform === 'win32') return t.skip('symlink creation needs privileges on Windows');
  const { project, data } = fixture(t);
  fs.symlinkSync(project, path.join(data, '.runtime'));
  assert.throws(() => runtime.ensureRuntimeDirectory(data), /Unsafe runtime/);
  assert.throws(() => runtime.getInternalFilePath(data, 'errors.log'), /Unsafe runtime/);
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
