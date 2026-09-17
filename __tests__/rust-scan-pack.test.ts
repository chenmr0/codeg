import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { nativeSourceHash, macroSourceHash } from '../scripts/rust-scan-release-lib.mjs';

const project = path.resolve(__dirname, '..');
let root: string;
function write(file: string, data: string | Buffer) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}
function run(...args: string[]) {
  const env = { ...process.env };
  delete env.CODEGRAPH_PACK_ALLOW_INCOMPLETE;
  return spawnSync(process.execPath, [path.join(root, 'scripts/check-rust-scan-artifacts.mjs'), ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 15_000, windowsHide: true });
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pack-check-'));
  write('package.json', JSON.stringify({ version: 'test-version' }));
  for (const script of ['check-rust-scan-artifacts.mjs', 'rust-scan-release-lib.mjs']) {
    write(`scripts/${script}`, fs.readFileSync(path.join(project, 'scripts', script)));
  }
  for (const kind of ['scan', 'macros']) {
    const module = kind === 'scan' ? 'rust-scan-artifact' : 'rust-macro-artifact';
    write(`dist/extraction/${module}.js`, ts.transpileModule(
      fs.readFileSync(path.join(project, 'src/extraction', `${module}.ts`), 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText);
    for (const file of ['Cargo.toml', 'Cargo.lock', 'src/main.rs']) write(`codegraph-${kind}/${file}`, 'fixture\n');
    for (const platform of ['win32', 'linux']) {
      const bytes = Buffer.alloc(256);
      if (platform === 'win32') {
        bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68);
      } else {
        bytes.write('7f454c46', 0, 'hex'); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(62, 18);
        bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56); bytes.writeUInt32LE(1, 64);
      }
      const executable = `codegraph-${kind}${platform === 'win32' ? '.exe' : ''}`;
      const folder = `dist/native-${kind}/${platform}-x64`;
      write(`${folder}/${executable}`, bytes);
      write(`${folder}/manifest.json`, JSON.stringify({ schema: 1, protocol: 1, platform, arch: 'x64',
        target: platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-musl',
        executable, packageVersion: 'test-version', profile: 'release',
        sourceHash: kind === 'scan' ? nativeSourceHash(root) : macroSourceHash(root),
        sha256: createHash('sha256').update(bytes).digest('hex') }));
    }
  }
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('cross-platform packaging before target-machine validation', () => {
  it('checks all four artifacts without target stamps, while standalone release checks stay strict', () => {
    const packed = run('--allow-unvalidated');
    expect(packed.error).toBeUndefined();
    expect(packed.status, packed.stderr).toBe(0);
    expect(packed.stdout.match(/Artifact check passed/g)).toHaveLength(4);
    const strict = run();
    expect(strict.status).not.toBe(0);
    expect(strict.stderr).toContain('binary-unverified');
  });
  it.each(['scan', 'macros'])('still rejects missing, replaced and stale-source %s artifacts', kind => {
    const binary = path.join(root, `dist/native-${kind}/linux-x64/codegraph-${kind}`);
    const bytes = fs.readFileSync(binary);
    fs.unlinkSync(binary);
    expect(run('--allow-unvalidated').stderr).toContain('binary-missing');
    fs.writeFileSync(binary, Buffer.concat([bytes, Buffer.from('changed')]));
    expect(run('--allow-unvalidated').stderr).toContain('binary-checksum');
    fs.writeFileSync(binary, bytes);
    fs.appendFileSync(path.join(root, `codegraph-${kind}/src/main.rs`), 'changed');
    expect(run('--allow-unvalidated').stderr).toMatch(/Stale .*source hash/);
  });
  it('supports explicit platform selection in either argument order', () => {
    expect(run('--require', 'linux-x64', '--allow-unvalidated').status).toBe(0);
    expect(run('--allow-unvalidated', '--require', 'win32-x64').status).toBe(0);
    expect(run('--require').status).not.toBe(0);
    expect(run('--allow-unvalidated', '--require', 'darwin-arm64').stderr).toContain('Unknown release target');
  });
});
