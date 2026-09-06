import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkRustMacroArtifact, macroSha256, RUST_MACRO_TARGETS,
  RUST_MACRO_VALIDATION_SUITE } from '../src/extraction/rust-macro-artifact';

let dir: string, binary: string, manifest: any;
const save = () => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-macro-manifest-'));
  binary = path.join(dir, 'codegraph-macros'); fs.writeFileSync(binary, 'macro executable bytes');
  const hash = macroSha256(fs.readFileSync(binary));
  manifest = { schema: 1, protocol: 1, platform: 'linux', arch: 'x64',
    target: RUST_MACRO_TARGETS['linux-x64'].target, executable: 'codegraph-macros',
    packageVersion: 'test-version', sourceHash: 'a'.repeat(64), sha256: hash, profile: 'release',
    validation: { suite: RUST_MACRO_VALIDATION_SUITE, platform: 'linux', arch: 'x64', sha256: hash, passed: true } };
  save();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const check = () => checkRustMacroArtifact(binary, 'linux', 'x64', 'test-version');

describe('macro helper automatic-selection artifact gate', () => {
  it('accepts only exact validated bytes and metadata', () => expect(check()).toEqual(manifest));
  it.each(['version', 'protocol', 'platform', 'target', 'profile', 'source-hash', 'executable'])(
    'rejects a mismatched manifest field: %s', field => {
      if (field === 'version') manifest.packageVersion = 'old';
      if (field === 'protocol') manifest.protocol = 2;
      if (field === 'platform') manifest.platform = 'win32';
      if (field === 'target') manifest.target = 'x86_64-unknown-linux-gnu';
      if (field === 'profile') manifest.profile = 'debug';
      if (field === 'source-hash') manifest.sourceHash = '';
      if (field === 'executable') manifest.executable = '../other';
      save(); expect(check).toThrow('manifest-mismatch');
    });
  it.each(['missing', 'wrong-os', 'wrong-arch', 'old-suite', 'changed-binary', 'failed'])(
    'does not auto-enable an unvalidated artifact: %s', kind => {
      if (kind === 'missing') delete manifest.validation;
      if (kind === 'wrong-os') manifest.validation.platform = 'win32';
      if (kind === 'wrong-arch') manifest.validation.arch = 'arm64';
      if (kind === 'old-suite') manifest.validation.suite = 'prototype';
      if (kind === 'changed-binary') manifest.validation.sha256 = 'b'.repeat(64);
      if (kind === 'failed') manifest.validation.passed = false;
      save(); expect(check).toThrow('binary-unverified');
    });
  it('detects replacement and lets the target validator inspect an unstamped helper', () => {
    delete manifest.validation; save();
    expect(check).toThrow('binary-unverified');
    expect(checkRustMacroArtifact(binary, 'linux', 'x64', 'test-version', false)).toEqual(manifest);
    fs.appendFileSync(binary, 'changed'); expect(check).toThrow('binary-checksum');
  });
  it('rejects missing or malformed metadata and unsupported targets', () => {
    fs.unlinkSync(path.join(dir, 'manifest.json')); expect(check).toThrow('binary-unverified');
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{'); expect(check).toThrow('manifest-invalid');
    expect(() => checkRustMacroArtifact(binary, 'darwin', 'arm64', 'test-version')).toThrow('unsupported-platform');
  });
});
