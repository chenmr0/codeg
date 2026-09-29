import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { prepareNativeArtifacts } from '../scripts/prepare-native-lib.mjs';
import { nativeSourceHash, macroSourceHash } from '../scripts/rust-scan-release-lib.mjs';

const project = path.resolve(__dirname, '..');
let root: string;
const folder = (kind: string) => path.join(root, `dist/native-${kind}/linux-x64`);
function write(file: string, data: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}
function manifest(kind: string) {
  return JSON.parse(fs.readFileSync(path.join(folder(kind), 'manifest.json'), 'utf8'));
}
function stamp(kind: string) {
  const value = manifest(kind);
  value.validation = { suite: kind === 'scan' ? 'native-parity-v3' : 'macro-parity-v1',
    platform: 'linux', arch: 'x64', sha256: value.sha256, passed: true };
  write(path.join(folder(kind), 'manifest.json'), JSON.stringify(value));
}
// Synthetic stamps are confined to temporary orchestration fixtures. Real
// target validators are exercised separately on the installed package.
function successfulValidator(_command: string, args: string[]) {
  stamp(args[0].includes('validate-rust-scan') ? 'scan' : 'macros');
  return { status: 0 };
}
function prepare(run = vi.fn(successfulValidator), extra = {}) {
  const log = vi.fn(), warn = vi.fn();
  const results = prepareNativeArtifacts(root, { platform: 'linux', arch: 'x64', run, log, warn, ...extra });
  return { run, log, warn, results };
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-install-test-'));
  write(path.join(root, 'package.json'), JSON.stringify({ version: 'install-test' }));
  for (const kind of ['scan', 'macros']) {
    const module = kind === 'scan' ? 'rust-scan-artifact' : 'rust-macro-artifact';
    write(path.join(root, `dist/extraction/${module}.js`), ts.transpileModule(
      fs.readFileSync(path.join(project, `src/extraction/${module}.ts`), 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText);
    for (const file of ['Cargo.toml', 'Cargo.lock', 'src/main.rs']) {
      write(path.join(root, `codegraph-${kind}/${file}`), 'fixture\n');
    }
    const bytes = Buffer.alloc(128);
    bytes.write('7f454c46', 0, 'hex'); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(62, 18);
    bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56);
    bytes.writeUInt32LE(1, 64);
    write(path.join(folder(kind), `codegraph-${kind}`), bytes);
    write(path.join(folder(kind), 'manifest.json'), JSON.stringify({ schema: 1, protocol: 1,
      platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-musl',
      executable: `codegraph-${kind}`, packageVersion: 'install-test', profile: 'release',
      sourceHash: kind === 'scan' ? nativeSourceHash(root) : macroSourceHash(root),
      sha256: createHash('sha256').update(bytes).digest('hex') }));
  }
});
afterEach(() => {
  expect(path.dirname(fs.realpathSync(root))).toBe(fs.realpathSync(os.tmpdir()));
  expect(path.basename(root)).toMatch(/^cg-native-install-test-/);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('native install preparation', () => {
  it('validates missing target stamps with bounded subprocesses and isolated project settings', () => {
    const env = { PATH: 'host-path', CODEGRAPH_DIR: '/business/index', CODEGRAPH_RUST_SCAN: '0',
      CODEGRAPH_RUST_MACROS_PATH: '/custom/binary', CODEGRAPH_ALL_LANGUAGES: '0' };
    const result = prepare(undefined, { env });
    expect(result.results).toEqual([{ kind: 'scan', ready: true }, { kind: 'macros', ready: true }]);
    expect(result.run).toHaveBeenCalledTimes(2);
    expect(result.run).toHaveBeenNthCalledWith(1, process.execPath,
      [path.join(root, 'scripts/validate-rust-scan.mjs')], expect.objectContaining({
        cwd: root, timeout: 60_000, killSignal: 'SIGKILL', windowsHide: true,
        env: { PATH: 'host-path', CODEGRAPH_ALL_LANGUAGES: '1' },
      }));
    expect(env.CODEGRAPH_ALL_LANGUAGES).toBe('0');
    expect(result.warn).not.toHaveBeenCalled();
  });
  it('skips validation when matching target stamps already exist', () => {
    stamp('scan'); stamp('macros');
    const result = prepare();
    expect(result.run).not.toHaveBeenCalled();
    expect(result.results.every((item: { ready: boolean }) => item.ready)).toBe(true);
  });
  it('revalidates a stamp from the wrong platform instead of trusting passed=true', () => {
    stamp('scan'); stamp('macros');
    const value = manifest('scan'); value.validation.platform = 'win32';
    write(path.join(folder('scan'), 'manifest.json'), JSON.stringify(value));
    const result = prepare();
    expect(result.run).toHaveBeenCalledTimes(1);
    expect(result.results[0].ready).toBe(true);
  });
  it.each(['checksum', 'source', 'format', 'version', 'missing'])('rejects %s mismatch before executing the helper', failure => {
    const binary = path.join(folder('scan'), 'codegraph-scan');
    if (failure === 'checksum') fs.appendFileSync(binary, 'changed');
    if (failure === 'source') fs.appendFileSync(path.join(root, 'codegraph-scan/src/main.rs'), 'changed');
    if (failure === 'missing') fs.unlinkSync(binary);
    if (failure === 'format' || failure === 'version') {
      const value = manifest('scan');
      if (failure === 'format') {
        fs.writeFileSync(binary, 'invalid ELF');
        value.sha256 = createHash('sha256').update('invalid ELF').digest('hex');
      } else value.packageVersion = 'old-version';
      write(path.join(folder('scan'), 'manifest.json'), JSON.stringify(value));
    }
    stamp('macros');
    const result = prepare();
    expect(result.run).not.toHaveBeenCalled();
    expect(result.results).toEqual([expect.objectContaining({ kind: 'scan', ready: false }), { kind: 'macros', ready: true }]);
    expect(result.warn).toHaveBeenCalledTimes(1);
  });
  it.each(['exit', 'timeout', 'no-stamp'])('falls back on %s while still validating the other component', failure => {
    const run = vi.fn((command: string, args: string[]) => {
      if (args[0].includes('validate-rust-macros')) return successfulValidator(command, args);
      if (failure === 'timeout') return { status: null, error: new Error('ETIMEDOUT') };
      return { status: failure === 'exit' ? 1 : 0 };
    });
    const result = prepare(run);
    expect(result.run).toHaveBeenCalledTimes(2);
    expect(result.results).toEqual([expect.objectContaining({ kind: 'scan', ready: false }), { kind: 'macros', ready: true }]);
    expect(manifest('scan').validation).toBeUndefined();
    expect(result.warn).toHaveBeenCalledTimes(1);
    expect(result.warn.mock.calls[0][0]).toContain('TypeScript fallback remains available');
  });
  it('does nothing on unsupported hosts', () => {
    for (const host of [{ platform: 'linux', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }]) {
      const result = prepare(undefined, host);
      expect(result.results).toEqual([]);
      expect(result.run).not.toHaveBeenCalled();
      expect(result.warn).not.toHaveBeenCalled();
    }
  });
});
