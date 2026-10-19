import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { decodeRustSnapshot, RustScanFallback, formatScanFallback } from '../src/extraction/rust-scan';
import { ScanDiagnostics } from '../src/extraction/sync-diagnostics';
const detail = { reason: 'symlink', excludedAsFile: 'yes', excludedAsDirectory: 'no', targetType: 'directory' };
const rejection = (diagnostic?: unknown) => ({ protocol: 1, ok: false, reason: 'symlink', ...(diagnostic === undefined ? {} : { diagnostic }) });
function error(value: unknown): RustScanFallback {
  try { decodeRustSnapshot(value); throw Error('expected rejection'); }
  catch (e) { return e as RustScanFallback; }
}
afterEach(() => vi.unstubAllEnvs());
describe('fallback diagnostic protocol', () => {
  it('supports old helpers without inventing evidence', () => {
    const e = error(rejection());
    expect(e.message).toBe('symlink'); expect(e.diagnostic).toBeUndefined();
    expect(formatScanFallback({ reason: e.message })).toContain('helper 未提供详细诊断');
  });
  it('drops unsolicited paths by default, including from serialized diagnostics', () => {
    vi.stubEnv('CODEGRAPH_SCAN_DIAGNOSTIC_PATHS', '0');
    const e = error(rejection({ ...detail, path: 'secret/private-link' }));
    expect(e.diagnostic).toEqual(detail);
    const diag = new ScanDiagnostics(); diag.nativeDiagnostic = e.diagnostic;
    expect(diag.format()).toContain('nativeTargetType=directory');
    expect(JSON.stringify(e)).not.toContain('secret');
    expect(diag.format()).not.toContain('secret');
    expect(formatScanFallback({ reason: e.message, diagnostic: e.diagnostic })).not.toContain('secret');
  });
  it('quotes opted-in paths without terminal, newline or bidi injection', () => {
    vi.stubEnv('CODEGRAPH_SCAN_DIAGNOSTIC_PATHS', '1');
    const e = error(rejection({ ...detail, path: 'secret/a\n\u001b[31m\u202elink' }));
    const text = formatScanFallback({ reason: e.message, diagnostic: e.diagnostic });
    expect(text).toContain('path="secret/a\\n\\u001b[31m\\u202elink"');
    expect(text).not.toContain('\n'); expect(text).not.toContain('\u001b'); expect(text).not.toContain('\u202e');
    vi.stubEnv('CODEGRAPH_SCAN_DIAGNOSTIC_PATHS', '0');
    expect(formatScanFallback({ reason: e.message, diagnostic: e.diagnostic })).not.toContain('secret');
  });
  it.each([null, [], {}, { ...detail, reason: 'private-path' }, { ...detail, targetType: 'denied' },
    { ...detail, excludedAsFile: true }, { ...detail, path: '../secret' }, { ...detail, path: '/secret' },
    { ...detail, path: 10 }, { ...detail, extra: 'secret' }])('rejects malformed evidence %j', diagnostic => {
    expect(error(rejection(diagnostic)).message).toBe('invalid-diagnostic');
  });
  it('never displays arbitrary helper reason text as a path', () => {
    const e = error({ ...rejection(), reason: 'private-project-secret-link' });
    expect(e.message).toBe('scan-error');
    expect(formatScanFallback({ reason: 'private-project-secret-link' })).not.toContain('private-project');
  });
  it('rejects diagnostics on success or unrelated reasons', () => {
    expect(error({ ...rejection(detail), ok: true }).message).toBe('invalid-diagnostic');
    expect(error({ ...rejection(detail), reason: 'read-ignore' }).message).toBe('invalid-diagnostic');
  });
});
const binary = path.resolve(__dirname, '../dist/native-scan/linux-x64/codegraph-scan');
describe.skipIf(process.platform !== 'linux' || !fs.existsSync(binary))('real Rust fallback evidence', () => {
  let root = '';
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
  function scan(rules: string[], paths = false) {
    return JSON.parse(execFileSync(binary, [], { encoding: 'utf8',
      env: { ...process.env, CODEGRAPH_SCAN_DIAGNOSTIC_PATHS: paths ? '1' : '0' },
      input: JSON.stringify({ protocol: 1, root, rootRules: rules, extensions: ['.c'], dataDir: '.codegraph' }) }));
  }
  function setup() { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-diag-native-')); fs.mkdirSync(path.join(root, 'src')); }
  it('reports an ambiguous link with no default path', () => {
    setup(); fs.symlinkSync('src', path.join(root, 'alias'));
    const result = scan(['alias', '!alias/']);
    expect(result).toMatchObject({ ok: false, reason: 'symlink', diagnostic: {
      excludedAsFile: 'yes', excludedAsDirectory: 'no', targetType: 'directory' } });
    expect(result.diagnostic.path).toBeUndefined();
    expect(scan(['alias', '!alias/'], true).diagnostic.path).toBe('alias');
  });
  it.each(['file', 'directory', 'missing', 'cycle'])('skips a doubly excluded %s link without target metadata', kind => {
    setup(); fs.writeFileSync(path.join(root, 'src/file.c'), 'int x;');
    const target = { file: 'src/file.c', directory: 'src', missing: 'absent', cycle: 'alias' }[kind]!;
    fs.symlinkSync(target, path.join(root, 'alias'));
    const raw = scan(['/*', '!/src/'], true);
    expect(raw).toMatchObject({ ok: true, counters: { metadata: 1 } });
    expect(raw.files.map((file: { path: string }) => file.path)).toEqual(['src/file.c']);
    expect(raw.diagnostic).toBeUndefined();
  });
  it('distinguishes file and directory rule interpretation', () => {
    setup(); fs.symlinkSync('src', path.join(root, 'alias'));
    expect(scan(['alias/']).diagnostic).toMatchObject({ excludedAsFile: 'no', excludedAsDirectory: 'yes', targetType: 'directory' });
  });
  it.each([
    { rules: [], file: 'no', directory: 'no' },
    { rules: ['alias/'], file: 'no', directory: 'yes' },
    { rules: ['alias', '!alias/'], file: 'yes', directory: 'no' },
  ])('retains fallback for each target under $file/$directory exclusions', ({ rules, file, directory }) => {
    setup(); fs.writeFileSync(path.join(root, 'src/file.c'), 'int x;');
    for (const [target, targetType] of [
      ['src/file.c', 'file'], ['src', 'directory'], ['absent', 'missing'], ['alias', 'unknown'],
    ]) {
      fs.symlinkSync(target, path.join(root, 'alias'));
      const raw = scan(rules);
      expect(raw).toMatchObject({ ok: false, reason: 'symlink', diagnostic: {
        excludedAsFile: file, excludedAsDirectory: directory, targetType,
      } });
      expect(raw.files).toEqual([]);
      fs.unlinkSync(path.join(root, 'alias'));
    }
  });

  it('never reaches a link under an excluded ordinary parent', () => {
    setup(); fs.mkdirSync(path.join(root, 'blocked')); fs.symlinkSync('../src', path.join(root, 'blocked/link'));
    expect(scan(['blocked/'])).toMatchObject({ ok: true, files: [] });
    expect(scan(['blocked/']).diagnostic).toBeUndefined();
  });
  it('reports valid file, broken target, and loop as unknown rather than missing', () => {
    setup(); fs.writeFileSync(path.join(root, 'src/file.c'), 'int x;');
    fs.symlinkSync('src/file.c', path.join(root, 'alias'));
    expect(scan([]).diagnostic.targetType).toBe('file');
    fs.unlinkSync(path.join(root, 'alias')); fs.symlinkSync('absent', path.join(root, 'alias'));
    expect(scan([]).diagnostic.targetType).toBe('missing');
    fs.unlinkSync(path.join(root, 'alias')); fs.symlinkSync('alias', path.join(root, 'alias'));
    expect(scan([]).diagnostic.targetType).toBe('unknown');
  });
  it('reports permission failure as unknown, never missing', () => {
    setup(); fs.chmodSync(root, 0o755);
    fs.mkdirSync(path.join(root, 'locked'));
    fs.writeFileSync(path.join(root, 'locked/file.c'), 'int x;');
    fs.symlinkSync('locked/file.c', path.join(root, 'alias'));
    fs.chmodSync(path.join(root, 'locked'), 0o000);
    try {
      const raw = JSON.parse(execFileSync(binary, [], { encoding: 'utf8',
        ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
        input: JSON.stringify({ protocol: 1, root, rootRules: [], extensions: ['.c'], dataDir: '.codegraph' }) }));
      expect(raw).toMatchObject({ ok: false, reason: 'symlink', diagnostic: { targetType: 'unknown' } });
    } finally { fs.chmodSync(path.join(root, 'locked'), 0o755); }
  });
  it('uses unknown ignore evidence for unsupported Unicode link names', () => {
    setup(); fs.symlinkSync('src', path.join(root, '中文-link'));
    expect(scan([]).diagnostic).toMatchObject({ excludedAsFile: 'unknown', excludedAsDirectory: 'unknown', targetType: 'directory' });
  });
  it('does not invent link evidence if rule parsing failed first', () => {
    setup(); fs.symlinkSync('src', path.join(root, 'alias'));
    const raw = scan(['[!ab].c']);
    expect(raw).toMatchObject({ ok: false, reason: 'unsupported-rule' });
    expect(raw.diagnostic).toBeUndefined();
  });

});
