import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkRustScanArtifact, RUST_SCAN_TARGETS, RUST_SCAN_VALIDATION_SUITE, sha256 } from '../src/extraction/rust-scan-artifact';

let dir: string;
let binary: string;
let manifest: any;
const save = () => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-manifest-'));
  binary = path.join(dir, 'codegraph-scan');
  fs.writeFileSync(binary, 'test executable bytes');
  const hash = sha256(fs.readFileSync(binary));
  manifest = { schema: 1, protocol: 1, platform: 'linux', arch: 'x64',
    target: RUST_SCAN_TARGETS['linux-x64'].target, executable: 'codegraph-scan',
    packageVersion: 'test-version', profile: 'release', sourceHash: 'a'.repeat(64), sha256: hash,
    validation: { suite: RUST_SCAN_VALIDATION_SUITE, platform: 'linux', arch: 'x64', sha256: hash, passed: true } };
  save();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const check = () => checkRustScanArtifact(binary, 'linux', 'x64', 'test-version');
describe('native auto-selection release gate', () => {
  it('accepts a validated artifact whose bytes, platform and version match', () => expect(check()).toEqual(manifest));
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
      if (kind === 'old-suite') manifest.validation.suite = 'old';
      if (kind === 'changed-binary') manifest.validation.sha256 = 'b'.repeat(64);
      if (kind === 'failed') manifest.validation.passed = false;
      save(); expect(check).toThrow('binary-unverified');
    });
  it('detects binary replacement even when the old validation stamp remains', () => {
    fs.appendFileSync(binary, 'changed'); expect(check).toThrow('binary-checksum');
  });
  it('allows the target validator to inspect an unstamped binary without enabling auto', () => {
    delete manifest.validation; save();
    expect(check).toThrow('binary-unverified');
    expect(checkRustScanArtifact(binary, 'linux', 'x64', 'test-version', false)).toEqual(manifest);
  });
  it('falls back for missing or malformed metadata', () => {
    fs.unlinkSync(path.join(dir, 'manifest.json')); expect(check).toThrow('binary-unverified');
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{'); expect(check).toThrow('manifest-invalid');
    fs.unlinkSync(binary); expect(check).toThrow('binary-missing');
  });
});
