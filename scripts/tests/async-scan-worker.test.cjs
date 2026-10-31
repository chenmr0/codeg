const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { scanDirectory, scanDirectoryAsync } = require('../../dist/extraction');
const { scanOffThread, canScanOffThread } = require('../../dist/extraction/scan-off-thread');
const { ScanDiagnostics } = require('../../dist/extraction/sync-diagnostics');
const { withLanguageScope } = require('../../dist/extraction/language-scope');
function fixture(t, git = false) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'async-scan-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = { ...process.env };
  process.env.CODEGRAPH_ALL_LANGUAGES = '1'; process.env.CODEGRAPH_RUST_SCAN = 'off'; delete process.env.CODEGRAPH_HYBRID_SCAN;
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  if (git) execFileSync('git', ['init', '-q', root]);
  const write = (file, content = 'def sample():\n    return 1\n') => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); };
  write('z.py'); write('nested/a.py'); write('nested/b.ts', 'export const sample = 1;'); write('ignored/no.py'); write('.gitignore', 'ignored/\n');
  return { root, write };
}
for (const git of [false, true]) test(`emitted async scan preserves ${git ? 'Git' : 'filesystem walk'} order and progress`, async t => {
  const { root } = fixture(t, git); assert.equal(canScanOffThread(), true);
  const expected = scanDirectory(root), progress = [], actual = await scanDirectoryAsync(root, (count, file) => progress.push([count, file]));
  assert.deepEqual(actual, expected); assert.deepEqual(progress, expected.map((file, i) => [i + 1, file]));
  assert(actual.includes('z.py')); assert(actual.includes('nested/b.ts')); assert(!actual.some(file => file.startsWith('ignored/')));
});
test('codegraphignore negation and symlink policies match the authoritative scanner', async t => {
  const { root, write } = fixture(t, true); write('extra/keep.py'); write('extra/drop.py'); write('.codegraphignore', 'extra/*.py\n!extra/keep.py\n');
  fs.symlinkSync(path.join(root, 'z.py'), path.join(root, 'alias.py'), 'file');
  const expected = scanDirectory(root); assert.deepEqual(await scanDirectoryAsync(root), expected);
  assert(expected.includes('extra/keep.py')); assert(!expected.includes('extra/drop.py'));
});
test('async scan preserves opted-in hybrid scanning', async t => {
  const { root, write } = fixture(t, true); process.env.CODEGRAPH_HYBRID_SCAN = '1'; process.env.CODEGRAPH_NO_HYBRID_SCAN = '0';
  write('.codegraphignore', '!/ignored/\n'); const expected = scanDirectory(root), diagnostics = new ScanDiagnostics();
  const actual = await scanDirectoryAsync(root, undefined, diagnostics); assert.deepEqual(actual, expected);
  assert.equal(diagnostics.mode, 'hybrid'); assert(actual.includes('ignored/no.py'));
});
test('async scan propagates captured language scope rather than changed environment', async t => {
  const { root } = fixture(t); process.env.CODEGRAPH_ALL_LANGUAGES = '0';
  await withLanguageScope(async () => {
    process.env.CODEGRAPH_ALL_LANGUAGES = '1'; const expected = scanDirectory(root), actual = await scanDirectoryAsync(root);
    assert.deepEqual(actual, expected); assert(actual.includes('z.py')); assert(!actual.includes('nested/b.ts'));
  });
  assert((await scanDirectoryAsync(root)).includes('nested/b.ts'));
});
test('diagnostics keep their instance, methods and pre-existing counters; old capture is cleared', async t => {
  const { root } = fixture(t, true), diagnostics = new ScanDiagnostics(); diagnostics.gitCommands = 13; diagnostics.walkDirectories = 17;
  const reference = diagnostics, capture = { snapshot: { stale: true }, fallback: { reason: 'old' } };
  const actual = await scanDirectoryAsync(root, undefined, diagnostics, capture);
  assert.equal(diagnostics, reference); assert(diagnostics instanceof ScanDiagnostics); assert.equal(typeof diagnostics.format(), 'string');
  assert(diagnostics.gitCommands > 13); assert.equal(diagnostics.walkDirectories, 17); assert.equal(diagnostics.sourceFiles, actual.length);
  assert.equal(diagnostics.mode, 'git'); assert.equal(capture.snapshot, undefined); assert.equal(capture.fallback, undefined);
});
test('scan workers isolate parent execArgv and NODE_OPTIONS preloads', async t => {
  const { root, write } = fixture(t); write('bad-preload.cjs', 'throw new Error("scan-worker-must-not-load-parent-preload");');
  const before = [...process.execArgv], oldOptions = process.env.NODE_OPTIONS;
  try { const preload = path.join(root, 'bad-preload.cjs'); process.execArgv.push('--require', preload); process.env.NODE_OPTIONS = `--require=${preload}`;
    assert.deepEqual(await scanDirectoryAsync(root), scanDirectory(root));
  } finally { process.execArgv.splice(0, process.execArgv.length, ...before); if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions; }
});
test('onProgress exceptions propagate instead of producing an empty successful scan', async t => {
  const { root } = fixture(t); await assert.rejects(scanDirectoryAsync(root, () => { throw new Error('progress-failure'); }), /progress-failure/);
  assert((await scanDirectoryAsync(root)).length > 0);
});
test('worker launch/clone failure rejects rather than masquerading as an empty source set', async t => {
  const { root } = fixture(t); await assert.rejects(scanOffThread(root, { uncloneable() {} }), /clone|cloned/i);
});
for (const mode of ['empty-exit', 'throw']) test(`real worker ${mode} rejects rather than returning empty files`, t => {
  const { root, write } = fixture(t), target = path.join(root, 'failure-worker.cjs');
  write('failure-worker.cjs', mode === 'empty-exit' ? 'process.exit(0);' : 'throw new Error("scan-thread-failure");');
  const helper = path.resolve(__dirname, '../../dist/extraction/scan-off-thread.js');
  const code = `const assert=require('node:assert/strict');const workers=require('node:worker_threads'),Original=workers.Worker;
    workers.Worker=class extends Original{constructor(script,options){super(${JSON.stringify(target)},options);}};
    const {scanOffThread}=require(${JSON.stringify(helper)});
    (async()=>{await assert.rejects(scanOffThread(${JSON.stringify(root)}),${mode === 'empty-exit' ? '/Filesystem scan worker exited 0/' : '/scan-thread-failure/'});})().catch(error=>{console.error(error);process.exitCode=1;});`;
  execFileSync(process.execPath, ['--liftoff-only', '-e', code], { timeout: 10000, stdio: 'pipe' });
});
test('main-thread timer advances before worker scan returns', async t => {
  const { root, write } = fixture(t); for (let i = 0; i < 1200; i++) write(`many/${i}.py`);
  let fired = false; const timer = setTimeout(() => { fired = true; }, 0);
  try { const actual = await scanOffThread(root); assert.equal(fired, true); assert(actual.length >= 1200); } finally { clearTimeout(timer); }
});
